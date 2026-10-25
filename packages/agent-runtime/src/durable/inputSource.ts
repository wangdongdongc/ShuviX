/**
 * 用户输入的来源（docs/sub-session-design.md §19.7）—— 一条 `pi.user` 不是人亲手打的时候，它是谁写的。
 *
 * `SourceDoc` 自 2026-10-21 起给**每一条**输入记来源（`InputOrigin`：本机窗口、远程连接、Chrome、Telegram、别的会话，
 * 见 chat-protocol `inputOrigin.ts`）；这里只读其中「不是人打的」那几种 —— 人在某个前端里打的来源跳过，读者看到的
 * 与之前一样。触发器替某个 bot 发出的话（`kind: 'trigger'`，2026-10-24）同样不是人打的。驱动它的那条会话：父会话代用户发进子会话的消息（`kind: 'parent-session'`），或经会话权限表被授权的别的
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
import type {
  ConversationId,
  EntryId,
  EntryRecord,
  Harness,
  JsonObject
} from '@earendil-works/pi-durable'
import { UserEntry } from '@earendil-works/pi-durable'
import {
  inputOriginOf,
  isMachineOrigin,
  type MachineOrigin
} from '@shuvix/chat-protocol/types/inputOrigin'
import { backgroundContext as BG, isClosedError } from './context'
import { SourceDoc } from './docs'
import { SessionClosedError, type DurableSession } from './durableSession'

/** 一条不是人打的输入的来源：驱动它的会话（父会话或被授权的别的会话），或替某个 bot 发话的触发器 */
export type InputSource = MachineOrigin

/**
 * 侧车的一项 → 不是人打的来源：驱动它的会话 `{kind:'parent-session' | 'session', sessionId}`（title 可选）或触发器
 * `{kind:'trigger', trigger, bot}`；人打的来源与认不出的形状 → undefined（后者在解析时按「认不出」处理，见
 * `drivingSourceOfItem`）
 */
export function inputSourceOf(item: unknown): InputSource | undefined {
  const origin = inputOriginOf(item)
  return origin !== undefined && isMachineOrigin(origin) ? origin : undefined
}

/** 认不出的一项照样算「有记录」（失败闭合）：sessionId 补空串 —— 不是任何一个读者自己 */
const UNRECOGNIZED: InputSource = { kind: 'parent-session', sessionId: '' }

/** 侧车的一项 → 驱动它的会话；人在某个前端里打的 → undefined（不算有记录）；认不出 → `UNRECOGNIZED` */
function drivingSourceOfItem(item: unknown): InputSource | undefined {
  const origin = inputOriginOf(item)
  if (origin === undefined) return UNRECOGNIZED
  return isMachineOrigin(origin) ? origin : undefined
}

/**
 * `SourceDoc` 里按 requestId 记的项 → 它落到的条目：`pick` 说要哪些项、要成什么；当前对话逐项按 requestId 找
 * submission（fork 的祖先链里每个出现过 `pi.user` 的对话各找一次），`record.entry` 正是活上下文里的那条 user 条目才算数。
 */
async function resolveSourceItems<T>(
  harness: Harness,
  conversationId: ConversationId,
  entries: readonly EntryRecord[],
  pick: (item: JsonObject) => T | undefined
): Promise<Map<EntryId, T>> {
  const resolved = new Map<EntryId, T>()
  const doc = await harness.snapshot(SourceDoc, conversationId, BG)
  const items: [string, T][] = []
  for (const [requestId, item] of Object.entries(doc?.items ?? {})) {
    const picked = pick(item)
    if (picked !== undefined) items.push([requestId, picked])
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
    for (const [requestId, picked] of items) {
      for (const [owner, ids] of users) {
        const record = await tx.submissionByRequest(owner, requestId)
        if (record?.entry !== undefined && ids.has(record.entry)) {
          resolved.set(record.entry, picked)
          break
        }
      }
    }
  }, BG)
  return resolved
}

/** 来源 → 它落到的条目：只要不是人打的那些（认不出的形状按「有记录」算，见 `drivingSourceOfItem`） */
export function resolveInputSources(
  harness: Harness,
  conversationId: ConversationId,
  entries: readonly EntryRecord[]
): Promise<Map<EntryId, InputSource>> {
  return resolveSourceItems(harness, conversationId, entries, drivingSourceOfItem)
}

/**
 * 采纳提议发出的那些用户条目（`suggest` 工具，2026-10-25）：人的来源上带着 `suggestion` —— 人点的，话是 agent 写的。
 * 自动审查据此在这句话前注明出处；它仍然是人的话（不进 `resolveInputSources`）
 */
export async function resolveSuggestedEntries(
  harness: Harness,
  conversationId: ConversationId,
  entries: readonly EntryRecord[]
): Promise<Set<EntryId>> {
  const resolved = await resolveSourceItems(harness, conversationId, entries, (item) => {
    const origin = inputOriginOf(item)
    return origin !== undefined && 'suggestion' in origin && origin.suggestion !== undefined
      ? true
      : undefined
  })
  return new Set(resolved.keys())
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
