/**
 * 转写摘要（P2-14）—— durable 会话里「人写了什么、agent 说了什么」的只读小读者。
 *
 * 两个桌面消费者读它：自动审查的输入（`permission.request` 的 userMessages / delegatedTasks）与自动起标题
 * 的会话事实（`session.turn-completed` 的计数与 recentText）。界面投影（entries → ChatMessage）是 phase 3
 * 的事；这里只交出它俩要的那一小份，口径对齐旧会话的冻结投影（`legacy/harnessV3/projection.ts`）：
 *
 *  - **范围**：当前对话（`SessionStateDoc.currentConversation`，回退 fork 之后的那条分支）的活上下文 ——
 *    `Conversation.context().entries`（头标记 + 它之后的非头条目；压缩掉的历史不在其中，与旧路径的
 *    压缩过滤一致）。同一存储里的其它对话（派生 agent、titler、审查员……）一概不读。
 *  - **user**：`pi.user` 条目；文本 = 文本块按 '' 拼接（图片丢掉），逐字、不修剪、空串照样交出。
 *    显示侧车（`DisplayDoc[requestId]`，内联 Token 的标记态原文）解析到这条条目上时用侧车的 content ——
 *    展开后的 payload（命令 / 文件全文）不是人打的字，也是注入面，绝不交出。整段正文只由通知块组成
 *    （steer / 自动续跑写下的通知，`isSystemNoticeText`）→ 不算人写的；侧车解析到了就不再按形状判
 *    （冻结投影同理）。
 *  - **通知**：`shuvix.notice` 条目一律不交出（不管 `data.kind`、不管文字）—— 系统写的话不能记成人说的。
 *  - **assistant**：`pi.assistant` 的文本块按 '' 拼接（思考永不交出）。`stopReason === 'error'` 且带
 *    errorMessage 的条目整条不算（冻结投影里它是一条错误事件），它里面的工具调用也不配对；什么都没产出的
 *    （没有正文 / 有字的思考 / 工具调用）不留空项。
 *  - **ask**：内置 ask 工具（名字恰为 `ask`，第三方工具恒带 `mcp__` 前缀）的调用与它的结果配对，结果不是
 *    错误（取消 / 中止不算回答）。回答 = `toolResultText(content)`（与冻结投影一字不差），问题 =
 *    `arguments.question`（不是字符串 → ''）。项紧跟在它那条 assistant 之后、按调用次序，时间戳取那条
 *    assistant 的；同一 id 被 provider 重用时配给最近一次还没配上的调用；没结果的（挂着的卡片）不交出，
 *    孤儿结果（调用在压缩切点之前）丢掉。
 *  - **压缩**：`pi.compaction` 头标记 → assistant 项（`compaction: true`，排在最前），文本剥掉 pi 的固定
 *    外壳；外壳对不上就交出整段模型文本。`pi.reset` 及它带的交接文本、`pi.system`、其它种类都不交出。
 *  - **时间戳**：条目本身没有时间，取 `model[0].timestamp`（user = 放置时钟，assistant = provider 自己的，
 *    ask 回答 = 它那条 assistant 的）；不是有限数 → 0。
 *
 * 文本一律**不截断**：上限（每条 1500 字、首条 + 最近 8 条、尾部 1000 字）只在两个消费者里各定义一次。
 *
 * **信任边界**（PIN-11）：`pi.user` 减去通知形状就当作人写的。当前对话里由机器写下的 `pi.user`（例如
 * onYield 的 continue 续写）会被当成人说的 —— ShuviX 今天不在当前对话里写这种条目（Q-P2-15 的催促进的是
 * 子对话）。排在收件箱里、还没放下的输入不算（与旧路径一致）。
 *
 * **只读**：只用 `currentConversation()`、`Conversation.context()`、`snapshot` 与一个只读提交（按 requestId
 * 找 submission）—— 不开启调度器、不建 agent、不送达推迟的通知、不写任何东西（只读提交不产生发布），
 * 被中断的会话照样停着。不依赖 Node / Electron。
 */
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolResultMessage,
  UserMessage
} from '@earendil-works/pi-ai'
import {
  AssistantEntry,
  CompactionEntry,
  ToolResultEntry,
  UserEntry,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Harness
} from '@earendil-works/pi-durable'
import { isSystemNoticeText } from '@shuvix/chat-protocol/systemNoticeContract'
import { hasThinkingContent } from '@shuvix/chat-protocol/utils/thinking'
import { toolResultText } from '../toolResultText'
import { backgroundContext as BG, isClosedError } from './context'
import { DisplayDoc } from './docs'
import { SessionClosedError, type DurableSession } from './durableSession'

