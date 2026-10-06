/**
 * P2-09 · driven-run 标记（`SessionState.driven`）与 `SessionHostDeps.onDrivenSettled`（PIN-12..14）：
 *
 *  - 被父会话驱动的发送受理之后、受理回调之前写下标记（自己的一个提交）；被拒的发送从不留下标记；
 *    没有 requestId 的驱动发送直接 `{ error }`；
 *  - 那条输入落定（完成 / 出错 / 被中止）时调 seam：进程内由提交发布察觉，打开时由扫描察觉、
 *    `open()` 落定之后再报，从不续跑；每个进程至多一次；回调成功后清掉标记，失败就留着等下次打开；
 *  - 重新挂上补上缺的标记；新的驱动发送替换旧标记。
 *
 * 重启用例都用 SQLite、真实计时器、约 15 秒的超时。
 */
import { ROOT_CONVERSATION_ID, type SubmissionRecord } from '@earendil-works/pi-durable'
import { describe, expect, it, vi } from 'vitest'
import { backgroundContext as BG } from '../context'
import { SessionStateDoc, type DrivenRun, type SessionState } from '../docs'
import type { DrivenSettledEvent, DurableSession } from '../durableSession'
import { testProfile } from './support/agentConfig'
import { recordPublications } from './support/commits'
import { crashWith } from './support/crash'
import { answer, held, modelError, stalled } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup, type TestHost } from './support/host'
import { transcript } from './support/transcript'
import { deferred, sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const RESTART_TIMEOUT = 15000
const ROOT = ROOT_CONVERSATION_ID
const DRIVEN = { parentId: 'P', background: true } as const

type Seam = (event: DrivenSettledEvent) => void | Promise<void>

async function marker(session: DurableSession): Promise<DrivenRun | undefined> {
  return (await session.harness.snapshot(SessionStateDoc, BG))?.driven
}

async function byRequest(
  session: DurableSession,
  requestId: string
): Promise<SubmissionRecord | undefined> {
  return session.harness.commit((tx) => tx.submissionByRequest(ROOT, requestId), BG)
}

async function scheduling(session: DurableSession): Promise<string> {
  return (await session.harness.inspect(BG)).scheduling
}

function seamSpy(impl: Seam = () => {}): ReturnType<typeof vi.fn<Seam>> {
  return vi.fn<Seam>(impl)
}

async function child(t: TestHost, sessionId = 'c1'): Promise<DurableSession> {
  const session = await t.open(sessionId)
  await primeRoot(session)
  return session
}

describe('driven marker · set', () => {
  it('P2-09-37 written after admission (visible inside onAdmitted); never on a refusal; a driven send without a requestId is refused and writes nothing', async () => {
    const t = await makeHost()
    const c1 = await child(t)
    t.kit.queue(answer('done'))
    let seen: Promise<SessionState | undefined> | undefined
    expect(
      await c1.submitUser('task', {
        requestId: 'R',
        driven: DRIVEN,
        onAdmitted: () => {
          seen = c1.harness.snapshot(SessionStateDoc, BG)
        }
      })
    ).toEqual({})
    expect((await seen!)?.driven).toEqual({
      requestId: 'R',
      parentId: 'P',
      background: true,
      conversationId: 1
    })

    // 忙着别的（另一个 id）：拒绝，不写标记
    const c2 = await child(t, 'c2')
    const run = held(answer('later'))
    t.kit.queue(run.step)
    const busy = c2.submitUser('other', { requestId: 'R0' })
    await run.reached
    expect(await c2.submitUser('task', { requestId: 'R2', driven: DRIVEN })).toMatchObject({
      code: 'busy'
    })
    expect(await marker(c2)).toBeUndefined()
    run.release()
    expect(await busy).toEqual({})

    // 没有 requestId：{ error }，什么都不写
    const recorder = recordPublications(c2.harness)
    const refused = await c2.submitUser('task', { driven: DRIVEN })
    recorder.stop()
    expect(refused.error).toEqual(expect.any(String))
    expect(recorder.publications).toEqual([])
    expect(await marker(c2)).toBeUndefined()

    // 模型被拒：不写标记
    const noModel = await makeHost({ agentConfig: { profile: testProfile() } })
    const c3 = await noModel.open('c3')
    expect(await c3.submitUser('task', { requestId: 'R3', driven: DRIVEN })).toMatchObject({
      code: 'no_model'
    })
    expect(await marker(c3)).toBeUndefined()
  })
})

describe('driven marker · emission', () => {
  it('P2-09-38 in-process: exactly one call with the full event; the marker clears once it resolves; later runs and a re-attach emit nothing; variants', async () => {
    const gate = deferred()
    const seam = seamSpy(async () => gate.promise)
    const t = await makeHost({ onDrivenSettled: seam })
    const c1 = await child(t)
    t.kit.queue(answer('done'))
    expect(await c1.submitUser('task', { requestId: 'R', driven: DRIVEN })).toEqual({})
    const id = (await byRequest(c1, 'R'))!.id
    await waitFor(() => seam.mock.calls.length === 1, 3000, 'seam called')
    expect(seam.mock.calls[0]![0]).toEqual({
      sessionId: 'c1',
      parentId: 'P',
      requestId: 'R',
      background: true,
      conversationId: 1,
      submissionId: id,
      noticeRequestId: `subsession-done:c1:${id}`,
      result: {},
      record: { status: 'done' }
    })
    expect(await marker(c1)).toBeDefined()
    gate.resolve()
    await waitFor(async () => (await marker(c1)) === undefined, 3000, 'marker cleared')

    t.kit.queue(answer('more'))
    expect(await c1.submitUser('more')).toEqual({})
    expect(await c1.submitUser('task', { requestId: 'R', driven: DRIVEN })).toEqual({})
    await sleep(50)
    expect(seam).toHaveBeenCalledTimes(1)

    // 变体：几次即时应答（与标记提交赛跑）各报一次；模型出错；用户中止
    const variants = seamSpy()
    const v = await makeHost({ onDrivenSettled: variants })
    for (const sessionId of ['i1', 'i2', 'i3']) {
      const session = await child(v, sessionId)
      v.kit.queue(answer('instant'))
      expect(await session.submitUser('task', { requestId: 'R', driven: DRIVEN })).toEqual({})
      await waitFor(async () => (await marker(session)) === undefined, 3000, `${sessionId} cleared`)
    }
    await sleep(50)
    expect(variants.mock.calls.map(([event]) => event.sessionId)).toEqual(['i1', 'i2', 'i3'])

    const failing = await child(v, 'e1')
    v.kit.queue(modelError('boom'))
    expect(await failing.submitUser('task', { requestId: 'R', driven: DRIVEN })).toEqual({
      error: 'boom',
      code: 'model_error'
    })
    await waitFor(() => variants.mock.calls.length === 4, 3000, 'model error reported')
    expect(variants.mock.calls[3]![0]).toMatchObject({
      sessionId: 'e1',
      result: { error: 'boom', code: 'model_error' },
      record: { status: 'unanswered', reason: 'model_error' }
    })

    const aborting = await child(v, 'a1')
    const stall = stalled()
    v.kit.queue(stall.step)
    const pending = aborting.submitUser('task', { requestId: 'R', driven: DRIVEN })
    await stall.reached
    await withTimeout(aborting.abort(), 5000, 'abort')
    expect(await pending).toEqual({})
    await waitFor(() => variants.mock.calls.length === 5, 3000, 'abort reported')
    expect(variants.mock.calls[4]![0]).toMatchObject({
      sessionId: 'a1',
      result: {},
      record: { status: 'unanswered', reason: 'aborted' }
    })
  })

  it(
    'P2-09-39 survives a restart while pending: no call at open; one call when it settles after resumeInterrupted; none in process 3',
    async () => {
      const seam = seamSpy()
      const { t } = await crashWith({
        requestId: 'R',
        driven: DRIVEN,
        restart: { onDrivenSettled: seam }
      })
      const session = await t.open()
      expect(await marker(session)).toMatchObject({ requestId: 'R', parentId: 'P' })
      await sleep(50)
      expect(seam).not.toHaveBeenCalled()
      expect(await session.requestState('R')).toBe('pending')

      t.kit.queue(answer('done'))
      expect(await session.resumeInterrupted()).toEqual({})
      await waitFor(() => seam.mock.calls.length === 1, 3000, 'seam called')
      expect(seam.mock.calls[0]![0]).toMatchObject({
        sessionId: 's1',
        requestId: 'R',
        result: {},
        record: { status: 'done' }
      })
      await waitFor(async () => (await marker(session)) === undefined, 3000, 'marker cleared')

      const third = seamSpy()
      const t3 = await t.restart({ onDrivenSettled: third })
      const reopened = await t3.open()
      await sleep(50)
      expect(third).not.toHaveBeenCalled()
      expect(await marker(reopened)).toBeUndefined()
      expect(seam).toHaveBeenCalledTimes(1)
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-09-40 settled with no listener: delivered at the next open, after open() resolves and after the idle report; nothing resumes',
    async () => {
      const first = await makeHost()
      const c1 = await child(first)
      first.kit.queue(answer('done'))
      expect(await c1.submitUser('task', { requestId: 'R', driven: DRIVEN })).toEqual({})
      await sleep(30)
      expect(await marker(c1)).toMatchObject({ requestId: 'R' })

      const log: string[] = []
      let opened = false
      const seam = seamSpy(() => {
        log.push(`seam:opened=${opened}`)
      })
      const t2 = await first.restart({
        onDrivenSettled: seam,
        onRunStateChange: (sessionId, state) => log.push(`state:${sessionId}:${state}`)
      })
      const session = await t2.open('c1')
      opened = true
      await waitFor(() => seam.mock.calls.length === 1, 3000, 'seam called')
      expect(log).toEqual(['state:c1:idle', 'seam:opened=true'])
      expect(seam.mock.calls[0]![0]).toMatchObject({
        sessionId: 'c1',
        requestId: 'R',
        result: {},
        record: { status: 'done' }
      })
      expect(await scheduling(session)).toBe('paused')
      expect(t2.kit.callCount).toBe(0)
      await waitFor(async () => (await marker(session)) === undefined, 3000, 'marker cleared')

      const third = seamSpy()
      const t3 = await t2.restart({ onDrivenSettled: third, onRunStateChange: undefined })
      await t3.open('c1')
      await sleep(50)
      expect(third).not.toHaveBeenCalled()
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-09-41 a rejecting callback: one warning, the marker is kept, no retry in the same process; after a restart one call clears it',
    async () => {
      const failing = seamSpy(async () => {
        throw new Error('parent unreachable')
      })
      const first = await makeHost({ onDrivenSettled: failing })
      const c1 = await child(first)
      first.kit.queue(answer('done'))
      expect(await c1.submitUser('task', { requestId: 'R', driven: DRIVEN })).toEqual({})
      await waitFor(() => failing.mock.calls.length === 1, 3000, 'seam called')
      await sleep(500)
      expect(failing).toHaveBeenCalledTimes(1)
      expect(
        first.warnings.filter((warning) => warning.includes('parent unreachable'))
      ).toHaveLength(1)
      expect(await marker(c1)).toMatchObject({ requestId: 'R' })

      // 同一进程里关了再开（LRU 的形状）也不重报
      await withTimeout(first.host.close('c1'), 5000, 'close')
      const again = await first.open('c1')
      await sleep(100)
      expect(failing).toHaveBeenCalledTimes(1)
      expect(await marker(again)).toMatchObject({ requestId: 'R' })

      const seam = seamSpy()
      const t2 = await first.restart({ onDrivenSettled: seam })
      const session = await t2.open('c1')
      await waitFor(() => seam.mock.calls.length === 1, 3000, 'seam called after restart')
      await waitFor(async () => (await marker(session)) === undefined, 3000, 'marker cleared')
      await sleep(50)
      expect(seam).toHaveBeenCalledTimes(1)
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-09-42 end to end: the parent gets exactly one completion notice across a crash between notify and the clear',
    async () => {
      const text = '<sub-session id="c1">done</sub-session>'
      const state: { current?: TestHost; crash: boolean } = { crash: true }
      const seam = seamSpy(async (event) => {
        const parent = await state.current!.host.open('P')
        await parent.notify(text, { kind: 'sub-session', requestId: event.noticeRequestId })
        if (state.crash) throw new Error('crashed before the clear')
      })
      const first = await makeHost({
        onDrivenSettled: seam,
        autoResume: (sessionId) => (sessionId === 'P' ? 'false' : undefined)
      })
      state.current = first
      const c1 = await child(first)
      first.kit.queue(answer('done'))
      expect(await c1.submitUser('task', { requestId: 'R', driven: DRIVEN })).toEqual({})
      await waitFor(() => seam.mock.calls.length === 1, 3000, 'seam called')
      await waitFor(
        async () =>
          (await transcript(await (await first.open('P')).currentConversation())).length === 1,
        3000,
        'parent notice'
      )
      await sleep(50)
      expect(await marker(c1)).toMatchObject({ requestId: 'R' })

      state.crash = false
      const t2 = await first.restart()
      state.current = t2
      const reopened = await t2.open('c1')
      await waitFor(() => seam.mock.calls.length === 2, 3000, 'seam called again')
      await waitFor(async () => (await marker(reopened)) === undefined, 3000, 'marker cleared')
      const parent = await t2.open('P')
      expect(await transcript(await parent.currentConversation())).toEqual([
        `shuvix.notice:${text}`
      ])
      expect(seam.mock.calls[1]![0].noticeRequestId).toBe(seam.mock.calls[0]![0].noticeRequestId)
    },
    RESTART_TIMEOUT
  )

  it('P2-09-43 (a) a re-attach re-arms a missing marker; (b) a new driven prompt replaces the marker', async () => {
    const seam = seamSpy()
    const t = await makeHost({ onDrivenSettled: seam })
    const c1 = await child(t)

    // (a) 受理与写标记之间崩溃的形状：直接经 harness 受理，没有标记
    const run = held(answer('done'))
    t.kit.queue(run.step)
    await (
      await c1.currentConversation()
    ).submit({ type: 'input', content: 'task', requestId: 'R' }, BG)
    await run.reached
    expect(await marker(c1)).toBeUndefined()
    const reattach = c1.submitUser('task', {
      requestId: 'R',
      driven: { parentId: 'P', background: false }
    })
    await waitFor(async () => (await marker(c1))?.requestId === 'R', 3000, 'marker armed')
    run.release()
    expect(await reattach).toEqual({})
    await waitFor(() => seam.mock.calls.length === 1, 3000, 'seam called')
    expect(seam.mock.calls[0]![0]).toMatchObject({ requestId: 'R', background: false })
    await waitFor(async () => (await marker(c1)) === undefined, 3000, 'marker cleared')

    // (b) 一个已落定、回调还没跑的 R1 标记；新的驱动发送 R2 替换它
    t.kit.queue(answer('r1'))
    expect(await c1.submitUser('first', { requestId: 'R1' })).toEqual({})
    await c1.harness.commit(async (tx) => {
      ;(await tx.doc(SessionStateDoc)).driven = {
        requestId: 'R1',
        parentId: 'P',
        background: true,
        conversationId: ROOT
      }
    }, BG)
    t.kit.queue(answer('r2'))
    let armed: Promise<SessionState | undefined> | undefined
    expect(
      await c1.submitUser('second', {
        requestId: 'R2',
        driven: DRIVEN,
        onAdmitted: () => {
          armed = c1.harness.snapshot(SessionStateDoc, BG)
        }
      })
    ).toEqual({})
    expect((await armed!)?.driven?.requestId).toBe('R2')
    await waitFor(() => seam.mock.calls.length === 2, 3000, 'R2 reported')
    await sleep(50)
    expect(seam.mock.calls.map(([event]) => event.requestId)).toEqual(['R', 'R2'])
    await waitFor(async () => (await marker(c1)) === undefined, 3000, 'marker cleared')
  })

  it(
    "P2-09-44 abort-then-send on an interrupted driven run: one call for R (aborted); the marker clears; 'new' runs",
    async () => {
      const seam = seamSpy()
      const { t } = await crashWith({
        requestId: 'R',
        driven: DRIVEN,
        restart: { onDrivenSettled: seam }
      })
      const session = await t.open()
      t.kit.queue(answer('fresh'))
      expect(await withTimeout(session.submitUser('new'), 5000, 'send')).toEqual({})
      await waitFor(() => seam.mock.calls.length === 1, 3000, 'seam called')
      expect(seam.mock.calls[0]![0]).toMatchObject({
        requestId: 'R',
        result: {},
        record: { status: 'unanswered', reason: 'aborted' }
      })
      await waitFor(async () => (await marker(session)) === undefined, 3000, 'marker cleared')
      expect(await transcript(await session.currentConversation())).toEqual([
        'pi.user:hello',
        'pi.user:new',
        'pi.assistant:fresh'
      ])
      await sleep(50)
      expect(seam).toHaveBeenCalledTimes(1)
    },
    RESTART_TIMEOUT
  )
})
