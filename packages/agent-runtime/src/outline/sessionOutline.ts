/**
 * 会话大纲（docs/sub-session-design.md §19.7）—— 父会话查看子会话现场的读法：**先给目录，再按编号展开一条，
 * 每次调用有字数上限，不调模型。**
 *
 * 输入是界面投影的那一份视图（`SessionView`：已落盘的消息、正在流式的卡、挂着的询问、排队的输入），所以父会话
 * 看到的就是用户点进去看到的那一份 —— 同样的压缩口径、同样的条目 id。输出只是几行字，围栏由调用方加。
 *
 * 一行一个条目，带短编号：
 *  - 消息级 `#<id>`（用户消息、错误、压缩摘要；助手消息的编号展开整张卡）；块级 `#<id>.<n>`（第 n 个块）；
 *    相邻的已完成步骤折成一行 `#<id>.<i>-<j>`，规则与界面的 StepGroup 同一份（chat-protocol `stepGrouping`）。
 *  - 编号取自条目 id（durable 是数字，旧会话的长 id 取末 8 位，撞了用全长）：开着看与重开看是同一个编号。
 *    块用序号而不是 toolCallId —— 有的中转每轮从 `call_0` 数起，会撞。
 *  - 用户消息标来源：`[you]`（读大纲的会话发的）/ `[parent]`（它的父会话发的）/ `[other session]`（别的被授权的
 *    会话发的）/ `[trigger]`（触发器替 bot 发的）/ `[user]`（人打的）/ `[unattributed]`（分不清：升级之前、没有来源
 *    记录的那些，判法是 `authorsOf`，与自动审查同一份）/ `[notice]`（系统写的）；思考只计数；
 *    工具结果不出现（失败的附错误首行）；进行中 / 待批准 / 待回答的单独一行标状态。
 *
 * 「轮」的切法：一条用户消息开始新的一轮，**除非**它前面紧挨着一张带工具调用的助手卡 —— 那是跑到一半插进来的
 * 引导（steer），不是新的一轮。默认只看最近一轮。
 *
 * 不依赖 Node / Electron；纯函数（不读时钟、不改输入）。
 */
import type {
  AssistantBlock,
  AssistantMessage,
  ChatMessage
} from '@shuvix/chat-protocol/types/chatMessage'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { buildToolSummary } from '@shuvix/chat-protocol/toolSummaries'
import { clipLine } from '@shuvix/chat-protocol/utils/clipLine'
import { withoutMidRunNote } from '@shuvix/chat-protocol/midRunNote'
import {
  formatStepSequence,
  groupConsecutiveSteps,
  summarizeSteps,
  uniformToolName
} from '@shuvix/chat-protocol/utils/stepGrouping'
import { authorsOf, type InputSource, type MessageAuthor } from '../durable/inputSource'

/** 大纲读的那几项视图 */
export type OutlineView = Pick<SessionView, 'messages' | 'live' | 'asks' | 'queue' | 'run'>

/** 谁在读、哪些用户消息不是人打的 */
export interface OutlineReader {
  /** 读大纲的会话（父会话）：它自己发的消息标 `[you]` */
  readerId: string
  /** 用户消息 id → 来源（不是人亲手打的那些；agent-runtime `readInputSources`） */
  sources: ReadonlyMap<string, InputSource>
  /** 被读的是一条顶层会话（不是子会话）：没有来源记录的用户消息都是人打的（见 `authorsOf`） */
  topLevel?: boolean
}

export interface OutlineQuery {
  /** 往前看几轮（缺省 1，上限 5）；给了 `before` 时不看它 */
  turns?: number
  /** 展开一条（编号，`#` 可省） */
  item?: string
  /** 在整段（压缩之后的）历史里找含这段文字的条目（不分大小写） */
  match?: string
  /** 只看这个编号之前的条目（上一次输出截断时给的游标） */
  before?: string
  /** 输出的字数上限（缺省 `OUTLINE_LIMITS.budget`） */
  budget?: number
}

