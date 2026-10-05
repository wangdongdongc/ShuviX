/**
 * P3-10a · 拒绝、竞态与换挂载（设计稿 P3-10a-19..22）：
 *
 *   19 目标校验（PIN-19/20）：不存在的 id、子对话的条目、上一次回退之后只在旧分支上的条目、助手条目、通知
 *      条目（外加工具结果）→ `{ok:false, reason:'not_found'|'invalid_target'}`；不销毁（锁不变、没有
 *      agent_closing）、没有发布、指针不变；在跑的 run 照样跑完
 *   20 并发（PIN-22）：(a) 两个并发的回退一个接一个 —— 2 个新对话，指针落在第二个上，第二个从第一个的 F fork；
 *      (b) 回退在途时开始的 submitUser：都落定之后锁（有的话）在当前对话上、被放弃的分支上没有 run；
 *      (c) 补充：建锁在途时开始回退 —— 建锁被取消（发送当作被中止），之后没有锁在旧对话上
 *   21 投影换挂载：指针变化恰好一次 `[['r', value]]` 修订，值 = freshMount、conversationId = F；
 *      P3-04 的绑定订阅者没有 replaced / unavailable，门面还是同一个对象
 *   22 句柄已关：`{ok:false, reason:'closed'}`，从不重开
 */
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ServiceProviderUpdate } from '@earendil-works/chord'
import type { SyncTarget } from '@shuvix/chat-protocol/sync'
import { describe, expect, it } from 'vitest'
import { createSyncHub, type SyncSession, type SyncSessionClosedReason } from '../../sync/syncHub'
import { TestClient } from '../../sync/__tests__/support/client'
import { LoopbackTransport, settle } from '../../sync/__tests__/support/rig'
import type { DurableSession } from '../durableSession'
import { freshMount, opsOf, settleFrames } from '../projection/__tests__/projectorSupport'
import { answer, held } from './support/faux'
import { makeHost, registerHostCleanup } from './support/host'
import {
  contents,
  conversationCount,
  conversationRecord,
  entriesOf,
  forkedId,
  rawPublications,
  rollbackBase,
  threeTurns,
  viewOf
} from './support/rollback'
import { callAgent, hostD, liveTasks } from './support/spawn'
import { allEntries } from './support/transcript'
import { aborted, deferred, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const TIMEOUT = 20000

/** 一次被拒的回退：结果、没有发布、锁同一个对象、没有 agent_closing、指针不变 */
async function expectRefused(
  session: DurableSession,
  closing: () => number,
  target: number,
  reason: 'not_found' | 'invalid_target',
  keep = false
): Promise<void> {
  const lock = session.lock
  const closingBefore = closing()
  const pointer = (await session.currentConversation()).id
  const recorder = rawPublications(session)
  expect(await session.rollbackTo(target, keep ? { keep } : {}), `target ${target}`).toEqual({
    ok: false,
    reason
  })
  recorder.stop()
  expect(recorder.publications, `target ${target}`).toEqual([])
  expect(session.lock).toBe(lock)
  expect(closing()).toBe(closingBefore)
  expect((await session.currentConversation()).id).toBe(pointer)
}

describe('P3-10a · refusals, races and remount', () => {
  it(
    'P3-10a-19 target validation: not_found / invalid_target, read-only — no destroy, no publication, pointer unchanged; a busy run keeps streaming',
    async () => {
      const d = await hostD()
      const { session, t } = d
      const closing = (): number => t.broadcastsOf('agent_closing').length
      t.kit.queue(answer('A1'))
      expect(await session.submitUser('U1')).toEqual({})
      t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('A2'))
      expect(await session.submitUser('U2')).toEqual({})
      expect((await session.writeNotice({ text: 'N', kind: 'background' })).status).toBe(
        'submitted'
      )
      t.kit.queue(answer('A3'))
      expect(await session.submitUser('U3')).toEqual({})
      const root = await allEntries(await session.currentConversation())
      const a1 = root.find((entry) => entry.kind === 'pi.assistant')!
      const notice = root.find((entry) => entry.kind === 'shuvix.notice')!
      const toolResult = root.find((entry) => entry.kind === 'pi.tool-result')!
      const u3 = root.filter((entry) => entry.kind === 'pi.user').at(-1)!
      const C = d.outcomes[0]!.conversationId!
      const childEntry = (await entriesOf(session, C))[0]!

      await expectRefused(session, closing, 999_999, 'not_found')
      await expectRefused(session, closing, childEntry.id, 'not_found')
      await expectRefused(session, closing, a1.id, 'invalid_target')
      await expectRefused(session, closing, a1.id, 'invalid_target', true)
      await expectRefused(session, closing, notice.id, 'invalid_target')
      await expectRefused(session, closing, toolResult.id, 'invalid_target')

      // 回退之后，U3 只在被放弃的旧分支上
      const F = forkedId(await session.rollbackTo(u3.id))
      await expectRefused(session, closing, u3.id, 'not_found')
      expect((await session.currentConversation()).id).toBe(F)

      // 在跑的 run 不受被拒的回退影响
      const run = held(answer('late'))
      t.kit.queue(run.step)
      const sending = session.submitUser('busy')
      await run.reached
      await expectRefused(session, closing, 999_999, 'not_found')
      expect(session.isBusy()).toBe(true)
      run.release()
      expect(await withTimeout(sending, 3000, 'busy run')).toEqual({})
      expect(contents(await viewOf(session)).slice(-2)).toEqual(['busy', 'late'])
    },
    TIMEOUT
  )

  it('P3-10a-20a two concurrent rollbacks run one after the other: 2 new conversations, the pointer ends on the second, which forks from the first', async () => {
    const { session, ids } = await rollbackBase()
    const [first, second] = await Promise.all([
      session.rollbackTo(ids.u3),
      session.rollbackTo(ids.u2)
    ])
    const F1 = forkedId(first)
    const F2 = forkedId(second)
    expect(await conversationCount(session)).toBe(3)
    expect((await session.currentConversation()).id).toBe(F2)
    expect((await conversationRecord(session, F2))?.parent).toEqual({
      conversationId: F1,
      at: ids.a1
    })
    expect(contents(await viewOf(session))).toEqual(['U1', 'A1'])
  })

  it(
    'P3-10a-20b a submitUser started while rollbackTo is in flight: the lock is on the current conversation; no run is live on the abandoned branch',
    async () => {
      const { t, session, ids } = await rollbackBase()
      t.kit.queue(answer('again-answer'))
      const rolling = session.rollbackTo(ids.u2)
      const sending = session.submitUser('again')
      const [rolled, sent] = await withTimeout(
        Promise.all([rolling, sending]),
        5000,
        'rollback + send'
      )
      const F = forkedId(rolled)
      expect(sent).toEqual({})
      expect((await session.currentConversation()).id).toBe(F)
      expect(session.lock?.conversationId).toBe(F)
      expect(await liveTasks(session, ROOT_CONVERSATION_ID)).toEqual([])
      expect(contents(await viewOf(session))).toEqual(['U1', 'A1', 'again', 'again-answer'])
    },
    TIMEOUT
  )

  it(
    'P3-10a-20c a send whose lock creation is in flight when the rollback starts: the creation is cancelled ({}), and no lock is left on the abandoned branch',
    async () => {
      const t = await makeHost()
      const session = await t.open('s1')
      const ids = await threeTurns(session, t)
      await session.destroyAgent()
      const resolving = deferred()
      t.toolHost.beforeResolve = async (signal) => {
        resolving.resolve()
        await aborted(signal)
      }
      const sending = session.submitUser('again')
      await resolving.promise
      const F = forkedId(await withTimeout(session.rollbackTo(ids.u2), 5000, 'rollbackTo'))
      expect(await withTimeout(sending, 3000, 'cancelled send')).toEqual({})
      expect(session.lock).toBeUndefined()
      expect(await liveTasks(session, ROOT_CONVERSATION_ID)).toEqual([])
      t.toolHost.beforeResolve = undefined
      t.kit.queue(answer('later-answer'))
      expect(await session.submitUser('later')).toEqual({})
      expect(session.lock?.conversationId).toBe(F)
      expect(contents(await viewOf(session))).toEqual(['U1', 'A1', 'later', 'later-answer'])
    },
    TIMEOUT
  )

  it(
    'P3-10a-21 projector remount: exactly one [["r", value]] revision for the pointer change, = freshMount on F; a SyncHub binding sees no replaced / unavailable and keeps its facade',
    async () => {
      const opened = new Set<(session: SyncSession) => void>()
      const closed = new Set<(sessionId: string, reason: SyncSessionClosedReason) => void>()
      const t = await makeHost({
        onSessionOpened: (session) => {
          for (const listener of opened) listener(session)
        },
        onSessionClosed: (sessionId, reason) => {
          for (const listener of closed) listener(sessionId, reason)
        }
      })
      const session = await t.open('s1')
      const ids = await threeTurns(session, t)
      const transport = new LoopbackTransport()
      const hub = createSyncHub({
        host: {
          get sealed() {
            return t.host.sealed
          },
          peek: (sessionId) => t.host.peek(sessionId),
          onSessionOpened: (listener) => {
            opened.add(listener)
            return () => opened.delete(listener)
          },
          onSessionClosed: (listener) => {
            closed.add(listener)
            return () => closed.delete(listener)
          }
        },
        transport
      })
      const target: SyncTarget = { kind: 'session', sessionId: 's1' }
      const binding = new TestClient('A', hub, transport).bind(target)
      await withTimeout(binding.ready(), 5000, 'binding ready')
      const facade = binding.facade()
      const view = facade.view

      const proj = await session.projector()
      const h = proj.acquire()
      const ops = opsOf(h.state)
      const F = forkedId(await session.rollbackTo(ids.u2))
      await waitFor(() => h.state.value.conversationId === F, 3000, 'remounted')
      await settleFrames()
      await settle()
      const replaced = ops.revisions.filter((revision) => revision.ops.some((op) => op[0] === 'r'))
      expect(replaced).toHaveLength(1)
      expect(replaced[0]!.ops).toEqual([['r', replaced[0]!.value]])
      expect(replaced[0]!.value.conversationId).toBe(F)
      expect(h.state.value).toStrictEqual(await freshMount(session))
      expect(h.state.value.conversationId).toBe(F)
      // 挂着且追上了的投影：viewSnapshot() 交它的值（P3-07），也就是 fork 的视图
      expect(await session.viewSnapshot()).toStrictEqual(h.state.value)

      const types = binding.updates.map((update: ServiceProviderUpdate) => update.type)
      expect(types).not.toContain('replaced')
      expect(types).not.toContain('unavailable')
      expect(binding.facade()).toBe(facade)
      expect(binding.facade().view).toBe(view)
      expect(binding.value()).toEqual(h.state.value)
      ops.stop()
      h.release()
      await binding.dispose()
      hub.dispose()
    },
    TIMEOUT
  )

  it('P3-10a-22 a closed handle: a closed refusal, never a reopen', async () => {
    const { t, session, ids } = await rollbackBase()
    await t.host.close('s1')
    const opens = t.events.filter((event) => event === 'open:s1').length
    expect(await session.rollbackTo(ids.u2)).toEqual({ ok: false, reason: 'closed' })
    expect(await session.rollbackTo(ids.u2, { keep: true })).toEqual({
      ok: false,
      reason: 'closed'
    })
    expect(t.events.filter((event) => event === 'open:s1').length).toBe(opens)
    expect(t.host.get('s1')).toBeUndefined()
    expect(session.closed).toBe(true)
  })
})
