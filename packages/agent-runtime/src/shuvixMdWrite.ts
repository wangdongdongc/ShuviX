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
import { parse as parseYaml } from 'yaml'
import { KNOWLEDGE_MARKER_TYPE } from '@shuvix/chat-protocol/knowledge'
import { detectShuvixMarker, type ShuvixMarker } from '@shuvix/chat-protocol/shuvixMdContract'
import { WIKI_UPDATED_KEY } from '@shuvix/chat-protocol/wikiFileContract'
import { isOkfConceptText } from './knowledge/conceptFile'
import { isProjectionFile, isReservedFile, validateKnowledgeText } from './knowledge/validate'
import { validateShuvixMdText } from './shuvixMdValidate'

/** 写入方上下文（宿主注入的事实：谁写的、今天几号） */
export interface ShuvixMdWriteContext {
  /** 写下这份文件的（根）会话 id；宿主未提供则跳过溯源字段 */
  sessionId?: string
  /** 今天（YYYY-MM-DD） */
  today: string
  /**
   * OKF 知识库（设计 docs/okf-knowledge-design.md §5 stamp.ts）：刚落盘文件在**它所属
   * bundle 内**的相对路径 + 写入者 actor（`shuvix-<profile>/<model>`）+ 此刻（ISO 8601）。
   * 谁属于哪个 bundle 由宿主回答；不在任何 bundle 内、或宿主没有知识库（扩展端）就不给，
   * 那样这份文件与普通 md 无异。
   */
  knowledge?: { rel: string; actor: string; now: string }
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
  /** 恒加单引号 —— wiki 契约要求日期带引号（裸日期会被 YAML 读者转成时间戳） */
  quote?: boolean
  value: (ctx: ShuvixMdWriteContext) => string | undefined
}