export const OUTLINE_LIMITS = {
  defaultTurns: 1,
  maxTurns: 5,
  /** 一次大纲 / 搜索输出的字数上限 */
  budget: 4000,
  /** 展开一条的字数上限（截中间、留头尾） */
  item: 8000,
  /** 搜索最多交回几行 */
  matches: 20
} as const

export type OutlineResult =
  | {
      kind: 'outline'
      lines: string[]
      /** 这次展示的轮次范围（1 起）与总轮数；没有任何条目时都是 0 */
      turnFrom: number
      turnTo: number
      turnCount: number
      /** 展示了几行 / 这个范围里一共几行 */
      shown: number
      total: number
      /** 范围里因字数上限被省掉的那些更早的行：传它接着往前看 */
      before?: string
      /** 范围之前还有更早的轮次 */
      earlierTurns: boolean
    }
  | { kind: 'item'; ref: string; lines: string[] }
  | { kind: 'match'; query: string; lines: string[]; hits: number; shown: number }
  | { kind: 'error'; error: string }

// ─────────────────────────── 行 ───────────────────────────

interface Row {
  /** `#123` / `#123.2` / `#123.0-3` / `#q7` */
  ref: string
  turn: number
  /** 大纲里的那一行（不含编号） */
  line: string
  /** 展开时交出的那几行 */
  expand: () => string[]
  /** 搜索用的全文（行本身 + 隐藏的部分：参数、结果、全文） */
  search: string
  /** 搜索用的叶子行（折叠行展开成它的每一块；其余就是自己） */
  leaves: Row[]
}

const USER_CLIP = 200
const YOU_CLIP = 80
const NOTICE_CLIP = 120
const TEXT_CLIP = 150
const REPLY_CLIP = 200
const ERROR_CLIP = 200
const QUESTION_CLIP = 120
const ARGS_MAX = 2000
const RESULT_MAX = 6000
const SNIPPET_RADIUS = 60
/** 搜索命中附带的片段总长（不随搜索词变长 —— 否则一个长搜索词就能绕过字数上限） */
const SNIPPET_MAX = 160
/** 选项：每个 label 的上限、整串的上限（ask 的 schema 只限个数不限长度） */
const OPTION_CLIP = 40
const OPTIONS_CLIP = 160
/**
 * 一行大纲（编号之后）的硬上限。字数上限「至少保一行」，这一行也不能无限长 —— 每一处都截过了，这是兜底。
 */
const LINE_MAX = 400

/** 压成一行再截短 */
function oneLine(text: string, max: number): string {
  return clipLine(text.replace(/\s+/g, ' ').trim(), max)
}

/** 第一条非空行 */
function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  )
}

