/**
 * 界面投影（phase 3，P3-02）—— durable 会话的活上下文 + 实时文档 → `SessionView` / `AgentView`。
 *
 * **纯函数**：同样的输入永远给出同样的输出；不读时钟、不读随机数、不改输入、输出里没有一处与输入
 * 共享的对象，输出是严格 JSON（没有 `undefined` 的键）。实时路径（P3-03 的 SessionProjector，每次
 * 发布）与重开路径（一次性快照）调用的是同一个函数、喂的是同一种输入（durable 的 ConversationView），
 * 所以「跑着所见」与「重开所见」逐字段相同。
 *
 * 规则在冻结的旧投影（`legacy/harnessV3/projection.ts`）之上扩展：
 *  - **user**：`pi.user` → UserTextMessage。显示侧车解析到这条条目时用侧车的标记态原文 + inlineTokens
 *    （展开后的 payload 永不出现在界面文字里）；没有侧车时整段是通知块形状（`isSystemNoticeText`）→
 *    `isSystemNotice`。`model: ''`、没有 provider，时间 = `model[0].timestamp`。
 *  - **通知**：`shuvix.notice` 一律 `isSystemNotice`（按条目种类，不看文字、不看 `data.kind`）。
 *  - **assistant**：`pi.assistant` → 一张卡（thinking / text / tool 按模型输出顺序，只有空白的思考丢掉）+
 *    这次调用的 usage。什么都没产出的不留空卡。`stopReason === 'error'` 且带 errorMessage → 一行
 *    error_event（它里面的工具调用不登记）。
 *  - **重试折叠**（Q-P3-06）：一条错误条目 E 在活上下文里还有**同一 `byTaskId`** 的更晚 assistant 条目，
 *    或者 `pi.live.run.taskId === E.byTaskId`（这次运行还在 / 被中断时停在它上面）→ 折叠：不渲染，
 *    计入这个任务的下一张卡（或最终失败的那一行错误、或实时卡）的 `retried {count, lastError}`；
 *    count = 自上一张带提示的卡以来折叠掉的条数。下一条什么都没渲染出来 → 提示继续往后带；
 *    到最后都没有卡 → 丢掉。没有 `byTaskId` 的条目（调度器故障路径写的）从不折叠。
 *  - **工具结果**：`pi.tool-result` 回填到同 toolCallId 的工具块（同一 id 被重用时填最近一次；孤儿结果
 *    丢掉）。`data.diagnostics` 非空且内容的最后一项恰好是 pi 渲染的 `<harness>` 段 → 去掉它；去掉之后
 *    什么都不剩（宿主写的 tool_unavailable / aborted）→ 结果文字 = 诊断消息按行拼接（PIN-08）。
 *    落盘诊断（`spillLocatorOf`）→ `spill.path`（取第一条）。
 *  - **压缩**：`pi.compaction` → `isCompactionSummary` 的一张卡，pi 的外壳剥掉（外壳对不上交出整段）。
 *  - **跳过**：`pi.system`、`pi.reset`（含交接文本）与其它种类。
 *  - **实时**：`live` = `pi.live.generation.message` 的节流中间态（需要 `live.run` 给出 id；没有 usage，
 *    没有签名 / partialJson —— 后者成了 `argsText`）；`toolRuns` = `pi.live.tools`；`run.retry` /
 *    `run.compacting` 只在 busy 时给（PIN-06 / PIN-C2），`live` 与 `toolRuns` 不看运行状态（PIN-11）。
 *  - **队列**：`pi.inbox` 里的 steer / followUp（写入与通知形状的输入都不算用户的）；内联 Token 的发送
 *    有 `queueDisplay` 时把标记渲染成芯片文字。
 *  - **上下文占用**：活上下文里最后一条不是错误的 assistant 条目（中止的也算）的 `total - output`；
 *    它没有 usage、或差值不为正 → null（不往前找）。实时中间态不算。
 *
 * 不依赖 Node / Electron。
 */