// ─────────────────────────── 公共类型 ───────────────────────────

/** 人发的一条消息（显示侧车解析到了就是侧车的标记态原文） */
export interface TranscriptUserItem {
  readonly kind: 'user'
  readonly ts: number
  readonly text: string
}

/** agent 的一条正文（一次 LLM 调用的文本块拼接）；`compaction` = 压缩摘要（剥掉外壳） */
export interface TranscriptAssistantItem {
  readonly kind: 'assistant'
  readonly ts: number
  readonly text: string
  readonly compaction?: true
}

/** 人对内置 ask 工具的一次回答（连同问题）；时间戳是提问那条 assistant 的 */
export interface TranscriptAskItem {
  readonly kind: 'ask'
  readonly ts: number
  readonly question: string
  readonly answer: string
}

export type TranscriptDigestItem = TranscriptUserItem | TranscriptAssistantItem | TranscriptAskItem

export interface TranscriptDigest {
  /** 活上下文里的项，旧 → 新（ContextView 次序） */
  readonly items: TranscriptDigestItem[]
}

/** 读摘要要用到的那一点会话面 */
export type TranscriptDigestSession = Pick<
  DurableSession,
  'sessionId' | 'currentConversation' | 'harness'
>

// ─────────────────────────── 常量 ───────────────────────────

/** 内置 ask 工具的名字（第三方工具恒带 `mcp__` 前缀，撞不上） */
const ASK_TOOL_NAME = 'ask'

/**
 * pi 的压缩摘要外壳（pi-durable `harness/compaction.js` 的 SUMMARY_PREFIX / SUFFIX，未导出）：
 * `pi.compaction` 的 user 文本 = 前缀 + 摘要 + 后缀。
 */
export const COMPACTION_SUMMARY_PREFIX =
  'The conversation history before this point was compacted into the following summary:\n\n<summary>\n'
export const COMPACTION_SUMMARY_SUFFIX = '\n</summary>'

// ─────────────────────────── 纯核心 ───────────────────────────

/** 不是有限数的时间戳 → 0 */
function tsOf(message: { readonly timestamp?: unknown } | undefined): number {
  const ts = message?.timestamp
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : 0
}

/** user 内容 → 纯文本（文本块按 '' 拼接，图片丢掉） */
function userText(content: UserMessage['content'] | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is TextContent => part?.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}

/** 条目的第一条模型消息（角色对不上 → undefined） */
function firstMessage<R extends Message['role']>(
  entry: EntryRecord,
  role: R
): Extract<Message, { role: R }> | undefined {
  const message = entry.model?.[0]
  return message?.role === role ? (message as Extract<Message, { role: R }>) : undefined
}

/** 压缩摘要去壳：前后缀都对得上才剥，否则原样交出 */
export function unwrapCompactionSummary(text: string): string {
  if (
    text.length >= COMPACTION_SUMMARY_PREFIX.length + COMPACTION_SUMMARY_SUFFIX.length &&
    text.startsWith(COMPACTION_SUMMARY_PREFIX) &&
    text.endsWith(COMPACTION_SUMMARY_SUFFIX)
  ) {
    return text.slice(
      COMPACTION_SUMMARY_PREFIX.length,
      text.length - COMPACTION_SUMMARY_SUFFIX.length
    )
  }
  return text
}