/** 截中间、留头尾（标出省掉多少字） */
function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const keep = Math.max(0, max - 40)
  const head = Math.ceil(keep * 0.6)
  const tail = keep - head
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n… [${omitted} characters omitted] …\n${tail > 0 ? text.slice(-tail) : ''}`
}

function jsonOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** 选择题的选项一行：每个截短、整串再截短 */
function optionsLine(options: ReadonlyArray<{ label: string }>): string {
  return oneLine(options.map((o) => oneLine(o.label, OPTION_CLIP)).join(' | '), OPTIONS_CLIP)
}

/** 挂着的选择题在大纲里的那一行 */
function questionLine(ask: Extract<InputRequest, { kind: 'choice' }>): string {
  return `ask (asking, ask_id=${oneLine(ask.id, 60)}) ${oneLine(ask.question, QUESTION_CLIP)} [${optionsLine(ask.options)}]`
}

/** 一个工具块的标签：工具名 + 折叠态摘要（与界面同一张摘要表） */
function toolLabel(block: Extract<AssistantBlock, { type: 'tool' }>): string {
  const summary = buildToolSummary(block.toolName, block.args)
  return summary ? `${block.toolName} ${oneLine(summary, 80)}` : block.toolName
}

// ─────────────────────────── 编号 ───────────────────────────

/** 消息 id → 短编号（数字原样；长 id 取末 8 位，撞了用全长；实时卡 → `live`） */
function shortIds(ids: readonly string[]): Map<string, string> {
  const shortOf = (id: string): string => {
    if (id.startsWith('live:')) return 'live'
    return id.length > 8 ? id.slice(-8) : id
  }
  const counts = new Map<string, number>()
  for (const id of ids) counts.set(shortOf(id), (counts.get(shortOf(id)) ?? 0) + 1)
  const out = new Map<string, string>()
  for (const id of ids) {
    const short = shortOf(id)
    out.set(id, (counts.get(short) ?? 0) > 1 ? id : short)
  }
  return out
}

function normalizeRef(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
}

// ─────────────────────────── 构建 ───────────────────────────

interface BuildContext {
  reader: OutlineReader
  asks: readonly InputRequest[]
  /** 挂着的询问里，对上了某个还没结果的工具块的那些（其余的另起一行，见 buildRows） */
  matchedAsks: Set<string>
  busy: boolean
}

function hasToolBlocks(message: ChatMessage | undefined): boolean {
  return message?.role === 'assistant' && message.blocks.some((b) => b.type === 'tool')
}

/**
 * 这条用户消息开不开新的一轮：前面是一张带工具调用的助手卡（跑到一半插进来的引导）、或者另一条用户消息
 * （连着几条引导 / 一起放下的排队输入）→ 同一轮；其余（开头、最终答复之后、错误之后）→ 新的一轮。
 * 已知偏差：一轮被中止在工具调用上之后发的新消息也算同一轮（视图里没有「被中止」的标记）。
 */
function continuesTurn(previous: ChatMessage | undefined): boolean {
  return previous?.role === 'user' || hasToolBlocks(previous)
}

/** 一个工具块的一行（不含编号）+ 展开 + 搜索文本 */
function toolRow(
  block: Extract<AssistantBlock, { type: 'tool' }>,
  ctx: BuildContext,
  current: boolean
): Pick<Row, 'line' | 'expand' | 'search'> {
  const label = toolLabel(block)
  // 询问只对得上还没结果的块：toolCallId 会被重用（中转每轮从 call_0 数起），旧的已完成块不能显示成「在问」
  const ask =
    block.result === undefined ? ctx.asks.find((a) => a.id === block.toolCallId) : undefined
  if (ask) ctx.matchedAsks.add(ask.id)
  let line: string
  let status: string
  if (ask?.kind === 'choice') {
    line = questionLine(ask)
    status = 'waiting for an answer'
  } else if (ask?.kind === 'ask') {
    line = `${label} — waiting for the user's approval`
    status = "waiting for the user's approval"
  } else if (block.result === undefined) {
    // 只有当前这一张卡里的块可能还在跑：更早的卡里没回填结果的块是没跑完就断了的
    const running = current && ctx.busy
    line = `${label} — ${running ? 'running' : 'did not finish'}`
    status = running ? 'running' : 'did not finish'
  } else if (block.isError) {
    line = `${label} — FAILED: ${oneLine(firstLine(block.result), ERROR_CLIP)}`
    status = 'failed'
  } else if (block.toolName === 'ask') {
    const question = typeof block.args?.question === 'string' ? block.args.question : ''
    line = `ask ${oneLine(question, QUESTION_CLIP)} → ${oneLine(block.result, 100)}`
    status = 'answered'
  } else {
    line = label
    status = 'done'
  }
  const args = jsonOf(block.args ?? {})
  const result = block.result ?? ''
  return {
    line,
    search: [block.toolName, args, result].join('\n'),
    expand: () => [
      `tool: ${block.toolName}`,
      `status: ${status}`,
      `args: ${clipMiddle(args, ARGS_MAX)}`,
      ...(block.result === undefined ? [] : ['result:', clipMiddle(result, RESULT_MAX)])
    ]
  }
}

