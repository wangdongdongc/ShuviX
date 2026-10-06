/**
 * P3-03 · 共享与回收、宿主钩子、受理回调、下游失败（设计稿 P3-03-45..49、52）：
 *
 *   45 共享实例：projector() 两次 `===`，两个句柄同一份状态；归还一个照常修订；归还最后一个之后旁路、
 *      watch、询问与运行状态的订阅都摘掉，状态保留最后的值
 *   46 拆掉之后再要：新挂载 = freshMount，之后的提交照常修订它
 *   47 会话关停拆掉投影：关停时取消询问不抛错；`onSessionClosed('s1','remove')` 在 close 落定之后；删除是
 *      `destroy`；LRU 关闭是 `remove`（PIN-09）
 *   48 onSessionOpened：每次真正的打开（open / peek）一次，带着会话、在打开时那次运行状态报过之后；复用不调；
 *      抛错不挡打开
 *   49 onAdmitted({entryId})（PIN-08）：空闲发送带落下的 user 条目 id；被拒的不调；重新挂上不调；排队的发送
 *      不带 entryId，放下时 onPlaced({entryId})
 *   52 下游失败被兜住（PIN-03）：订阅方每次都抛 → 提交照常、运行状态对、之后照常修订、逐帧身份、记日志
 */
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import { SessionClosedError, type DurableSession } from '../../durableSession'
import { testProfile } from '../../__tests__/support/agentConfig'
import { answer, held, stalled } from '../../__tests__/support/faux'
import { makeHost, primeRoot, registerHostCleanup } from '../../__tests__/support/host'
import { allEntries } from '../../__tests__/support/transcript'
import { waitFor, withTimeout } from '../../__tests__/support/wait'
import {
  attachOracle,
  freshMount,
  opsOf,
  settleFrames,
  throwingSubscriber
} from './projectorSupport'

registerHostCleanup()

const TIMEOUT = 20000

async function userIds(session: DurableSession): Promise<number[]> {
  return (await allEntries(await session.currentConversation()))
    .filter((e) => e.kind === 'pi.user')
    .map((e) => e.id)
}

