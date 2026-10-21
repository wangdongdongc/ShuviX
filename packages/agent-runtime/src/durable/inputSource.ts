/**
 * 用户输入的来源（docs/sub-session-design.md §19.7）—— 一条 `pi.user` 不是人亲手打的时候，它是谁写的。
 *
 * 来源是驱动它的那条会话：父会话代用户发进子会话的消息（`kind: 'parent-session'`），或经会话权限表被授权的别的
 * 会话发进来的消息（`kind: 'session'`）—— `prompt-session` 与 `steer-session` 都算（`answer-session` 之后的那一轮
 * 不算，那是 ask 的结果）。来源在发送时随提交写进 `SourceDoc[requestId]`（`UserSendOptions.source`
 * / `AdmitOptions.source`），读的时候按 requestId 找 submission、再落到活上下文里的那条条目上 —— 与显示侧车
 * 同一套解析（`projection/display.ts`），因为 pi 的提交只能按 requestId 正查、不能从条目反查。
 *
 * 「没有记录」不等于「人打的」：升级之前父会话发的消息同样没有记录。谁写的由 `authorsOf` 判（§19.7 的口径：
 * 第一条有记录的消息之后、没有记录的才算人打的），审查、大纲、`user-intervened` 共用这一份。文档里有这一项
 * 却认不出形状（更新的版本写的新种类、坏数据）→ **当作有记录**（失败闭合，与 ask 的 `answeredBy` 同一方向：
 * 危险的是把别人的话记成人的）。只读：一个只读提交，不开启调度器、不建 agent、不写。不依赖 Node / Electron。
 */
import type { ConversationId, EntryId, EntryRecord, Harness } from '@earendil-works/pi-durable'
import { UserEntry } from '@earendil-works/pi-durable'
import type { DrivingSessionRef } from '@shuvix/chat-protocol/types/inputRequest'
import { backgroundContext as BG, isClosedError } from './context'
import { SourceDoc } from './docs'
import { SessionClosedError, type DurableSession } from './durableSession'

/** 一条输入的来源（驱动它的会话：父会话或被授权的别的会话） */
export type InputSource = DrivingSessionRef

/**
 * 侧车的形状判别：`{kind:'parent-session' | 'session', sessionId}`（title 可选）；否则 undefined（解析时按
 * 「认不出」处理）
 */
export function inputSourceOf(item: unknown): InputSource | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const { kind, sessionId, title } = item as {
    kind?: unknown
    sessionId?: unknown
    title?: unknown
  }
  if (kind !== 'parent-session' && kind !== 'session') return undefined
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  return typeof title === 'string' ? { kind, sessionId, title } : { kind, sessionId }
}

/**
 * 来源 → 它落到的条目：当前对话的 `SourceDoc` 逐项按 requestId 找 submission（fork 的祖先链里每个出现过
 * `pi.user` 的对话各找一次），`record.entry` 正是活上下文里的那条 user 条目才算数。
 */
export async function resolveInputSources(
  harness: Harness,
  conversationId: ConversationId,
  entries: readonly EntryRecord[]
): Promise<Map<EntryId, InputSource>> {
  const resolved = new Map<EntryId, InputSource>()
  const doc = await harness.snapshot(SourceDoc, conversationId, BG)
  const items: [string, InputSource][] = []
  for (const [requestId, item] of Object.entries(doc?.items ?? {})) {
    // 认不出的一项照样算「有记录」（失败闭合）：sessionId 补空串 —— 不是任何一个读者自己
    items.push([requestId, inputSourceOf(item) ?? { kind: 'parent-session', sessionId: '' }])
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
    for (const [requestId, source] of items) {
      for (const [owner, ids] of users) {
        const record = await tx.submissionByRequest(owner, requestId)
        if (record?.entry !== undefined && ids.has(record.entry)) {
          resolved.set(record.entry, source)
          break
        }
      }
    }
  }, BG)
  return resolved
}

/** 读来源要用到的那一点会话面（与转写摘要同一份） */
export type InputSourceSession = Pick<
  DurableSession,
  'sessionId' | 'currentConversation' | 'harness'
>

/**
 * 一条打开着的 durable 会话当前活上下文里，不是人亲手打的那些用户条目（条目 id 的字符串形 = 界面消息 id →
 * 来源）。句柄已关停 → `SessionClosedError`；其余失败原样抛出。
 */
export async function readInputSources(
  session: InputSourceSession
): Promise<Map<string, InputSource>> {
  try {
    const conversation = await session.currentConversation()
    const view = await conversation.context(BG)
    const resolved = await resolveInputSources(session.harness, conversation.id, view.entries)
    const out = new Map<string, InputSource>()
    for (const [entryId, source] of resolved) out.set(String(entryId), source)
    return out
  } catch (error) {
    if (isClosedError(error)) throw new SessionClosedError(session.sessionId)
    throw error
  }
}

/** 一条用户消息是谁写的：父会话（有来源记录）/ 人（可以认定）/ 分不清 */
export type MessageAuthor = 'parent' | 'human' | 'unknown'

/**
 * 一串用户消息（旧 → 新，系统写的通知不要放进来）各是谁写的（§19.7，2026-10-17 裁决）：有来源记录 → 父会话；
 * 没有记录、且排在**第一条有记录的消息之后** → 人亲手打的；在它之前、或整串都没有记录 → 分不清（升级之前父会话发的
 * 消息同样没有记录）。自动审查把「分不清」当成父会话写的（保守），大纲把它标成 `[unattributed]`。
 *
 * `topLevel`：这串消息属于一条**顶层会话** —— 它没有父会话，「升级之前父会话发的消息没有记录」这回事不存在（别的会话
 * 经会话权限表往里发消息是 2026-10-20 之后的事，恒有记录），所以没有记录的一律是人打的。
 */
export function authorsOf<T>(
  items: readonly T[],
  sourced: (item: T) => boolean,
  opts: { topLevel?: boolean } = {}
): Map<T, MessageAuthor> {
  const authors = new Map<T, MessageAuthor>()
  let reliable = opts.topLevel === true
  for (const item of items) {
    if (sourced(item)) {
      reliable = true
      authors.set(item, 'parent')
    } else authors.set(item, reliable ? 'human' : 'unknown')
  }
  return authors
}