const FIELD_FILLERS: Record<string, readonly FieldFiller[]> = {
  memory: [
    { key: 'shuvix-memory-updated', refresh: true, value: (c) => c.today },
    { key: 'shuvix-memory-session', refresh: false, value: (c) => c.sessionId }
  ],
  'wiki-entry': [{ key: WIKI_UPDATED_KEY, refresh: true, quote: true, value: (c) => c.today }]
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
function upsert(b: Bounds, key: string, value: string, refresh: boolean, quote = false): boolean {
  const rendered = quote ? `'${value.replace(/'/g, "''")}'` : scalar(value)
  const line = `${key}: ${rendered}${b.cr}`
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

/** 缩进宽度（制表符按 1 算 —— 只用于比较同一文件内的相对深度） */
function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/**
 * 补/改一个**映射**键为流式写法（`key: { … }`）。既有值可能是块式映射 / 序列
 * （`generated:\n  by: …\n  at: …`），只换键那一行会留下孤儿续行、撕破 YAML ——
 * 所以连同比键更深的续行（及同缩进的 `- ` 序列项）一起删掉再插入。返回是否发生改动。
 */
function upsertMapping(b: Bounds, key: string, flowValue: string): boolean {
  const line = `${key}: ${flowValue}${b.cr}`
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*:`)
  for (let i = b.open + 1; i < b.close; i++) {
    if (!re.test(b.lines[i])) continue
    const indent = indentOf(b.lines[i])
    let end = i + 1
    while (end < b.close) {
      const next = b.lines[end]
      const trimmed = next.trim()
      const deeper = trimmed !== '' && indentOf(next) > indent
      const sibling = trimmed.startsWith('- ') && indentOf(next) === indent
      if (!deeper && !sibling) break
      end++
    }
    const removed = end - i
    if (removed === 1 && b.lines[i] === line) return false
    b.lines.splice(i, removed, line)
    b.close -= removed - 1
    return true
  }
  b.lines.splice(b.close, 0, line)
  b.close++
  return true
}

/**
 * OKF 知识库分支 —— 带 `shuvix: okf` 自述行、或没有任何 `shuvix` 标记，且落在某个 bundle 里的 md。
 * 读宽写严：带自述行的条目（ShuviX 建出来的）严格校验，外来的 OKF 条目只可能出警告，用户的普通笔记
 * 只在 frontmatter 的 YAML 写坏时提醒。只有 OKF 条目补 `generated` 章（每次写都刷新：它记的是
 * 「谁最后改的、何时」），普通笔记宿主一个字节都不改。`verified` 只由 UI 动作写，这里不碰。
 * ShuviX 早先生成的 index.md / log.md 不再维护：agent 直写不回执、不盖章；用户自己写的同名笔记按普通笔记办。
 *
 * `knowledge` 工具的 `create` 之外，条目的一切改动都从这里过，所以回执要够用：写废了当场知道。
 */
function reviewKnowledgeWrite(
  text: string,
  ctx: ShuvixMdWriteContext,
  hasMarker: boolean
): ShuvixMdWriteOutcome | null {
  const k = ctx.knowledge
  if (!k) return null
  const rel = k.rel

  // 读宽写严：带自述行的条目严格查；用户的普通笔记只查 frontmatter 的 YAML 有没有写坏
  const diagnostics = validateKnowledgeText(text, rel)
  const errors = diagnostics.filter((d) => d.level === 'error').map((d) => `- ${d.message}`)
  if (errors.length > 0) {
    return {
      note: `[OKF] The file was written, but it breaks the knowledge base format and will not be read as intended until fixed:\n${errors.join('\n')}`,
      content: null
    }
  }
  // ShuviX 早先生成的 index / log：不再维护，没有什么可盖、可说的
  if (isProjectionFile(rel, text)) return null

  const notes: string[] = []
  const warnings = diagnostics.filter((d) => d.level === 'warning').map((d) => `- ${d.message}`)
  if (warnings.length > 0) notes.push(`[OKF] Written with warnings:\n${warnings.join('\n')}`)

  // `generated` 只盖在 OKF 条目上（带自述行的，或有 `type` 的外来条目）—— 用户的普通笔记宿主一个
  // 字节都不改，也不催它补自述行：那一行只保证 ShuviX 自己建出来的条目带着。保留名从来不是条目
  const b = !isReservedFile(rel) && (hasMarker || isOkfConceptText(text)) ? bounds(text) : null
  const stamped =
    !!b &&
    upsertMapping(
      b,
      'generated',
      `{ by: ${JSON.stringify(k.actor)}, at: ${JSON.stringify(k.now)} }`
    )
  if (stamped) {
    notes.push(
      `[OKF] Stamped generated: { by: ${k.actor}, at: ${k.now} } — never write generated or verified yourself.`
    )
  }
  if (notes.length === 0) return null
  return { note: notes.join('\n\n'), content: stamped && b ? b.lines.join('\n') : null }
}

/** 展示型契约（chart/wiki-*，validate 回 unknown）的兜底：frontmatter 过不了真 YAML 就报语法错首行 */
function frontmatterSyntaxError(text: string): string | null {
  const b = bounds(text)
  if (!b) return null
  try {
    parseYaml(b.lines.slice(b.open + 1, b.close).join('\n'))
    return null
  } catch (e) {
    return String(e instanceof Error ? e.message : e).split('\n')[0]
  }
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
  // 知识库条目走 OKF 分支：带 `shuvix: okf v…` 自述的，以及根目录下没有任何标记的
  // （外部工具 / 用户手写）。别家标记的文件照旧走各自契约的校验。
  if (!marker || marker.type === KNOWLEDGE_MARKER_TYPE)
    return reviewKnowledgeWrite(text, ctx, marker !== null)
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

  // 展示型契约没有「整份拒绝」的解析器（status 'unknown'），但 frontmatter 仍要过预览/
  // 属性卡的**真 YAML** 解析 —— 语法错在此回执，agent 当场能修。宽容读取只保证文件不从
  // 视图消失，救不了展示：wiki 条目横幅曾因裸标量里的「冒号+空格」让每个生成文件都亮
  // 「YAML 语法错误」、字段卡全空，而写它的 agent 毫无所觉。
  if (validation.status === 'unknown') {
    const yamlError = frontmatterSyntaxError(text)
    if (yamlError) {
      return {
        note: `[${label}] The file was written, but its frontmatter is not valid YAML — ShuviX previews will show a syntax error instead of the fields until fixed:\n- ${yamlError}`,
        content: null
      }
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
      if (value && upsert(b, f.key, value, f.refresh, f.quote === true)) {
        filled.push(`${f.key}: ${value}`)
      }
    }
  }
  if (filled.length > 0) notes.push(`[${label}] Filled in for you: ${filled.join(', ')}`)

  if (notes.length === 0) return null
  return { note: notes.join('\n\n'), content: filled.length > 0 && b ? b.lines.join('\n') : null }
}
