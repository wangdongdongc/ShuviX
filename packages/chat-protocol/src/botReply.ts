/**
 * `BotReply` —— 任务段的结构化回复契约（设计 §6.2）。
 *
 * **content 存的是它的 markdown 投影，而那是模型可见的唯一权威**：会话重开、滚动压缩、
 * 标题生成、复制、TTS 读到的都是 content。所以投影必须**穷尽每一个字段** —— 任何一个
 * 字段只进了结构、没进 markdown，就等于这条信息对模型不存在，而 UI 上它明明还在。
 * 这条纪律是本文件存在的理由，也是它值得全键覆盖断言的原因。
 *
 * 形状取自 §6.2：`headline` 必填（结论先行）+ 可选 `body`（markdown 散文 —— 解释类回复
 * 天然是散文，没有这个字段模型只能把段落硬塞进伪列点）+ `points` / `table` / `status` /
 * `followups`。渲染规则由 UI 执行：有 points/table/status 走卡片，仅 headline(+body)
 * 走普通气泡 —— 腔调统一，结构化仍是常态。
 */

/** 任务收尾状态。UI 渲染成 chip；投影成一行文本，好让模型重读历史时也看得见 */
export type BotReplyStatus = 'ok' | 'warn' | 'error'

export interface BotReplyTable {
  columns: string[]
  rows: string[][]
}

export interface BotReply {
  /** 一句话结论，必填且必须在最前 */
  headline: string
  /** markdown 散文 */
  body?: string
  /** 要点列表 */
  points?: string[]
  table?: BotReplyTable
  status?: BotReplyStatus
  /** 建议的后续问题 */
  followups?: string[]
}

/**
 * 标签刻意用英文 ASCII 且**不本地化**：content 是落进会话树的持久文本，跟着语言设置变
 * 会让历史消息在切换语言之后改写自己。它是数据标注，不是界面文案（同会话窗口里
 * `User:` / 发言人名的处置）。
 */
const STATUS_LABEL = 'Status'
const FOLLOWUPS_LABEL = 'Follow-ups'

/** GFM 表格单元格：`|` 会截断整行，换行会把一行拆成两行 —— 两者都必须转义 */
function cell(text: string): string {
  return String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

function tableToMarkdown(table: BotReplyTable): string {
  const cols = table.columns.map(cell)
  const head = `| ${cols.join(' | ')} |`
  const sep = `| ${cols.map(() => '---').join(' | ')} |`
  const body = table.rows.map(
    (row) =>
      // 行比表头短就补空格，长就截断：一行多出一格会让整张表在 GFM 里错位，
      // 而模型给出长短不一的行是常事
      `| ${cols.map((_, i) => cell(row?.[i] ?? '')).join(' | ')} |`
  )
  return [head, sep, ...body].join('\n')
}

/**
 * BotReply → markdown。**穷尽每个字段**（见文件头）。
 *
 * 段落之间一律空行相隔；空数组、空串、纯空白的字段整段消失 —— 一个只有标题没有内容的
 * 「要点」小节比没有它更糟。
 */
export function botReplyToMarkdown(reply: BotReply): string {
  const parts: string[] = []
  const headline = (reply.headline ?? '').trim()
  if (headline) parts.push(headline)

  const body = (reply.body ?? '').trim()
  if (body) parts.push(body)

  const points = (reply.points ?? []).map((p) => String(p ?? '').trim()).filter(Boolean)
  if (points.length) parts.push(points.map((p) => `- ${p}`).join('\n'))

  const table = reply.table
  if (table?.columns?.length) parts.push(tableToMarkdown(table))

  // status 放在正文之后：headline 本来就该把「出没出事」说清楚，这一行是给 UI chip 和
  // 重读历史的模型用的机器标签，挤在结论前面只会把结论推下去
  if (reply.status) parts.push(`${STATUS_LABEL}: ${reply.status}`)

  const followups = (reply.followups ?? []).map((f) => String(f ?? '').trim()).filter(Boolean)
  if (followups.length) {
    parts.push(`${FOLLOWUPS_LABEL}:\n${followups.map((f) => `- ${f}`).join('\n')}`)
  }

  return parts.join('\n\n')
}

/**
 * 跨 vm realm / 磁盘 JSON 的收窄。逐字段重建，未知键一律丢弃。
 *
 * `headline` 空 → null：它是唯一必填项，没有它这条回复没有可显示的结论，调用方应当
 * 走「未调 next 但有散文」那条降级，而不是落一条空壳。
 */
export function asBotReply(raw: unknown): BotReply | null {
  if (typeof raw !== 'object' || raw === null) return null
  const d = raw as Record<string, unknown>
  const headline = typeof d.headline === 'string' ? d.headline.trim() : ''
  if (!headline) return null

  const out: BotReply = { headline }
  if (typeof d.body === 'string' && d.body.trim()) out.body = d.body

  const points = strings(d.points)
  if (points.length) out.points = points

  const table = d.table
  if (typeof table === 'object' && table !== null) {
    const t = table as Record<string, unknown>
    const columns = strings(t.columns)
    if (columns.length) {
      const rows = Array.isArray(t.rows)
        ? t.rows.filter(Array.isArray).map((r) => (r as unknown[]).map((c) => String(c ?? '')))
        : []
      out.table = { columns, rows }
    }
  }

  if (d.status === 'ok' || d.status === 'warn' || d.status === 'error') out.status = d.status

  const followups = strings(d.followups)
  if (followups.length) out.followups = followups

  return out
}

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
}