import { copyJson } from '@earendil-works/chord'
import type {
  AssistantMessage as PiAssistantMessage,
  ImageContent,
  ToolResultMessage
} from '@earendil-works/pi-ai'
import {
  AssistantEntry,
  CompactionEntry,
  ToolResultEntry,
  UserEntry,
  type EntryRecord,
  type InboxState,
  type LiveState,
  type ToolDiagnostic
} from '@earendil-works/pi-durable'
import {
  INLINE_TOKEN_RE,
  type AssistantBlock,
  type AssistantMessage,
  type AssistantToolBlock,
  type ChatMessage,
  type ImageMeta,
  type RetriedInfo,
  type ToolResultDetails,
  type UsageInfo
} from '@shuvix/chat-protocol/types/chatMessage'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type {
  AgentView,
  LiveCard,
  QueuedInputView,
  RunView,
  RunViewState,
  SessionContextView,
  SessionView,
  ToolRunView
} from '@shuvix/chat-protocol/types/sessionView'
import { isSystemNoticeText } from '@shuvix/chat-protocol/systemNoticeContract'
import { hasThinkingContent } from '@shuvix/chat-protocol/utils/thinking'
import { spillLocatorOf } from '../../toolOutput/spill'
import { toolResultText } from '../../toolResultText'
import { NoticeEntry } from '../docs'
import type { DisplayItem } from './display'
import { firstMessage, tsOf, unwrapCompactionSummary, userText } from './entryText'

// ─────────────────────────── 公共类型 ───────────────────────────

/** SessionView 的身份（PIN-02）：会话 id 与当前分支的对话 id（fork 前缀的条目带着父对话的 id，推不出来） */
export interface SessionProjectionMeta {
  readonly sessionId: string
  readonly conversationId: number
}

/** AgentView 的身份（PIN-24）：派生 agent 的 id、根会话 id、它的对话 id */
export interface AgentProjectionMeta {
  readonly agentId: string
  readonly sessionId: string
  readonly conversationId: number
}

/** 条目 id → 解析到这条 `pi.user` 上的显示侧车（`resolveDisplayItems`） */
export type DisplayByEntry = ReadonlyMap<number, DisplayItem>

/** submission id → 这条排队输入的显示侧车（PIN-17；P3-03 提供） */
export type QueueDisplay = ReadonlyMap<number, DisplayItem>

/** `pi.live` / `pi.inbox` 文档的值（ConversationView.docs 里的 JSON；缺了就是 undefined） */
type LiveInput = Readonly<LiveState> | undefined
type InboxInput = Readonly<InboxState> | undefined

// ─────────────────────────── 小工具 ───────────────────────────

/** pi 的 `renderDiagnostics`（`harness/tool.js`，未导出）的逐字节复刻：工具结果末尾的诊断段 */
export function renderHarnessDiagnostics(diagnostics: readonly ToolDiagnostic[]): string {
  return `<harness>\n${diagnostics.map((d) => `[${d.severity}] ${d.message}`).join('\n')}\n</harness>`
}