describe('P3-03 · ref-counting and dispose', () => {
  it('P3-03-45 shared instance: one state for both handles; the last release unhooks everything and keeps the value', async () => {
    const t = await makeHost({ ephemeral: ['s1'] })
    const session = await t.open('s1')
    await primeRoot(session)
    const first = session.projector()
    const second = session.projector()
    expect(first).toBe(second)
    const proj = await first
    expect(await session.projector()).toBe(proj)
    const a = proj.acquire()
    const b = proj.acquire()
    expect(a.state).toBe(b.state)
    a.release()
    a.release()
    t.kit.queue(answer('one'))
    expect(await session.submitUser('u1')).toEqual({})
    await settleFrames()
    expect(b.state.value.messages.map((m) => m.content)).toEqual(['u1', 'one'])
    const ops = opsOf(b.state)
    b.release()
    expect(proj.disposed).toBe(true)
    const last = b.state.value
    t.kit.queue(answer('two'))
    expect(await session.submitUser('u2')).toEqual({})
    const pending = session.requestUserInput({
      id: 'R1',
      kind: 'ask',
      toolName: 'ask',
      question: '?',
      createdAt: 0
    } as never)
    await settleFrames()
    expect(ops.revisions).toEqual([])
    expect(b.state.value).toBe(last)
    expect(() => proj.acquire()).toThrow(/disposed/)
    session.respondToInput('R1', { kind: 'allow' } as never)
    await pending
    ops.stop()
  })

  it('P3-03-46 reacquire after dispose: a new mount equal to freshMount that keeps revising', async () => {
    const t = await makeHost({ ephemeral: ['s1'] })
    const session = await t.open('s1')
    await primeRoot(session)
    const old = await session.projector()
    old.acquire().release()
    t.kit.queue(answer('one'))
    expect(await session.submitUser('u1')).toEqual({})
    const proj = await session.projector()
    expect(proj).not.toBe(old)
    const h = proj.acquire()
    expect(h.state.value).toStrictEqual(await freshMount(session))
    t.kit.queue(answer('two'))
    expect(await session.submitUser('u2')).toEqual({})
    await settleFrames()
    expect(h.state.value.messages.map((m) => m.content)).toEqual(['u1', 'one', 'u2', 'two'])
    h.release()
  })

  it(
    'P3-03-47 session close disposes the projector; onSessionClosed remove / destroy / LRU remove fire after close resolves',
    async () => {
      const closed: [string, string, boolean][] = []
      const sessions = new Map<string, DurableSession>()
      const onSessionClosed = (sessionId: string, reason: string): void => {
        closed.push([sessionId, reason, sessions.get(sessionId)?.closed ?? false])
      }
      const t = await makeHost({ onSessionClosed })
      const session = await t.open('s1')
      sessions.set('s1', session)
      const proj = await session.projector()
      const h = proj.acquire()
      const pending = session.requestUserInput({
        id: 'R1',
        kind: 'ask',
        toolName: 'ask',
        question: '?',
        createdAt: 0
      } as never)
      expect(h.state.value.asks).toHaveLength(1)
      await t.host.close('s1')
      expect(await pending).toEqual({ kind: 'cancel', reason: 'closed' })
      expect(proj.disposed).toBe(true)
      expect(h.state.value.asks).toHaveLength(1)
      expect(closed).toEqual([['s1', 'remove', true]])
      await expect(session.projector()).rejects.toBeInstanceOf(SessionClosedError)

      // 删除：destroy
      const again = await t.open('s1')
      sessions.set('s1', again)
      await t.host.delete('s1')
      expect(closed.at(-1)).toEqual(['s1', 'destroy', true])
      expect(closed.filter(([, reason]) => reason === 'destroy')).toHaveLength(1)
      // 没开着的会话被删除同样报 destroy（P3-05 PIN-06），在删存储之后
      expect(t.host.get('s1')).toBeUndefined()
      await t.host.delete('s1')
      expect(closed.at(-1)).toEqual(['s1', 'destroy', true])
      await t.host.delete('never-opened')
      expect(closed.at(-1)).toEqual(['never-opened', 'destroy', false])
      expect(t.events.at(-1)).toBe('delete:never-opened')

      // LRU（maxIdleOpen 0：打开之后的修剪就关掉它）：remove
      const lruHost = await makeHost({ maxIdleOpen: 0, onSessionClosed })
      const lru = await lruHost.open('s2')
      sessions.set('s2', lru)
      await waitFor(() => closed.some(([id]) => id === 's2'), 3000, 'LRU close')
      expect(closed.at(-1)).toEqual(['s2', 'remove', true])
      h.release()
    },
    TIMEOUT
  )

  it('P3-03-48 onSessionOpened: once per real open (open and peek), after the run-state report; not on reuse; a throwing hook does not fail open', async () => {
    const opened: [string, number][] = []
    const holder: { t?: Awaited<ReturnType<typeof makeHost>> } = {}
    let throwOnce = true
    const t = await makeHost({
      onSessionOpened: (session) => {
        opened.push([session.sessionId, holder.t!.statesOf(session.sessionId).length])
        if (throwOnce && session.sessionId === 's3') {
          throwOnce = false
          throw new Error('opened boom')
        }
      }
    })
    holder.t = t
    const s1 = await t.open('s1')
    expect(opened).toEqual([['s1', 1]])
    expect(await t.open('s1')).toBe(s1)
    expect(await t.host.peek('s1')).toBe(s1)
    expect(opened).toHaveLength(1)
    await t.host.close('s1')
    expect(await t.host.peek('s1')).toBeDefined()
    expect(opened).toEqual([
      ['s1', 1],
      ['s1', 2]
    ])
    expect(await t.host.peek('missing')).toBeUndefined()
    expect(opened).toHaveLength(2)
    const s3 = await t.open('s3')
    expect(s3.sessionId).toBe('s3')
    expect(t.warnings.some((w) => w.includes('opened boom'))).toBe(true)
  })

  it(
    'P3-03-49 onAdmitted({entryId}) and onPlaced (PIN-08)',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      await primeRoot(session)
      // 空闲：受理当场落下，entryId = 那条 user 条目
      const admitted: unknown[] = []
      t.kit.queue(answer('ok'))
      expect(
        await session.submitUser('idle', {
          requestId: 'q1',
          onAdmitted: (info) => admitted.push(info),
          onPlaced: () => admitted.push('placed?')
        })
      ).toEqual({})
      const [first] = await userIds(session)
      expect(admitted).toEqual([{ entryId: first }])
      const proj = await session.projector()
      const h = proj.acquire()
      expect(h.state.value.messages[0]!.id).toBe(String(first))
      // 重新挂上：不调
      expect(
        await session.submitUser('idle', { requestId: 'q1', onAdmitted: (i) => admitted.push(i) })
      ).toEqual({})
      expect(admitted).toHaveLength(1)

      // 排队：不带 entryId，放下时 onPlaced
      const run = held(answer('a2'))
      t.kit.queue(run.step, answer('a3'))
      const sending = session.submitUser('busy run')
      await withTimeout(run.reached, 5000, 'held')
      const queued: unknown[] = []
      const queuedSend = session.submitUser('queued', {
        whenBusy: 'followUp',
        onAdmitted: (info) => queued.push(['admitted', info]),
        onPlaced: (info) => queued.push(['placed', info])
      })
      await waitFor(() => queued.length === 1, 3000, 'admitted')
      expect(queued).toEqual([['admitted', {}]])
      // 忙时被拒：不调
      const rejected: unknown[] = []
      expect((await session.submitUser('nope', { onAdmitted: (i) => rejected.push(i) })).code).toBe(
        'busy'
      )
      expect(rejected).toEqual([])
      run.release()
      expect(await withTimeout(sending, 8000, 'busy run')).toEqual({})
      expect(await withTimeout(queuedSend, 8000, 'queued')).toEqual({})
      await waitFor(() => queued.length === 2, 3000, 'placed')
      const ids = await userIds(session)
      expect(queued[1]).toEqual(['placed', { entryId: ids.at(-1) }])
      h.release()

      // 模型被拒：不调
      const refused = await makeHost({
        ephemeral: ['s2'],
        agentConfig: { profile: testProfile() }
      })
      const s2 = await refused.open('s2')
      const never: unknown[] = []
      const result = await s2.submitUser('x', { onAdmitted: (i) => never.push(i) })
      expect(result.code).toBe('no_model')
      expect(never).toEqual([])
    },
    TIMEOUT
  )

  it(
    'P3-03-49b steer / followUp take onAdmitted({entryId?}) and onPlaced (PIN-08; P3-07 PIN-15/16): idle → entryId at admission; queued → none, then onPlaced; withdrawn → never placed',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      await primeRoot(session)
      // 空闲的 followUp / steer：起一轮，受理当场落下
      for (const mode of ['followUp', 'steer'] as const) {
        const seen: unknown[] = []
        t.kit.queue(answer(`${mode} answer`))
        const result = await session[mode](`idle ${mode}`, {
          onAdmitted: (info) => seen.push(['admitted', info]),
          onPlaced: (info) => seen.push(['placed', info])
        })
        expect(result.submissionId).toBeDefined()
        await waitFor(() => session.runState === 'idle', 5000, 'idle')
        const ids = await userIds(session)
        expect(seen).toEqual([['admitted', { entryId: ids.at(-1) }]])
      }
      // 忙时排队：不带 entryId，放下时 onPlaced；撤回的从不 onPlaced
      const run = held(answer('busy answer'))
      t.kit.queue(run.step, answer('after'))
      const sending = session.submitUser('busy run')
      await withTimeout(run.reached, 5000, 'held')
      const steered: unknown[] = []
      const withdrawn: unknown[] = []
      await session.steer('steered', {
        onAdmitted: (info) => steered.push(['admitted', info]),
        onPlaced: (info) => steered.push(['placed', info])
      })
      const { submissionId } = await session.followUp('withdrawn', {
        onAdmitted: (info) => withdrawn.push(['admitted', info]),
        onPlaced: (info) => withdrawn.push(['placed', info])
      })
      expect(steered).toEqual([['admitted', {}]])
      expect(withdrawn).toEqual([['admitted', {}]])
      const conversation = await session.currentConversation()
      expect(
        await session.harness.abortSubmission(submissionId as never, BG, conversation.id)
      ).toBe('aborted')
      run.release()
      expect(await withTimeout(sending, 8000, 'busy run')).toEqual({})
      await waitFor(() => steered.length === 2, 5000, 'steer placed')
      await waitFor(() => session.runState === 'idle', 5000, 'idle')
      await settleFrames()
      const entries = await allEntries(conversation)
      const steeredEntry = entries.find(
        (e) =>
          e.kind === 'pi.user' && e.model?.[0]?.role === 'user' && e.model[0].content === 'steered'
      )!
      expect(steered[1]).toEqual(['placed', { entryId: steeredEntry.id }])
      expect(withdrawn).toEqual([['admitted', {}]])
    },
    TIMEOUT
  )

  it(
    'P3-03-52 downstream failure is contained (PIN-03): commits succeed, run state correct, later revisions continue, identity holds, logged',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      await primeRoot(session)
      const proj = await session.projector()
      const h = proj.acquire()
      const oracle = await attachOracle(session, h.state)
      const stop = throwingSubscriber(h.state)
      const stall = stalled()
      t.kit.queue(answer('one'), stall.step)
      expect(await session.submitUser('u1')).toEqual({})
      const sending = session.submitUser('u2')
      await withTimeout(stall.reached, 5000, 'stalled')
      expect(session.isBusy()).toBe(true)
      expect(session.runState).toBe('busy')
      await session.abort()
      await sending
      await waitFor(() => session.runState === 'idle', 3000, 'idle')
      await settleFrames()
      expect(h.state.value.messages.map((m) => m.content).slice(0, 3)).toEqual(['u1', 'one', 'u2'])
      expect(h.state.value.run).toStrictEqual({ state: 'idle' })
      expect(t.warnings.some((w) => w.includes('downstream boom'))).toBe(true)
      expect(await oracle.verify()).toBeGreaterThan(2)
      await oracle.stop()
      stop()
      h.release()
    },
    TIMEOUT
  )
})