/**
 * 单个块的一行（思考只计数、搜不到 —— 它只在点名展开时给；正文截短；工具见 toolRow）。
 * 正在流式的卡不标 `reply:`：它还没说完，标成最终答复会让父会话以为它答完了。
 */
function blockRow(
  block: AssistantBlock,
  isReply: boolean,
  ctx: BuildContext,
  current: boolean,
  live: boolean
): Pick<Row, 'line' | 'expand' | 'search'> {
  if (block.type === 'thinking') {
    return { line: 'think', search: '', expand: () => ['thinking:', block.text] }
  }
  if (block.type === 'text') {
    const reply = isReply && !live
    const prefix = reply ? 'reply' : 'text'
    const clip = reply ? REPLY_CLIP : TEXT_CLIP
    return {
      line: `${prefix}: ${oneLine(block.text, clip)}${live ? ' (streaming)' : ''}`,
      search: block.text,
      expand: () => [`${prefix}:`, block.text]
    }
  }
  return toolRow(block, ctx, current)
}

/**
 * 界面的折叠分组，再把 ask 调用单独拎出来：父会话要看得见它问了什么、得到了什么回答，折进一串步骤里就藏起来了。
 * 交回的每一段是「一个块」或「两个以上可折叠的块」，与 groupConsecutiveSteps 的形状相同。
 */
function outlineGroups(blocks: readonly AssistantBlock[]): AssistantBlock[][] {
  const out: AssistantBlock[][] = []
  for (const group of groupConsecutiveSteps(blocks)) {
    if (group.kind === 'single') {
      out.push([group.block])
      continue
    }
    let run: AssistantBlock[] = []
    const flush = (): void => {
      if (run.length > 0) out.push(run)
      run = []
    }
    for (const block of group.blocks) {
      if (block.type === 'tool' && block.toolName === 'ask') {
        flush()
        out.push([block])
      } else run.push(block)
    }
    flush()
  }
  return out
}

function assistantRows(
  message: AssistantMessage,
  ref: string,
  turn: number,
  ctx: BuildContext,
  current: boolean,
  live: boolean
): Row[] {
  if (message.metadata?.isCompactionSummary) {
    const row: Row = {
      ref: `#${ref}`,
      turn,
      line: `[summary of earlier conversation] ${oneLine(message.content, TEXT_CLIP)}`,
      search: message.content,
      expand: () => ['summary of earlier conversation:', message.content],
      leaves: []
    }
    row.leaves = [row]
    return [row]
  }
  const blocks = message.blocks
  // 最终答复 = 这张卡没有工具调用（对话的终点），它的最后一段正文
  const final = !blocks.some((b) => b.type === 'tool')
  let lastText = -1
  if (final) blocks.forEach((b, i) => b.type === 'text' && (lastText = i))

  const rows: Row[] = []
  const leafOf = (block: AssistantBlock, index: number): Row => {
    const row = blockRow(block, index === lastText, ctx, current, live)
    const leaf: Row = { ref: `#${ref}.${index}`, turn, ...row, leaves: [] }
    leaf.leaves = [leaf]
    return leaf
  }
  let index = 0
  for (const group of outlineGroups(blocks)) {
    if (group.length === 1) {
      rows.push(leafOf(group[0], index))
      index += 1
      continue
    }
    // 两个以上的块只会来自可折叠的那一段（思考 / 已完成的工具调用），StepBlock 的形状
    const steps = group as Parameters<typeof summarizeSteps>[0]
    const from = index
    const leaves = group.map((b, k) => leafOf(b, from + k))
    index += group.length
    const sequence = formatStepSequence(
      summarizeSteps(steps, (b) => (b.type === 'thinking' ? 'think' : b.toolName)),
      80
    )
    const uniform = uniformToolName(steps)
    let line = sequence
    if (uniform) {
      const summaries = [
        ...new Set(
          group
            .map((b) => (b.type === 'tool' ? buildToolSummary(b.toolName, b.args) : undefined))
            .filter((s): s is string => !!s)
            .map((s) => oneLine(s, 60))
        )
      ]
      if (summaries.length > 0) line = `${sequence}  ${oneLine(summaries.join(' · '), 120)}`
    }
    rows.push({
      ref: `#${ref}.${from}-${index - 1}`,
      turn,
      line,
      search: leaves.map((l) => l.search).join('\n'),
      expand: () => leaves.map((l) => `${l.ref} ${l.line}`),
      leaves
    })
  }
  return rows
}

