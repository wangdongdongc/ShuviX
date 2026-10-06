/**
 * ShuviX 文档（裁决 R9）：定义的语义快照；每个创建 / fork 对话的提交都补种；补种绝不重置
 * 会话状态；跨关闭重开持久；NoticeEntry 的形状与它进入下一次请求的方式。
 */
import { ROOT_CONVERSATION_ID, type ConversationId } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc, DisplayDoc, NoticeEntry, SessionStateDoc } from '../docs'
import { answer } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup } from './support/host'
import { allEntries, requestTexts } from './support/transcript'

registerHostCleanup()

function semantics(token: { definition: Record<string, unknown> }): Record<string, unknown> {
  const { kind, version, scope, history, fork } = token.definition
  return { kind, version, scope, history, fork }
}

describe('ShuviX durable docs', () => {
  it('D-01 definitions', () => {
    expect(semantics(SessionStateDoc)).toEqual({
      kind: 'shuvix.session-state',
      version: 1,
      scope: 'session',
      history: undefined,
      fork: undefined
    })
    expect(semantics(AgentStateDoc)).toEqual({
      kind: 'shuvix.agent-state',
      version: 1,
      scope: 'conversation',
      history: 'rewindable',
      fork: 'asOf'
    })
    expect(semantics(DisplayDoc)).toEqual({
      kind: 'shuvix.display',
      version: 1,
      scope: 'conversation',
      history: 'rewindable',
      fork: 'asOf'
    })
    expect(NoticeEntry.kind).toBe('shuvix.notice')
  })

  it('D-02 seeded when the root is created', async () => {
    const t = await makeHost()
    const session = await t.open()
    const watch = await session.harness.watchDoc(SessionStateDoc, BG)
    expect(watch).toBeDefined()
    await watch?.stop()
    expect(await session.harness.snapshot(SessionStateDoc, BG)).toEqual({ deferredNotices: [] })
    expect(await session.harness.snapshot(AgentStateDoc, ROOT_CONVERSATION_ID, BG)).toEqual({})
    expect(await session.harness.snapshot(DisplayDoc, ROOT_CONVERSATION_ID, BG)).toEqual({
      items: {}
    })
  })

  it('D-03 seeded for a fork, an ownerless createConversation and a raw tx.createConversation', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(answer('a1'))
    await session.submitUser('u1')
    const root = await session.currentConversation()
    const userEntry = (await allEntries(root)).find((entry) => entry.kind === 'pi.user')!
    const fork = await root.fork(userEntry.id, { ownership: { kind: 'ownerless' } }, BG)
    const ownerless = await session.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      BG
    )
    const raw = await session.harness.commit(
      async (tx) => (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id,
      BG
    )
    for (const id of [fork.id, ownerless.id, raw]) {
      expect(await session.harness.snapshot(AgentStateDoc, id, BG)).toBeDefined()
      expect(await session.harness.snapshot(DisplayDoc, id, BG)).toEqual({ items: {} })
    }
  })

  it('D-04 seeding a new conversation never resets session state', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(answer('a1'))
    await session.submitUser('u1')
    const root = await session.currentConversation()
    const userEntry = (await allEntries(root)).find((entry) => entry.kind === 'pi.user')!
    await session.harness.commit(async (tx) => {
      const state = await tx.doc(SessionStateDoc)
      state.currentConversation = ROOT_CONVERSATION_ID
      state.deferredNotices.push({ requestId: 'r1', text: 'N', kind: 'background' })
    }, BG)
    const before = await session.harness.snapshot(SessionStateDoc, BG)
    await root.fork(userEntry.id, { ownership: { kind: 'ownerless' } }, BG)
    await session.harness.createConversation({ ownership: { kind: 'ownerless' } }, BG)
    expect(await session.harness.snapshot(SessionStateDoc, BG)).toEqual(before)
  })

  it('D-04 a fork keeps its asOf copy of the agent state (rollback keeps lastAnnouncedDate)', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(AgentStateDoc, ROOT_CONVERSATION_ID)).lastAnnouncedDate = '2026-10-01'
    }, BG)
    t.kit.queue(answer('a1'))
    await session.submitUser('u1')
    const root = await session.currentConversation()
    const userEntry = (await allEntries(root)).find((entry) => entry.kind === 'pi.user')!
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(AgentStateDoc, ROOT_CONVERSATION_ID)).lastAnnouncedDate = '2026-10-04'
    }, BG)
    const fork = await root.fork(userEntry.id, { ownership: { kind: 'ownerless' } }, BG)
    // 上锁时冻结的人设与身份也在 asOf 副本里（primeRoot = createAgent，K15）
    expect(await session.harness.snapshot(AgentStateDoc, fork.id, BG)).toMatchObject({
      kind: 'root',
      profileName: 'test',
      lastAnnouncedDate: '2026-10-01'
    })
  })

  it('D-05 persisted across a SQLite close and reopen', async () => {
    const t = await makeHost()
    const session = await t.open()
    await session.harness.commit(async (tx) => {
      const state = await tx.doc(SessionStateDoc)
      state.deferredNotices.push({ requestId: 'r1', text: 'N', kind: 'date' })
      ;(await tx.doc(AgentStateDoc, ROOT_CONVERSATION_ID)).profileName = 'work'
      ;(await tx.doc(DisplayDoc, ROOT_CONVERSATION_ID)).items.req = { text: 'x' }
    }, BG)
    await t.host.close('s1')
    const reopened = await t.open()
    expect(reopened).not.toBe(session)
    expect(await reopened.harness.snapshot(SessionStateDoc, BG)).toEqual({
      deferredNotices: [{ requestId: 'r1', text: 'N', kind: 'date' }]
    })
    expect(
      await reopened.harness.snapshot(AgentStateDoc, ROOT_CONVERSATION_ID as ConversationId, BG)
    ).toEqual({ profileName: 'work' })
    expect(await reopened.harness.snapshot(DisplayDoc, ROOT_CONVERSATION_ID, BG)).toEqual({
      items: { req: { text: 'x' } }
    })
  })

  it('D-06 NoticeEntry shape via writeNotice, and the next request carries it as a user message', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    const result = await session.writeNotice({
      text: '<background-task id="t1">done</background-task>',
      kind: 'background',
      data: { taskId: 't1' }
    })
    expect(result.status).toBe('submitted')
    const entries = await allEntries(await session.currentConversation())
    const notice = entries.find((entry) => NoticeEntry.is(entry))
    expect(notice).toBeDefined()
    expect(NoticeEntry.is(notice)).toBe(true)
    expect(notice!.model).toEqual([
      {
        role: 'user',
        content: '<background-task id="t1">done</background-task>',
        timestamp: expect.any(Number)
      }
    ])
    expect(notice!.data).toEqual({ kind: 'background', taskId: 't1' })
    t.kit.queue(answer('ok'))
    await session.submitUser('next')
    expect(requestTexts(t.kit, 0)).toEqual([
      'user:<background-task id="t1">done</background-task>',
      'user:next'
    ])
  })
})