/**
 * 显示侧车（`DisplayDoc.items[requestId]`）的标记态原文；形状不对（content 不是字符串 / 没有 tokens 字典）
 * → undefined，调用方退回模型文本。判据与冻结投影的 `asInlineTokensSidecar` 相同。
 */
export function displayContentOf(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const { content, tokens } = item as { content?: unknown; tokens?: unknown }
  if (typeof content !== 'string') return undefined
  if (typeof tokens !== 'object' || tokens === null) return undefined
  return content
}

/** 一次还在等结果的 ask 调用：先占住它在输出里的位置（提问那条 assistant 之后、按调用次序） */
interface PendingAsk {
  readonly kind: 'pending-ask'
  readonly ts: number
  readonly question: string
  answer?: string
}

/**
 * 纯核心：活上下文条目（`ContextView.entries` 次序）→ 摘要项。
 *
 * @param displayTexts 条目 id → 显示侧车的标记态原文（`readTranscriptDigest` 解析好的；缺省 = 没有侧车）
 */
export function digestEntries(
  entries: readonly EntryRecord[],
  displayTexts: ReadonlyMap<EntryId, string> = new Map()
): TranscriptDigestItem[] {
  const out: (TranscriptDigestItem | PendingAsk)[] = []
  /** toolCallId → 最近一次还没配上结果的调用（不是 ask 的记 null：它配上结果也不产出） */
  const calls = new Map<string, PendingAsk | null>()

  for (const entry of entries) {
    switch (entry.kind) {
      case UserEntry.kind: {
        const message = firstMessage(entry, 'user')
        if (message === undefined) break
        const display = displayTexts.get(entry.id)
        if (display !== undefined) {
          out.push({ kind: 'user', ts: tsOf(message), text: display })
          break
        }
        const text = userText(message.content)
        if (isSystemNoticeText(text)) break
        out.push({ kind: 'user', ts: tsOf(message), text })
        break
      }
      case AssistantEntry.kind: {
        const message = firstMessage(entry, 'assistant')
        if (message === undefined) break
        pushAssistant(out, calls, message)
        break
      }
      case ToolResultEntry.kind: {
        const message = firstMessage(entry, 'toolResult')
        if (message === undefined) break
        settleCall(calls, message)
        break
      }
      case CompactionEntry.kind: {
        const message = firstMessage(entry, 'user')
        out.push({
          kind: 'assistant',
          ts: tsOf(message),
          text: unwrapCompactionSummary(userText(message?.content)),
          compaction: true
        })
        break
      }
      default:
        // shuvix.notice / pi.reset（含交接文本）/ pi.system / 宿主自定义种类：都不是人写的、也不是 agent 的正文
        break
    }
  }

  const items: TranscriptDigestItem[] = []
  for (const item of out) {
    if (item.kind !== 'pending-ask') items.push(item)
    else if (item.answer !== undefined) {
      items.push({ kind: 'ask', ts: item.ts, question: item.question, answer: item.answer })
    }
  }
  return items
}

function pushAssistant(
  out: (TranscriptDigestItem | PendingAsk)[],
  calls: Map<string, PendingAsk | null>,
  message: AssistantMessage
): void {
  // 失败轮（冻结投影里的错误事件）：整条不算，里面的调用也不登记 —— 它们的结果成了孤儿
  if (message.stopReason === 'error' && message.errorMessage) return
  const ts = tsOf(message)
  let text = ''
  let produced = false
  const asks: PendingAsk[] = []
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block?.type === 'text') {
      text += block.text ?? ''
      produced = true
    } else if (block?.type === 'thinking') {
      if (hasThinkingContent(block.thinking)) produced = true
    } else if (block?.type === 'toolCall') {
      produced = true
      if (block.name === ASK_TOOL_NAME) {
        const args = block.arguments as { question?: unknown } | undefined
        const ask: PendingAsk = {
          kind: 'pending-ask',
          ts,
          question: typeof args?.question === 'string' ? args.question : ''
        }
        asks.push(ask)
        calls.set(block.id, ask)
      } else {
        calls.set(block.id, null)
      }
    }
  }
  // 什么都没产出（如首 token 前被中止）：不留空项
  if (!produced) return
  out.push({ kind: 'assistant', ts, text }, ...asks)
}