function isNotice(message: ChatMessage): boolean {
  return (
    message.role === 'user' &&
    !!(message.metadata?.isSystemNotice || message.metadata?.isInstructionInjection)
  )
}

function userRow(
  message: Extract<ChatMessage, { role: 'user' }>,
  ref: string,
  turn: number,
  reader: OutlineReader,
  author: MessageAuthor | undefined
): Row {
  // 插话说明是系统写的，不算这条消息的话（docs/task-list-design.md §2.4）
  const text = withoutMidRunNote(message.content, message.metadata?.inlineTokens)
  let line: string
  if (isNotice(message)) {
    line = `[notice] ${oneLine(firstLine(text), NOTICE_CLIP)}`
  } else {
    const source = reader.sources.get(message.id)
    if (source?.kind === 'trigger') line = `[trigger] ${oneLine(text, YOU_CLIP)}`
    else if (source && source.sessionId === reader.readerId) {
      line = `[you] ${oneLine(text, YOU_CLIP)}`
    } else if (source?.kind === 'session') line = `[other session] ${oneLine(text, YOU_CLIP)}`
    else if (source) line = `[parent] ${oneLine(text, YOU_CLIP)}`
    else if (author === 'human') line = `[user] ${oneLine(text, USER_CLIP)}`
    else line = `[unattributed] ${oneLine(text, USER_CLIP)}`
  }
  const row: Row = {
    ref: `#${ref}`,
    turn,
    line,
    search: text,
    expand: () => [line.slice(0, line.indexOf(']') + 1), text],
    leaves: []
  }
  row.leaves = [row]
  return row
}

