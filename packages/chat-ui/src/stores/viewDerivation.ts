/**
 * 视图 → store 切片的纯推导（P3-08）。`applySessionView`（chatStore）与 `applyAgentView`（subSessionStore）
 * 都只经这里把一份 `SessionView` / `AgentView` 变成界面读的那些形状：流式正文 / 思考 / 正在生成的工具调用、
 * 工具执行进度（排着的输入不推导：队列面板直接读视图的 `queue`）。
 *
 * **结构共享**是这里的另一半职责：chord 的复制状态在增量更新时已经共享没变的子树（一条流式追加只换
 * `live` 那一枝），但整份 `reset` / `replaced` 交来的是一棵全新的树。`shareStructure` 把新树里与旧树
 * 深相等的部分换回旧对象 —— 消息行的 memo、虚拟列表的 key、选择器的引用判等都靠它稳住。推导函数同理：
 * 结果与上一次逐项相等时交回上一次的那个对象。
 */
import type {
  AssistantBlock,
  AssistantMessage,
  AssistantToolBlock,
  ChatMessage,
  ErrorEventMessage
} from '@shuvix/chat-protocol/types/chatMessage'
import type {
  AgentView,
  LiveCard,
  SessionView,
  ToolRunView
} from '@shuvix/chat-protocol/types/sessionView'

// ─────────────────────────── 结构共享 ───────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 数组元素若都是带字符串 `id` 的对象，按 id 对齐（消息列表）；否则按下标 */
function idOf(value: unknown): string | undefined {
  return isPlainObject(value) && typeof value.id === 'string' ? value.id : undefined
}

/**
 * 把 `next` 里与 `prev` 深相等的部分换成 `prev` 的对象。整棵相等 → 交回 `prev` 本身。只处理 JSON 形状
 * （对象 / 数组 / 原子值）；`next` 本身从不被修改。
 */
export function shareStructure<T>(prev: T | undefined, next: T): T {
  if (prev === next || prev === undefined) return next
  if (Array.isArray(prev) && Array.isArray(next)) {
    const byId = new Map<string, unknown>()
    for (const item of prev) {
      const id = idOf(item)
      if (id !== undefined) byId.set(id, item)
    }
    let same = prev.length === next.length
    const out = next.map((item, index) => {
      const id = idOf(item)
      const base = id !== undefined && byId.has(id) ? byId.get(id) : prev[index]
      const shared = shareStructure(base, item)
      if (shared !== prev[index]) same = false
      return shared
    })
    return (same ? prev : out) as T
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const prevKeys = Object.keys(prev)
    const nextKeys = Object.keys(next)
    let same = prevKeys.length === nextKeys.length
    const out: Record<string, unknown> = {}
    for (const key of nextKeys) {
      const shared = shareStructure(prev[key], next[key])
      if (shared !== prev[key] || !(key in prev)) same = false
      out[key] = shared
    }
    return (same ? prev : out) as T
  }
  return next
}

// ─────────────────────────── 流式状态 ───────────────────────────

/** 一个会话的流式状态（界面的流式占位卡、输入框形态、侧栏转圈读它） */
export interface SessionStreamState {
  content: string
  thinking: string
  isStreaming: boolean
  /** 当前正在生成的工具调用（模型还在吐它的参数） */
  streamingToolCall: { toolName: string; argsText: string } | null
  /** 已生成完、还没开始执行的工具调用（多工具顺序生成时累积） */
  completedStreamingToolCalls: Array<{ toolName: string; args?: Record<string, unknown> }>
}

export const EMPTY_COMPLETED_TOOL_CALLS: SessionStreamState['completedStreamingToolCalls'] = []

export function emptyStream(isStreaming = false): SessionStreamState {
  return {
    content: '',
    thinking: '',
    isStreaming,
    streamingToolCall: null,
    completedStreamingToolCalls: EMPTY_COMPLETED_TOOL_CALLS
  }
}

function joinBlocks(blocks: readonly AssistantBlock[], type: 'text' | 'thinking'): string {
  let out = ''
  for (const block of blocks) if (block.type === type) out += block.text
  return out
}

function sameCompleted(
  a: SessionStreamState['completedStreamingToolCalls'],
  b: SessionStreamState['completedStreamingToolCalls']
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((item, i) => item.toolName === b[i].toolName && item.args === b[i].args)
}

/** 工具调用的参数原文：有流式原文用原文（`argsText`），否则是解析出来的部分参数序列化（F11） */
function argsTextOf(live: LiveCard, block: AssistantToolBlock): string {
  return live.argsText?.[block.toolCallId] ?? JSON.stringify(block.args ?? {})
}

/**
 * 实时卡 + 工具进度 + 运行状态 → 流式状态。
 *  - 正文 / 思考 = 实时卡的 text / thinking 块（各自拼接）；
 *  - 正在生成的工具调用 = 实时卡**最后一块**是工具块、且它还没进 `toolRuns`；
 *  - 已生成完的 = 其余还没进 `toolRuns` 的工具块（带参数）；
 *  - `isStreaming` = 运行在跑，或本端刚发出一条还没被受理的消息（乐观占位，`pending`）。
 * 与 `prev` 逐项相等时交回 `prev`。
 */