const SEVERITIES: ReadonlySet<unknown> = new Set(['info', 'warn', 'error'])
const SLOT_STATUSES: ReadonlySet<unknown> = new Set(['pending', 'running', 'done'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 拷成一份与输入不共享任何对象的严格 JSON（丢掉 undefined 的键）；不是 JSON → undefined */
function jsonCopy<T>(value: unknown): T | undefined {
  if (value === undefined) return undefined
  try {
    return copyJson(value, { omitUndefinedProperties: true }) as T
  } catch {
    return undefined
  }
}

/** user 内容里的图片 → 图片元数据（与冻结投影同形）；没有 → undefined */
function imagesOf(content: unknown): ImageMeta[] | undefined {
  if (!Array.isArray(content)) return undefined
  const images: ImageMeta[] = []
  for (const part of content as unknown[]) {
    if (!isRecord(part) || part.type !== 'image') continue
    const { data, mimeType } = part as Partial<ImageContent>
    images.push({
      ...(typeof data === 'string' ? { data } : {}),
      mimeType: typeof mimeType === 'string' ? mimeType : ''
    })
  }
  return images.length > 0 ? images : undefined
}

/** 一次调用的用量（与冻结投影的 `usageOf` 同口径：total 缺省 = input + output） */
function usageOf(message: PiAssistantMessage): UsageInfo | undefined {
  const usage = message.usage as Partial<PiAssistantMessage['usage']> | undefined
  if (!isRecord(usage)) return undefined
  const input = typeof usage.input === 'number' ? usage.input : 0
  const output = typeof usage.output === 'number' ? usage.output : 0
  const total = (typeof usage.totalTokens === 'number' && usage.totalTokens) || input + output
  return {
    input,
    output,
    ...(typeof usage.cacheRead === 'number' ? { cacheRead: usage.cacheRead } : {}),
    ...(typeof usage.cacheWrite === 'number' ? { cacheWrite: usage.cacheWrite } : {}),
    total
  }
}

/** 结构化诊断（`data.diagnostics`）；缺失或形状不对 → undefined（不剥、不取落盘位置） */
function diagnosticsOf(data: unknown): ToolDiagnostic[] | undefined {
  if (!isRecord(data) || !Array.isArray(data.diagnostics)) return undefined
  const list = data.diagnostics as unknown[]
  for (const item of list) {
    if (!isRecord(item) || !SEVERITIES.has(item.severity) || typeof item.message !== 'string') {
      return undefined
    }
  }
  return list as ToolDiagnostic[]
}

const modelOf = (message: { model?: unknown }): string =>
  typeof message.model === 'string' ? message.model : ''

const providerOf = (message: { provider?: unknown }): { provider?: string } =>
  typeof message.provider === 'string' && message.provider.length > 0
    ? { provider: message.provider }
    : {}

const retriedCopy = (hint: RetriedInfo): RetriedInfo => ({
  count: hint.count,
  lastError: hint.lastError
})

interface ConvertedBlocks {
  readonly blocks: AssistantBlock[]
  readonly text: string
  /** toolCallId → 还没解析完的参数原文（只有实时中间态有） */
  readonly argsText: Map<string, string>
}

/** assistant 内容 → UI 块（按原序；只有空白的思考丢掉；签名 / partialJson 不进块） */
function convertBlocks(
  content: unknown,
  onTool?: (block: AssistantToolBlock) => void
): ConvertedBlocks {
  const blocks: AssistantBlock[] = []
  const texts: string[] = []
  const argsText = new Map<string, string>()
  for (const block of Array.isArray(content) ? (content as unknown[]) : []) {
    if (!isRecord(block)) continue
    if (block.type === 'thinking') {
      const thinking = typeof block.thinking === 'string' ? block.thinking : ''
      if (hasThinkingContent(thinking)) blocks.push({ type: 'thinking', text: thinking })
    } else if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : ''
      blocks.push({ type: 'text', text })
      texts.push(text)
    } else if (block.type === 'toolCall') {
      const toolCallId = typeof block.id === 'string' ? block.id : ''
      const args = isRecord(block.arguments)
        ? jsonCopy<Record<string, unknown>>(block.arguments)
        : undefined
      const tool: AssistantToolBlock = {
        type: 'tool',
        toolCallId,
        toolName: typeof block.name === 'string' ? block.name : '',
        ...(args === undefined ? {} : { args })
      }
      blocks.push(tool)
      if (typeof block.partialJson === 'string') argsText.set(toolCallId, block.partialJson)
      onTool?.(tool)
    }
  }
  return { blocks, text: texts.join(''), argsText }
}

/** 一条 user 消息的显示文本（侧车优先）里的标记 → 芯片文字；有标记找不到 Token → undefined */
function renderInlineMarkers(display: DisplayItem): string | undefined {
  let missing = false
  const text = display.content.replace(new RegExp(INLINE_TOKEN_RE.source, 'g'), (marker, uid) => {
    const token = (display.tokens as Record<string, unknown>)[uid as string]
    const shown = isRecord(token) ? token.displayText : undefined
    if (typeof shown !== 'string') {
      missing = true
      return marker
    }
    return shown
  })
  return missing ? undefined : text
}

// ─────────────────────────── 核心 ───────────────────────────

interface ProjectedCore {
  messages: ChatMessage[]
  live: LiveCard | null
  toolRuns: Record<string, ToolRunView>
  run: RunView
  context: SessionContextView
}

function liveTaskOf(live: LiveInput): number | undefined {
  const taskId = isRecord(live) && isRecord(live.run) ? live.run.taskId : undefined
  return typeof taskId === 'number' ? taskId : undefined
}

function projectCore(
  sessionId: string,
  entries: readonly EntryRecord[],
  live: LiveInput,
  display: DisplayByEntry,
  runState: RunViewState
): ProjectedCore {
  const runTask = liveTaskOf(live)

  // 每个任务最后一条 assistant 条目的位置：更早的错误条目据此折叠
  const lastOfTask = new Map<number, number>()
  entries.forEach((entry, index) => {
    if (entry.kind === AssistantEntry.kind && entry.byTaskId !== undefined) {
      lastOfTask.set(entry.byTaskId, index)
    }
  })

  const messages: ChatMessage[] = []
  /** toolCallId → 等待回填的工具块（同一 id 重用时后来的覆盖先来的） */
  const pendingTools = new Map<string, AssistantToolBlock>()
  /** 任务 → 还没交给任何一张卡的折叠计数 */
  const pendingRetries = new Map<number, RetriedInfo>()
  /** 上下文占用的来源：最后一条不是错误的 assistant 消息 */
  let lastCounted: PiAssistantMessage | undefined

  entries.forEach((entry, index) => {
    const id = String(entry.id)
    switch (entry.kind) {
      case UserEntry.kind: {
        const message = firstMessage(entry, 'user')
        if (message === undefined) return
        const resolved = display.get(entry.id)
        const images = imagesOf(message.content)
        const content = resolved !== undefined ? resolved.content : userText(message.content)
        const tokens =
          resolved !== undefined
            ? jsonCopy<Record<string, never>>(resolved.tokens)
            : undefined
        const notice = resolved === undefined && isSystemNoticeText(content)
        messages.push({
          id,
          sessionId,
          role: 'user',
          type: 'text',
          content,
          model: '',
          createdAt: tsOf(message),
          metadata: {
            ...(images === undefined ? {} : { images }),
            ...(tokens === undefined ? {} : { inlineTokens: tokens }),
            ...(notice ? { isSystemNotice: true } : {})
          }
        })
        return
      }
      case NoticeEntry.kind: {
        const message = firstMessage(entry, 'user')
        if (message === undefined) return
        messages.push({
          id,
          sessionId,
          role: 'user',
          type: 'text',
          content: userText(message.content),
          model: '',
          createdAt: tsOf(message),
          metadata: { isSystemNotice: true }
        })
        return
      }
      case AssistantEntry.kind: {
        const message = firstMessage(entry, 'assistant')
        if (message === undefined) return
        const task = entry.byTaskId
        const isError = message.stopReason === 'error'
        if (!isError) lastCounted = message
        // 折叠：同一任务后面还有 assistant 条目，或这次运行还停在这个任务上
        if (
          isError &&
          task !== undefined &&
          ((lastOfTask.get(task) ?? -1) > index || task === runTask)
        ) {
          const before = pendingRetries.get(task)
          pendingRetries.set(task, {
            count: (before?.count ?? 0) + 1,
            lastError: typeof message.errorMessage === 'string' ? message.errorMessage : ''
          })
          return
        }
        const hint = task === undefined ? undefined : pendingRetries.get(task)
        const projected = projectAssistant(id, sessionId, message, pendingTools, hint)
        if (projected === undefined) return // 空卡：提示留给这个任务的下一张（PIN-18）
        if (hint !== undefined && task !== undefined) pendingRetries.delete(task)
        messages.push(projected)
        return
      }
      case ToolResultEntry.kind: {
        const message = firstMessage(entry, 'toolResult')
        if (message === undefined) return
        fillToolResult(message, entry.data, pendingTools)
        return
      }
      case CompactionEntry.kind: {
        const message = firstMessage(entry, 'user')
        const text = unwrapCompactionSummary(userText(message?.content))
        messages.push({
          id,
          sessionId,
          role: 'assistant',
          type: 'message',
          blocks: [{ type: 'text', text }],
          content: text,
          model: '',
          createdAt: tsOf(message),
          metadata: { isCompactionSummary: true }
        })
        return
      }
      default:
        // pi.system / pi.reset（含交接文本）/ 宿主自定义种类：不渲染
        return
    }
  })

  const liveHint = runTask === undefined ? undefined : pendingRetries.get(runTask)
  return {
    messages,
    live: liveCardOf(sessionId, live, runTask, liveHint),
    toolRuns: toolRunsOf(live),
    run: runOf(live, runState),
    context: { usedTokens: usedTokensOf(lastCounted) }
  }
}

function projectAssistant(
  id: string,
  sessionId: string,
  message: PiAssistantMessage,
  pendingTools: Map<string, AssistantToolBlock>,
  hint: RetriedInfo | undefined
): ChatMessage | undefined {
  const model = modelOf(message)
  const createdAt = tsOf(message)

  // 失败轮：整条塌成一行错误（它里面的工具调用不登记，结果成了孤儿）
  if (message.stopReason === 'error' && message.errorMessage) {
    return {
      id,
      sessionId,
      role: 'system_notify',
      type: 'error_event',
      content: message.errorMessage,
      model,
      ...providerOf(message),
      createdAt,
      metadata: hint === undefined ? null : { retried: retriedCopy(hint) }
    }
  }

  const registered: AssistantToolBlock[] = []
  const { blocks, text } = convertBlocks(message.content, (tool) => registered.push(tool))
  const rawImages = (message as PiAssistantMessage & { _images?: unknown })._images
  const images = Array.isArray(rawImages) ? jsonCopy<ImageMeta[]>(rawImages) : undefined
  // 什么都没产出（如首 token 前被中止）：不留空卡，调用也不登记
  if (blocks.length === 0 && images === undefined) return undefined
  for (const tool of registered) pendingTools.set(tool.toolCallId, tool)

  const usage = usageOf(message)
  const card: AssistantMessage = {
    id,
    sessionId,
    role: 'assistant',
    type: 'message',
    blocks,
    content: text,
    model,
    ...providerOf(message),
    createdAt,
    metadata: {
      ...(usage === undefined ? {} : { usage }),
      ...(images === undefined ? {} : { images }),
      ...(hint === undefined ? {} : { retried: retriedCopy(hint) })
    }
  }
  return card
}

function fillToolResult(
  message: ToolResultMessage,
  data: unknown,
  pendingTools: Map<string, AssistantToolBlock>
): void {
  const target = pendingTools.get(message.toolCallId)
  if (target === undefined) return // 孤儿结果（调用在压缩切点之前 / 在失败轮里）
  pendingTools.delete(message.toolCallId)

  const diagnostics = diagnosticsOf(data)
  let content: unknown = message.content
  if (diagnostics !== undefined && diagnostics.length > 0 && Array.isArray(content)) {
    const last = content.at(-1) as unknown
    if (
      isRecord(last) &&
      last.type === 'text' &&
      last.text === renderHarnessDiagnostics(diagnostics)
    ) {
      content = content.slice(0, -1)
    }
  }
  const remaining = Array.isArray(content) ? content.length : content == null ? 0 : 1
  target.result =
    diagnostics !== undefined && diagnostics.length > 0 && remaining === 0
      ? diagnostics.map((d) => d.message).join('\n')
      : toolResultText(content as Parameters<typeof toolResultText>[0])
  if (message.isError === true) target.isError = true
  const details = (message as { details?: unknown }).details
  if (isRecord(details)) {
    const copied = jsonCopy<ToolResultDetails>(details)
    if (copied !== undefined) target.details = copied
  }
  for (const diagnostic of diagnostics ?? []) {
    const path = spillLocatorOf(diagnostic)
    if (path !== undefined) {
      target.spill = { path }
      break
    }
  }
}

function liveCardOf(
  sessionId: string,
  live: LiveInput,
  runTask: number | undefined,
  hint: RetriedInfo | undefined
): LiveCard | null {
  if (runTask === undefined || !isRecord(live) || !isRecord(live.generation)) return null
  const partial = live.generation.message
  if (!isRecord(partial)) return null
  const { blocks, text, argsText } = convertBlocks(partial.content)
  if (blocks.length === 0) return null
  const id = `live:${runTask}`
  const message: AssistantMessage = {
    id,
    sessionId,
    role: 'assistant',
    type: 'message',
    blocks,
    content: text,
    model: modelOf(partial),
    ...providerOf(partial),
    createdAt: tsOf(partial),
    // 中间态的用量不完整，不给（PIN-12）；折叠的重试提示先挂上，落盘时卡片不闪（PIN-07）
    metadata: hint === undefined ? {} : { retried: retriedCopy(hint) }
  }
  return {
    id,
    message,
    ...(argsText.size === 0 ? {} : { argsText: Object.fromEntries(argsText) })
  }
}

function toolRunsOf(live: LiveInput): Record<string, ToolRunView> {
  const runs = new Map<string, ToolRunView>()
  const slots = isRecord(live) && Array.isArray(live.tools) ? (live.tools as unknown[]) : []
  for (const slot of slots) {
    if (!isRecord(slot) || typeof slot.callId !== 'string' || !SLOT_STATUSES.has(slot.status)) {
      continue
    }
    const details = isRecord(slot.details) ? jsonCopy<ToolResultDetails>(slot.details) : undefined
    // 同一 callId 出现两次：后面的胜出（PIN-14）
    runs.delete(slot.callId)
    runs.set(slot.callId, {
      status: slot.status as ToolRunView['status'],
      ...(typeof slot.output === 'string' ? { output: slot.output } : {}),
      ...(details === undefined ? {} : { details })
    })
  }
  return Object.fromEntries(runs)
}

function runOf(live: LiveInput, runState: RunViewState): RunView {
  const run: RunView = { state: runState }
  // 倒计时一类的字段只在 busy 时给：停着的会话上的倒计时是假的（PIN-06 / PIN-C2）
  if (runState !== 'busy' || !isRecord(live)) return run
  const generation = live.generation
  if (isRecord(generation) && isRecord(generation.retry)) {
    const { at, error } = generation.retry
    if (typeof at === 'number') {
      run.retry = {
        attempt: typeof generation.attempt === 'number' ? generation.attempt : 0,
        at,
        error: typeof error === 'string' ? error : ''
      }
    }
  }
  const statuses = (Array.isArray(live.compactions) ? (live.compactions as unknown[]) : []).filter(
    isRecord
  )
  // 有在挡着生成的就显示它，否则第一个（任务 id 次序，PIN-15）
  const shown = statuses.find((status) => status.blocking === true) ?? statuses[0]
  if (shown !== undefined) {
    const retryAt = isRecord(shown.retry) ? shown.retry.at : undefined
    run.compacting = {
      reason: typeof shown.reason === 'string' ? shown.reason : '',
      blocking: shown.blocking === true,
      attempt: typeof shown.attempt === 'number' ? shown.attempt : 0,
      ...(typeof retryAt === 'number' ? { retryAt } : {})
    }
  }
  return run
}

function usedTokensOf(message: PiAssistantMessage | undefined): number | null {
  if (message === undefined) return null
  const usage = usageOf(message)
  if (usage === undefined) return null
  const used = usage.total - usage.output
  return used > 0 ? used : null
}

function queueOf(inbox: InboxInput, queueDisplay: QueueDisplay | undefined): QueuedInputView[] {
  const items = isRecord(inbox) && Array.isArray(inbox.items) ? (inbox.items as unknown[]) : []
  const queue: QueuedInputView[] = []
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== 'number') continue
    if (item.mode !== 'steer' && item.mode !== 'followUp') continue // 写入（通知）不是用户的
    const content = item.content as Parameters<typeof userText>[0]
    const modelText = userText(content)
    const imageCount = Array.isArray(content)
      ? (content as unknown[]).filter((part) => isRecord(part) && part.type === 'image').length
      : 0
    const display = queueDisplay?.get(item.id)
    let text: string
    if (display !== undefined) {
      text = renderInlineMarkers(display) ?? modelText
    } else {
      if (isSystemNoticeText(modelText)) continue // 通知形状的插话是系统写的（PIN-16）
      text = modelText
    }
    queue.push({ submissionId: item.id, mode: item.mode, text, imageCount })
  }
  return queue
}