/** 视图 → 全部行（旧 → 新）+ 消息级编号 → 那张卡的全部行（展开助手卡用） */
function buildRows(
  view: OutlineView,
  reader: OutlineReader
): { rows: Row[]; byMessage: Map<string, Row[]>; turnCount: number } {
  const messages: ChatMessage[] = [...view.messages]
  const liveMessage = view.live?.message
  if (liveMessage) messages.push({ ...liveMessage, id: view.live?.id ?? 'live:' })
  const refs = shortIds(messages.map((m) => m.id))
  const ctx: BuildContext = {
    reader,
    asks: view.asks,
    matchedAsks: new Set(),
    busy: view.run.state === 'busy'
  }
  // 用户消息谁写的：与自动审查同一个判法（第一条有来源记录的之后、没有记录的才是人打的）
  const userMessages = messages.filter((m) => m.role === 'user' && !isNotice(m))
  const authors = authorsOf(userMessages, (m) => reader.sources.has(m.id), {
    topLevel: reader.topLevel === true
  })
  // 「当前这一张卡」= 最后一张助手卡（正在流式的那张，或最后落盘的那张）
  let currentIndex = -1
  messages.forEach((m, i) => m.role === 'assistant' && (currentIndex = i))

  const rows: Row[] = []
  const byMessage = new Map<string, Row[]>()
  let turn = 0
  let previous: ChatMessage | undefined
  for (const [i, message] of messages.entries()) {
    if (message.role === 'user' && !continuesTurn(previous)) turn += 1
    if (turn === 0) turn = 1
    const ref = refs.get(message.id) ?? message.id
    const isLive = liveMessage !== undefined && i === messages.length - 1
    let produced: Row[]
    if (message.role === 'user') {
      produced = [userRow(message, ref, turn, reader, authors.get(message))]
    } else if (message.role === 'system_notify') {
      const row: Row = {
        ref: `#${ref}`,
        turn,
        line: `error: ${oneLine(message.content, ERROR_CLIP)}`,
        search: message.content,
        expand: () => ['error:', message.content],
        leaves: []
      }
      row.leaves = [row]
      produced = [row]
    } else produced = assistantRows(message, ref, turn, ctx, i === currentIndex, isLive)
    if (produced.length > 0) {
      rows.push(...produced)
      byMessage.set(`#${ref}`, produced)
    }
    previous = message
  }
  // 挂着、却对不上任何工具块的询问（派生 agent 的询问、卡片先于卡落下的那一刻……）另起一行，不能看不见
  for (const ask of view.asks) {
    if (ctx.matchedAsks.has(ask.id)) continue
    const line =
      ask.kind === 'choice'
        ? questionLine(ask)
        : `${oneLine(`${ask.toolName}: ${ask.command}`, 120)} — waiting for the user's approval`
    const row: Row = {
      // 编号用完整的 id：截短了两个前缀相同的 id 会撞车（行本身另有长度兜底）
      ref: `#ask.${ask.id.replace(/\s+/g, '')}`,
      turn: Math.max(turn, 1),
      line,
      search: ask.kind === 'choice' ? ask.question : ask.command,
      expand: () =>
        ask.kind === 'choice'
          ? [
              `question (ask_id ${ask.id}):`,
              ask.question,
              ...ask.options.map((o) => `- ${o.label}${o.description ? ` — ${o.description}` : ''}`)
            ]
          : [`waiting for the user's approval (${ask.toolName}):`, ask.command],
      leaves: []
    }
    row.leaves = [row]
    rows.push(row)
  }
  for (const queued of view.queue) {
    const row: Row = {
      ref: `#q${queued.submissionId}`,
      turn: Math.max(turn, 1),
      line: `[queued ${queued.mode}] ${oneLine(queued.text, USER_CLIP)}`,
      search: queued.text,
      expand: () => [`queued ${queued.mode}:`, queued.text],
      leaves: []
    }
    row.leaves = [row]
    rows.push(row)
  }
  // 只有询问 / 排队输入、没有消息时也算一轮（否则会出现「第 1 轮，共 0 轮」）
  return { rows, byMessage, turnCount: rows.length > 0 ? Math.max(turn, 1) : turn }
}

// ─────────────────────────── 入口 ───────────────────────────

/** 一行大纲的最终样子（编号 + 正文，过长再截一次 —— 兜底） */
/** 一行大纲 / 搜索结果：被读那条会话写的字可能带着能撕破外层围栏的闭合标签 —— 与展开同样拆开 */
function renderRow(row: Row, suffix = ''): string {
  // 先拆再截：拆开多出的空格不该撑过行长上限
  return `${row.ref} ${clipLine(defuseFences(`${row.line}${suffix}`), LINE_MAX)}`
}

/**
 * 从最新往前装，直到装满字数上限（至少一行）；按**渲染之后**的长度量（含片段、换行），交回装下的那一段
 * （旧 → 新）。
 */
function fitBudget<T>(items: readonly T[], render: (item: T) => string, budget: number): T[] {
  const kept: T[] = []
  let used = 0
  for (let i = items.length - 1; i >= 0; i--) {
    const length = render(items[i]).length + 1
    if (kept.length > 0 && used + length > budget) break
    kept.unshift(items[i])
    used += length
  }
  return kept
}

/** 被读那条会话的原文里可能有能撕破外层围栏的闭合标签（它读过的网页、文件）：展开、大纲行、搜索行都拆开 */
function defuseFences(text: string): string {
  return text.replace(/<\/(transcript|session|sub-session)\b/gi, '</ $1')
}

/**
 * 一条会话的大纲 / 一条展开 / 一次搜索（三选一：`item` 优先，其次 `match`，否则大纲）。
 * 交回几行字（不带围栏）与这次看的范围；编号不存在、搜索词为空 → `{kind:'error'}`。
 */