export function deriveStream(
  view: Pick<SessionView, 'live' | 'toolRuns' | 'run'>,
  pending: boolean,
  prev?: SessionStreamState
): SessionStreamState {
  const live = view.live
  const blocks = live?.message.blocks ?? []
  const content = joinBlocks(blocks, 'text')
  const thinking = joinBlocks(blocks, 'thinking')
  const isStreaming = view.run.state === 'busy' || pending
  const last = blocks[blocks.length - 1]
  const generating =
    live && last?.type === 'tool' && !(last.toolCallId in view.toolRuns) ? last : undefined
  const streamingToolCall =
    live && generating
      ? { toolName: generating.toolName, argsText: argsTextOf(live, generating) }
      : null
  const completedList: SessionStreamState['completedStreamingToolCalls'] = []
  for (const block of blocks) {
    if (block.type !== 'tool' || block === generating || block.toolCallId in view.toolRuns) continue
    completedList.push({ toolName: block.toolName, args: block.args })
  }
  const prevCompleted = prev?.completedStreamingToolCalls ?? EMPTY_COMPLETED_TOOL_CALLS
  const completed =
    completedList.length === 0
      ? EMPTY_COMPLETED_TOOL_CALLS
      : sameCompleted(prevCompleted, completedList)
        ? prevCompleted
        : completedList
  const sameToolCall =
    prev !== undefined &&
    (prev.streamingToolCall === streamingToolCall ||
      (prev.streamingToolCall !== null &&
        streamingToolCall !== null &&
        prev.streamingToolCall.toolName === streamingToolCall.toolName &&
        prev.streamingToolCall.argsText === streamingToolCall.argsText))
  if (
    prev !== undefined &&
    prev.content === content &&
    prev.thinking === thinking &&
    prev.isStreaming === isStreaming &&
    sameToolCall &&
    prev.completedStreamingToolCalls === completed
  ) {
    return prev
  }
  return {
    content,
    thinking,
    isStreaming,
    streamingToolCall: sameToolCall ? prev!.streamingToolCall : streamingToolCall,
    completedStreamingToolCalls: completed
  }
}

// ─────────────────────────── 工具执行 ───────────────────────────

/** 工具执行实时状态（工具卡的运行中 / 审查中 / 结果读它） */
export interface ToolExecution {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  result?: string
  /** 工具特定的结构化详情（edit diff 等） */
  details?: AssistantToolBlock['details']
  /** 工具块所属的消息 id（落盘的卡 = 条目 id；还在流式的 = 实时卡 id） */
  messageId?: string
  /** 自动审查正在替用户看这次调用（`tool_review` 事件的本地叠加，PIN-04） */
  reviewing?: boolean
}

export const EMPTY_TOOLS: ToolExecution[] = []

/** toolCallId → 它的工具块与所属消息（先落盘的卡，再实时卡） */
function toolBlocksOf(
  messages: readonly ChatMessage[],
  live: LiveCard | null,
  wanted: ReadonlySet<string>
): Map<string, { block: AssistantToolBlock; messageId: string }> {
  const found = new Map<string, { block: AssistantToolBlock; messageId: string }>()
  if (wanted.size === 0) return found
  const scan = (message: AssistantMessage): void => {
    for (const block of message.blocks) {
      if (block.type === 'tool' && wanted.has(block.toolCallId)) {
        found.set(block.toolCallId, { block, messageId: message.id })
      }
    }
  }
  // 从新往旧找：工具进度只属于最近的那几张卡
  for (let index = messages.length - 1; index >= 0 && found.size < wanted.size; index--) {
    const message = messages[index]
    if (message.role === 'assistant' && message.type === 'message') scan(message)
  }
  if (live && found.size < wanted.size) {
    for (const block of live.message.blocks) {
      if (block.type === 'tool' && wanted.has(block.toolCallId) && !found.has(block.toolCallId)) {
        found.set(block.toolCallId, { block, messageId: live.id })
      }
    }
  }
  return found
}

function sameExecution(a: ToolExecution, b: ToolExecution): boolean {
  return (
    a.toolCallId === b.toolCallId &&
    a.toolName === b.toolName &&
    a.args === b.args &&
    a.status === b.status &&
    a.result === b.result &&
    a.details === b.details &&
    a.messageId === b.messageId &&
    !!a.reviewing === !!b.reviewing
  )
}

/**
 * 工具进度（`toolRuns`）+ 工具块 + 审查叠加 → 工具执行列表（按 `toolRuns` 的次序）。
 *  - pending / running → `running`；done → 工具块 `isError` ? `error` : `done`（结果与 details 取工具块的，
 *    块上还没有 details 时退而用进度上的）；
 *  - `reviewing` = 叠加里有它、且它还在跑；
 *  - `toolRuns` 为空 → `EMPTY_TOOLS`；与 `prev` 逐项相等 → `prev`。
 */
