/**
 * 契约 md 的**写后处理** —— write / edit 落盘之后跑的一步：先校验、通过再补缺省字段。
 *
 * 为什么放在文件工具末尾而不是各解析器里：契约 md 是 agent 用普通 write/edit 写出来的，
 * 没有专用写入工具可挂钩子。落在这里就一条路：agent 写完立刻知道自己写废了没有
 * （不通过的原因随工具 result 回去，它当场就能修，而不是等下次会话发现记忆没生效），
 * 而缺省字段由宿主盖章 —— 让模型自己填这些字段，要么得往每会话必付的注入文案里加字，
 * 要么它根本填不出来（如溯源会话 id：模型的提示词变量表里就没有 sessionId）。
 *
 * **工具本身仍然算成功**：文件确实写进去了。校验只是回执，不是准入 —— 契约的准入判定
 * 归各自的扫描侧（非法文件被跳过），这里重复一次「拒绝写入」只会让 agent 卡在半截状态。
 *
 * 补字段刻意做成**行级 upsert**，不整体重序列化 frontmatter —— 注释、键序、未知键都得
 * 原样留着（同属性卡的编辑模型）。
 */
import { detectShuvixMarker, type ShuvixMarker } from '@shuvix/chat-protocol/shuvixMdContract'
import { validateShuvixMdText } from './shuvixMdValidate'

/** 写入方上下文（宿主注入的事实：谁写的、今天几号） */
export interface ShuvixMdWriteContext {
  /** 写下这份文件的（根）会话 id；宿主未提供则跳过溯源字段 */
  sessionId?: string
  /** 今天（YYYY-MM-DD） */
  today: string
}

export interface ShuvixMdWriteOutcome {
  /** 追加进工具 result 的一段话（模型面英文）；无话可说为 null */
  note: string | null
  /** 需要回写的完整文件内容；无补写为 null */
  content: string | null
}

/**
 * 缺省字段表：类型 → 要盖的章。
 *
 * `refresh` 区分两种语义 —— 更新日期是「最后改动」，每次写都该刷新；溯源会话是「谁记下的」，
 * 只在缺失时补，后来者不覆盖首写者。值算不出来（如宿主没给 sessionId）就跳过该键。
 */
interface FieldFiller {
  key: string
  refresh: boolean
  value: (ctx: ShuvixMdWriteContext) => string | undefined
}

const FIELD_FILLERS: Record<string, readonly FieldFiller[]> = {
  memory: [
    { key: 'shuvix-memory-updated', refresh: true, value: (c) => c.today },
    { key: 'shuvix-memory-session', refresh: false, value: (c) => c.sessionId }
  ]
}

/** 标记文案：`shuvix memory v1` / 无版本号时 `shuvix memory` */
function markerLabel(marker: ShuvixMarker): string {
  return `shuvix ${marker.type}${marker.version === null ? '' : ` v${marker.version}`}`
}

/** YAML 标量：简单值裸写（与既有文件风格一致），其余单引号包起来 */
function scalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/.test(value) ? value : `'${value.replace(/'/g, "''")}'`
}

interface Bounds {
  lines: string[]
  /** 起始定界线行号 */
  open: number
  /** 闭合定界线行号 */
  close: number
  /** 该文件的行尾（按闭合定界线判断，插入行沿用） */
  cr: string
}

/** 定位文件开头的 frontmatter 定界线；不是「开头即 frontmatter」的文件返回 null */
function bounds(text: string): Bounds | null {
  const lines = text.split('\n')
  let open = -1
  for (let i = 0; i < lines.length; i++) {
    // trim 连 BOM 一起吃掉（U+FEFF 属 JS 的 WhiteSpace），故首行带 BOM 也能认出定界线
    const t = lines[i].trim()
    if (t === '') continue
    if (t !== '---') return null
    open = i
    break
  }
  if (open < 0) return null
  for (let i = open + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return { lines, open, close: i, cr: lines[i].endsWith('\r') ? '\r' : '' }
    }
  }
  return null
}

/**
 * frontmatter 里补/改一个键（行级）。已是目标值则不动，返回是否发生改动。
 * 键名来自本模块的常量表，正则里直接用即可（无正则元字符）。
 */
function upsert(b: Bounds, key: string, value: string, refresh: boolean): boolean {
  const line = `${key}: ${scalar(value)}${b.cr}`
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*:`)
  for (let i = b.open + 1; i < b.close; i++) {
    if (!re.test(b.lines[i])) continue
    if (!refresh || b.lines[i] === line) return false // 已存在：溯源类不覆盖，值相同也不动
    b.lines[i] = line
    return true
  }
  b.lines.splice(b.close, 0, line)
  b.close++
  return true
}

/**
 * 写后审阅一份刚落盘的 md。
 *
 * 返回 null = 与本机制无关（不是契约 md、或该类型既无校验器也无缺省字段）。
 * 校验不通过只回原因、不动文件；通过才补字段（顺序是刻意的：往一份已经判废的文件里
 * 盖章，只会让 agent 收到的诊断更难读）。
 */
export function reviewShuvixMdWrite(
  text: string,
  fileName: string,
  ctx: ShuvixMdWriteContext
): ShuvixMdWriteOutcome | null {
  const marker = detectShuvixMarker(text)
  if (!marker) return null
  const label = markerLabel(marker)

  const validation = validateShuvixMdText(marker.type, text, fileName)
  if (validation.status === 'invalid') {
    const why = validation.messages.length
      ? validation.messages.map((m) => `- ${m}`).join('\n')
      : '- (the parser gave no reason)'
    return {
      note: `[${label}] The file was written, but it is INVALID and will be ignored until fixed:\n${why}`,
      content: null
    }
  }

  const notes: string[] = []
  if (validation.messages.length > 0) {
    notes.push(
      `[${label}] Written with parser warnings:\n${validation.messages.map((m) => `- ${m}`).join('\n')}`
    )
  }

  const fillers = FIELD_FILLERS[marker.type] ?? []
  const b = fillers.length > 0 ? bounds(text) : null
  const filled: string[] = []
  if (b) {
    for (const f of fillers) {
      const value = f.value(ctx)
      if (value && upsert(b, f.key, value, f.refresh)) filled.push(`${f.key}: ${value}`)
    }
  }
  if (filled.length > 0) notes.push(`[${label}] Filled in for you: ${filled.join(', ')}`)

  if (notes.length === 0) return null
  return { note: notes.join('\n\n'), content: filled.length > 0 && b ? b.lines.join('\n') : null }
}