function asksOf(asks: readonly InputRequest[]): InputRequest[] {
  const out: InputRequest[] = []
  for (const ask of asks) {
    const copied = jsonCopy<InputRequest>(ask)
    if (copied !== undefined) out.push(copied)
  }
  return out
}

// ─────────────────────────── 入口 ───────────────────────────

/**
 * 一条 durable 会话当前分支的视图。
 *
 * @param meta      会话 id 与当前对话 id（PIN-02）
 * @param entries   活上下文（`ConversationView.entries`：头标记 + 它之后的非头条目）
 * @param live      `pi.live` 文档（`ConversationView.docs['pi.live']`；没有 → undefined）
 * @param inbox     `pi.inbox` 文档（同上）
 * @param display   条目 id → 显示侧车（`resolveDisplayItems`）
 * @param asks      挂着的询问（按出现次序）
 * @param runState  会话的运行状态（`DurableSession.runState`）
 * @param queueDisplay submission id → 排队输入的显示侧车（可选，PIN-17）
 */
export function projectSessionView(
  meta: SessionProjectionMeta,
  entries: readonly EntryRecord[],
  live: LiveInput,
  inbox: InboxInput,
  display: DisplayByEntry,
  asks: readonly InputRequest[],
  runState: RunViewState,
  queueDisplay?: QueueDisplay
): SessionView {
  const core = projectCore(meta.sessionId, entries, live, display, runState)
  return {
    v: 1,
    sessionId: meta.sessionId,
    source: 'durable',
    capabilities: { send: true, rollback: true, continue: true },
    conversationId: meta.conversationId,
    messages: core.messages,
    live: core.live,
    toolRuns: core.toolRuns,
    run: core.run,
    queue: queueOf(inbox, queueDisplay),
    asks: asksOf(asks),
    context: core.context
  }
}

/**
 * 一个派生 agent 的对话的视图（子 agent 面板）：与 SessionView 同一套规则，没有队列与询问。
 * `runState` 由调用方按这个对话算（P3-03 的 AgentProjector），不是根会话的状态。
 */
export function projectAgentView(
  meta: AgentProjectionMeta,
  entries: readonly EntryRecord[],
  live: LiveInput,
  display: DisplayByEntry,
  runState: RunViewState
): AgentView {
  const core = projectCore(meta.sessionId, entries, live, display, runState)
  return {
    v: 1,
    agentId: meta.agentId,
    sessionId: meta.sessionId,
    conversationId: meta.conversationId,
    messages: core.messages,
    live: core.live,
    toolRuns: core.toolRuns,
    run: core.run,
    context: core.context
  }
}
