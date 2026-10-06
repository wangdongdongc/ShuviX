/**
 * P3-10a（回退 fork）用例的共用夹具：
 *
 *  - `rollbackBase(options)`：设计稿的基础场景 —— 会话 s1（SQLite），根上 U1 A1 U2 A2 U3 A3，锁在 faux-1
 *    上，`today` 没注入（除非选项给了）。交回条目 id。
 *  - `forkedId(result)`：断言回退成功并交回新对话 id。
 *  - `viewOf(session)`：一个新建、不共享的投影此刻的值（= freshMount）。
 *  - `conversationRecord` / `conversationCount`：对话表的只读查询。
 *  - `entryIds(conversation, kind?)`：一个对话看得见的条目 id（fork 感知，最旧在前）。
 *  - `rawPublications(session)`：原样记下提交发布（看变化本身：对话记录、文档值与操作）。
 */
import type {
  CommitPublication,
  Conversation,
  ConversationId,
  ConversationRecord,
  EntryRecord
} from '@earendil-works/pi-durable'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { expect } from 'vitest'
import { backgroundContext as BG } from '../../context'
import type { DurableSession } from '../../durableSession'
import type { RollbackResult } from '../../rollback'
import { freshMount } from '../../projection/__tests__/projectorSupport'
import { answer } from './faux'
import { makeHost, primeRoot, type TestHost, type TestHostOptions } from './host'
import { allEntries } from './transcript'

export interface BaseIds {
  readonly u1: number
  readonly a1: number
  readonly u2: number
  readonly a2: number
  readonly u3: number
  readonly a3: number
}

export interface RollbackBase {
  readonly t: TestHost
  readonly session: DurableSession
  readonly ids: BaseIds
}

/** 根上跑三轮 U1 A1 U2 A2 U3 A3（应答文本 A1 / A2 / A3）；交回六条的 id */
export async function threeTurns(session: DurableSession, t: TestHost): Promise<BaseIds> {
  t.kit.queue(answer('A1'), answer('A2'), answer('A3'))
  for (const text of ['U1', 'U2', 'U3']) expect(await session.submitUser(text)).toEqual({})
  const entries = (await allEntries(await session.currentConversation())).filter(
    (entry) => entry.kind === 'pi.user' || entry.kind === 'pi.assistant'
  )
  const [u1, a1, u2, a2, u3, a3] = entries.map((entry) => entry.id as number)
  return { u1: u1!, a1: a1!, u2: u2!, a2: a2!, u3: u3!, a3: a3! }
}

/** 基础场景：s1，已锁（faux-1），三轮 */
export async function rollbackBase(options: TestHostOptions = {}): Promise<RollbackBase> {
  const t = await makeHost(options)
  const session = await t.open('s1')
  await primeRoot(session)
  const ids = await threeTurns(session, t)
  return { t, session, ids }
}

/** 回退成功 → 新对话 id */
export function forkedId(result: RollbackResult): ConversationId {
  expect(result).toEqual({ ok: true, conversationId: expect.any(Number) })
  if (!result.ok) throw new Error(`rollback refused: ${result.reason}`)
  return result.conversationId as ConversationId
}

export function viewOf(session: DurableSession): Promise<SessionView> {
  return freshMount(session)
}

export function contents(view: SessionView): string[] {
  return view.messages.map((message) => message.content)
}

export function messageIds(view: SessionView): string[] {
  return view.messages.map((message) => message.id)
}

export function conversationRecord(
  session: DurableSession,
  id: number
): Promise<ConversationRecord | undefined> {
  return session.harness.commit((tx) => tx.conversation(id as ConversationId), BG)
}

export async function conversationCount(session: DurableSession): Promise<number> {
  return session.harness.commit(
    async (tx) => (await tx.scanConversations({}, 256)).items.length,
    BG
  )
}

/** 一个对话（按 id）看得见的全部条目，最旧在前 */
export async function entriesOf(session: DurableSession, id: number): Promise<EntryRecord[]> {
  const conversation = await session.harness.conversation(id as ConversationId, BG)
  if (conversation === undefined) throw new Error(`no conversation ${id}`)
  return allEntries(conversation)
}

/** 一个对话看得见的条目 id（可按种类过滤），最旧在前 */
export async function entryIds(conversation: Conversation, kind?: string): Promise<number[]> {
  return (await allEntries(conversation))
    .filter((entry) => kind === undefined || entry.kind === kind)
    .map((entry) => entry.id as number)
}

/** 原样记下提交发布 */
export function rawPublications(session: DurableSession): {
  readonly publications: CommitPublication[]
  stop(): void
} {
  const publications: CommitPublication[] = []
  const stop = session.harness.subscribeCommits((publication) => publications.push(publication))
  return { publications, stop }
}

/** 一次发布里某个对话的建立 */
export function createsConversation(publication: CommitPublication, id: number): boolean {
  return publication.changes.some(
    (change) => change.type === 'conversation' && change.value.id === id
  )
}

/** 一次发布里 SessionStateDoc 的变化（没有 → undefined） */
export function sessionStateChange(
  publication: CommitPublication
): Extract<CommitPublication['changes'][number], { type: 'document' }> | undefined {
  for (const change of publication.changes) {
    if (change.type === 'document' && change.record.kind === 'shuvix.session-state') return change
  }
  return undefined
}

/** 通知条目的文本（`shuvix.notice`，user 消息的字符串内容） */
export function noticeTexts(entries: readonly EntryRecord[]): string[] {
  return entries
    .filter((entry) => entry.kind === 'shuvix.notice')
    .map((entry) => {
      const message = entry.model?.[0]
      return message?.role === 'user' && typeof message.content === 'string' ? message.content : ''
    })
}