function settleCall(calls: Map<string, PendingAsk | null>, message: ToolResultMessage): void {
  if (!calls.has(message.toolCallId)) return // 孤儿结果（调用在压缩切点之前 / 在失败轮里）
  const ask = calls.get(message.toolCallId)
  calls.delete(message.toolCallId)
  // 取消 / 中止 / 出错的 ask 不算回答
  if (ask && !message.isError) {
    ask.answer = toolResultText(
      message.content as ReadonlyArray<TextContent | ImageContent> | undefined
    )
  }
}

// ─────────────────────────── 读会话 ───────────────────────────

/**
 * 显示侧车 → 它落到的条目（PIN-04）：当前对话的 `DisplayDoc`（fork 带着 fork 点时的副本，继承的前缀里
 * 那几份侧车也在）逐项按 requestId 找 submission —— submission 归它提交时所在的对话，所以在活上下文里
 * 每个出现过 `pi.user` 的对话（fork 的祖先链）里各找一次，`record.entry` 正是活上下文里的那条 user 条目
 * 才算数。没有 submission / 还没放下的 / 放下的条目不在活上下文里（压缩切点之前、别的分支）→ 忽略；
 * 侧车形状不对 → 忽略（那条条目退回模型文本）。按 requestId 找只能在提交里做：这是一个只读提交。
 */
async function resolveDisplayTexts(
  harness: Harness,
  conversationId: ConversationId,
  entries: readonly EntryRecord[]
): Promise<Map<EntryId, string>> {
  const resolved = new Map<EntryId, string>()
  const doc = await harness.snapshot(DisplayDoc, conversationId, BG)
  const items: [string, string][] = []
  for (const [requestId, item] of Object.entries(doc?.items ?? {})) {
    const content = displayContentOf(item)
    if (content !== undefined) items.push([requestId, content])
  }
  if (items.length === 0) return resolved
  const users = new Map<ConversationId, Set<EntryId>>()
  for (const entry of entries) {
    if (entry.kind !== UserEntry.kind) continue
    let ids = users.get(entry.conversationId)
    if (ids === undefined) {
      ids = new Set()
      users.set(entry.conversationId, ids)
    }
    ids.add(entry.id)
  }
  if (users.size === 0) return resolved
  await harness.commit(async (tx) => {
    for (const [requestId, content] of items) {
      for (const [owner, ids] of users) {
        const record = await tx.submissionByRequest(owner, requestId)
        if (record?.entry !== undefined && ids.has(record.entry)) {
          resolved.set(record.entry, content)
          break
        }
      }
    }
  }, BG)
  return resolved
}

/**
 * 读一条打开着的 durable 会话的转写摘要（当前对话的活上下文）。只读：不开启调度器、不建 agent、不写。
 * 句柄已关停 → `SessionClosedError`（从不悄悄重开）；其余失败原样抛出。
 */
export async function readTranscriptDigest(
  session: TranscriptDigestSession
): Promise<TranscriptDigest> {
  try {
    const conversation = await session.currentConversation()
    const view = await conversation.context(BG)
    const displayTexts = await resolveDisplayTexts(session.harness, conversation.id, view.entries)
    return { items: digestEntries(view.entries, displayTexts) }
  } catch (error) {
    if (isClosedError(error)) throw new SessionClosedError(session.sessionId)
    throw error
  }
}