export function deriveToolExecutions(
  view: Pick<SessionView, 'messages' | 'live' | 'toolRuns'>,
  reviewing: Readonly<Record<string, true>> | undefined,
  prev?: ToolExecution[]
): ToolExecution[] {
  const ids = Object.keys(view.toolRuns)
  if (ids.length === 0) return EMPTY_TOOLS
  const blocks = toolBlocksOf(view.messages, view.live, new Set(ids))
  const prevById = new Map((prev ?? []).map((exec) => [exec.toolCallId, exec]))
  let same = prev !== undefined && prev.length === ids.length
  const out = ids.map((toolCallId, index) => {
    const run: ToolRunView = view.toolRuns[toolCallId]
    const hit = blocks.get(toolCallId)
    const block = hit?.block
    const status: ToolExecution['status'] =
      run.status === 'done' ? (block?.isError ? 'error' : 'done') : 'running'
    const details = block?.details ?? run.details
    const exec: ToolExecution = {
      toolCallId,
      toolName: block?.toolName ?? '',
      args: block?.args ?? EMPTY_ARGS,
      status,
      ...(block?.result === undefined ? {} : { result: block.result }),
      ...(details === undefined ? {} : { details }),
      ...(hit === undefined ? {} : { messageId: hit.messageId }),
      ...(status === 'running' && reviewing?.[toolCallId] ? { reviewing: true } : {})
    }
    const before = prevById.get(toolCallId)
    if (before !== undefined && sameExecution(before, exec)) {
      if (prev![index] !== before) same = false
      return before
    }
    same = false
    return exec
  })
  return same ? prev! : out
}

const EMPTY_ARGS: Record<string, unknown> = {}

// ─────────────────────────── 本地错误行（PIN-02） ───────────────────────────

/**
 * 一条只在本端视图里的错误行（MCP 连不上、hook 拒绝……没有条目的 `error` 事件）：挂在它到达那一刻的
 * 最后一条消息后面（`afterId`；列表为空 → null，排在最前）。
 */
export interface LocalErrorRow {
  afterId: string | null
  message: ErrorEventMessage
}

/**
 * 视图消息 + 本地错误行 − 本端关掉的行 → 界面消息列表。没有叠加时交回 `messages` 本身（引用不变）。
 * 锚点不在列表里（被回退掉了）的错误行排到最后。
 */
export function mergeLocalRows(
  messages: ChatMessage[],
  local: readonly LocalErrorRow[] | undefined,
  dismissed: ReadonlySet<string> | undefined
): ChatMessage[] {
  const hasLocal = local !== undefined && local.length > 0
  const hasDismissed = dismissed !== undefined && dismissed.size > 0
  if (!hasLocal && !hasDismissed) return messages
  const after = new Map<string | null, ErrorEventMessage[]>()
  const ids = new Set(messages.map((m) => m.id))
  const orphans: ErrorEventMessage[] = []
  for (const row of local ?? []) {
    if (dismissed?.has(row.message.id)) continue
    if (row.afterId !== null && !ids.has(row.afterId)) {
      orphans.push(row.message)
      continue
    }
    const list = after.get(row.afterId) ?? []
    list.push(row.message)
    after.set(row.afterId, list)
  }
  const out: ChatMessage[] = [...(after.get(null) ?? [])]
  for (const message of messages) {
    if (!dismissed?.has(message.id)) out.push(message)
    const rows = after.get(message.id)
    if (rows) out.push(...rows)
  }
  out.push(...orphans)
  if (out.length === messages.length && out.every((m, i) => m === messages[i])) return messages
  return out
}

// ─────────────────────────── 终答（TTS / 运行收尾） ───────────────────────────

/** 一张卡是不是本轮终答（没有工具块的 assistant 消息，压缩摘要除外） */
export function isFinalAssistant(message: ChatMessage | undefined): message is AssistantMessage {
  return (
    message !== undefined &&
    message.role === 'assistant' &&
    message.type === 'message' &&
    !message.metadata?.isCompactionSummary &&
    !message.blocks.some((block) => block.type === 'tool')
  )
}

/**
 * 视图里发送那一刻还没有的第一条**用户输入**（乐观占位的撤下条件，PIN-17）：不论它从哪来；系统通知 /
 * 指令注入 / 压缩摘要这些 user 形状的行不算
 */
export function firstNewUserMessage(
  messages: readonly ChatMessage[],
  baseline: ReadonlySet<string>
): ChatMessage | undefined {
  for (const message of messages) {
    if (message.role !== 'user' || message.type !== 'text' || baseline.has(message.id)) continue
    const meta = message.metadata
    if (meta?.isSystemNotice || meta?.isInstructionInjection) continue
    return message
  }
  return undefined
}

export type { AgentView, SessionView }