export function buildSessionOutline(
  view: OutlineView,
  reader: OutlineReader,
  query: OutlineQuery = {}
): OutlineResult {
  const { rows, byMessage, turnCount } = buildRows(view, reader)
  const budget = query.budget ?? OUTLINE_LIMITS.budget

  if (query.item !== undefined && query.item.trim() !== '') {
    const ref = normalizeRef(query.item)
    const whole = byMessage.get(ref)
    const row =
      whole && whole.length === 1 && whole[0].ref === ref
        ? whole[0]
        : (rows.find((r) => r.ref === ref) ??
          rows.flatMap((r) => r.leaves).find((l) => l.ref === ref))
    let lines: string[]
    if (row) lines = row.expand()
    else if (whole) lines = whole.map((r) => renderRow(r))
    else
      return {
        kind: 'error',
        error: `No item ${ref} in this conversation. Take a ref from the outline.`
      }
    // 先拆标签再截：拆一个多一个空格，先截后拆会超过上限
    const text = clipMiddle(defuseFences(lines.join('\n')), OUTLINE_LIMITS.item)
    return { kind: 'item', ref, lines: text.split('\n') }
  }

  // 空搜索词与空编号同一口径：当作没给（落到大纲）
  if (query.match !== undefined && query.match.trim() !== '') {
    const needle = query.match.trim().toLowerCase()
    const hits = rows
      .flatMap((r) => r.leaves)
      .filter((l) => `${l.line}\n${l.search}`.toLowerCase().includes(needle))
    const render = (l: Row): string => {
      if (l.line.toLowerCase().includes(needle)) return renderRow(l)
      // 片段以命中处为中心、总长固定：搜索词再长也撑不大它
      const at = l.search.toLowerCase().indexOf(needle)
      const from = Math.max(0, at - SNIPPET_RADIUS)
      const snippet = oneLine(l.search.slice(from, from + SNIPPET_MAX), SNIPPET_MAX)
      return renderRow(l, `  … ${snippet} …`)
    }
    const shownHits = fitBudget(hits.slice(-OUTLINE_LIMITS.matches), render, budget)
    const lines = shownHits.map(render)
    return {
      kind: 'match',
      query: oneLine(query.match, 200),
      lines,
      hits: hits.length,
      shown: lines.length
    }
  }

  let range: Row[]
  /** 范围之前还有更早的轮次（`before` 模式下范围从头开始，没有） */
  let earlierTurns = false
  if (query.before !== undefined && query.before.trim() !== '') {
    const ref = normalizeRef(query.before)
    const at = rows.findIndex((r) => r.ref === ref)
    if (at < 0) {
      return {
        kind: 'error',
        error: `No item ${ref} in this conversation. Take a ref from the outline.`
      }
    }
    range = rows.slice(0, at)
  } else {
    const asked = query.turns
    const turns = Math.min(
      OUTLINE_LIMITS.maxTurns,
      Math.max(
        1,
        Math.floor(
          typeof asked === 'number' && Number.isFinite(asked) ? asked : OUTLINE_LIMITS.defaultTurns
        )
      )
    )
    const turnFrom = Math.max(1, turnCount - turns + 1)
    range = rows.filter((r) => r.turn >= turnFrom)
    earlierTurns = turnFrom > 1
  }
  const kept = fitBudget(range, (r) => renderRow(r), budget)
  const omitted = range.length - kept.length
  return {
    kind: 'outline',
    lines: kept.map((r) => renderRow(r)),
    turnFrom: kept.length > 0 ? kept[0].turn : 0,
    turnTo: kept.length > 0 ? kept[kept.length - 1].turn : 0,
    turnCount,
    shown: kept.length,
    total: range.length,
    ...(omitted > 0 && kept.length > 0 ? { before: kept[0].ref } : {}),
    earlierTurns
  }
}
