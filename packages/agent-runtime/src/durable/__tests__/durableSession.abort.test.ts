/**
 * 中止：顺序（关询问窗口 → 中止前 seam → 取消挂起的询问 → 中止对话）、不死锁、空闲 / 并发 /
 * 与收尾赛跑、只作用于当前对话、每条起跑路径都重开询问窗口、被中断的会话上中止不重发。
 */
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import type { DurableSession } from '../durableSession'
import { answer, callTool, held, stalled } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup, type TestHost } from './support/host'
import { askingTool } from './support/tools'
import { deferred, sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const probe = (id: string): InputRequest => ({
  id,
  kind: 'ask',
  toolName: 'probe',
  command: 'probe',
  createdAt: 0
})

/** 挂起一条探针询问，断言它真的挂起了，再应答掉 */
async function expectInputsOpen(session: DurableSession, id: string): Promise<void> {
  const pending = session.requestUserInput(probe(id))
  expect(session.pendingInputCount).toBe(1)
  session.respondToInput(id, { kind: 'ask', allowed: true })
  await expect(pending).resolves.toEqual({ kind: 'ask', allowed: true })
}

async function expectInputsClosed(session: DurableSession, id: string): Promise<void> {
  await expect(session.requestUserInput(probe(id))).resolves.toEqual({
    kind: 'cancel',
    reason: 'aborted'
  })
  expect(session.pendingInputCount).toBe(0)
}

async function placedSubmissionId(session: DurableSession): Promise<number> {
  const placed = (await session.harness.inspect(BG)).submissions.filter(
    (submission) => submission.status === 'placed'
  )
  expect(placed).toHaveLength(1)
  return placed[0]!.id
}

async function askingSession(options: Parameters<typeof askingTool>[2] = {}): Promise<{
  t: TestHost
  session: DurableSession
}> {
  const ref: { session?: DurableSession } = {}
  const t = await makeHost({ tools: [askingTool('askme', () => ref.session!, options)] })
  const session = (ref.session = await t.open())
  await primeRoot(session, t.kit)
  return { t, session }
}

describe('abort', () => {
  it('AB-01 abort with a pending ask resolves fast; the ask is cancelled; the run ends aborted', async () => {
    let response: InputResponse | undefined
    const { t, session } = await askingSession({ onResolved: (r) => (response = r) })
    t.kit.queue(callTool('askme'), answer('not reached'))
    const result = session.submitUser('go')
    await waitFor(() => session.pendingInputCount === 1, 3000, 'ask pending')
    const submissionId = await placedSubmissionId(session)
    await withTimeout(session.abort(), 2000, 'abort with ask')
    expect(response).toEqual({ kind: 'cancel', reason: 'aborted' })
    expect(session.pendingInputCount).toBe(0)
    expect(
      t.broadcasts.some(
        (event) => event.type === 'input_request_resolved' && event.requestId === 'call-askme'
      )
    ).toBe(true)
    const submission = await session.harness.submission(submissionId as never, BG)
    expect(await submission!.status(BG)).toMatchObject({ status: 'unanswered', reason: 'aborted' })
    expect(await result).toEqual({})
    expect(session.isBusy()).toBe(false)
    expect(t.kit.callCount).toBe(1)
  })

  it('AB-02 the ask is cancelled before the conversation abort signals the tool', async () => {
    let signalAborted: boolean | undefined
    const { t, session } = await askingSession({
      onResolved: (_response, aborted) => (signalAborted = aborted)
    })
    t.kit.queue(callTool('askme'), answer('not reached'))
    void session.submitUser('go')
    await waitFor(() => session.pendingInputCount === 1, 3000, 'ask pending')
    await withTimeout(session.abort(), 2000, 'abort')
    expect(signalAborted).toBe(false)
  })

  it('AB-03 no deadlock: a signal-deaf tool that asks after abort started gets an immediate cancel', async () => {
    const gate = deferred()
    const started = deferred()
    let response: InputResponse | undefined
    const { t, session } = await askingSession({
      gate: gate.promise,
      onStart: () => started.resolve(),
      onResolved: (r) => (response = r)
    })
    t.kit.queue(callTool('askme'), answer('not reached'))
    const result = session.submitUser('go')
    await started.promise
    let aborted = false
    const aborting = session.abort().then(() => (aborted = true))
    await sleep(50)
    expect(aborted).toBe(false)
    gate.resolve()
    await withTimeout(aborting, 3000, 'abort after late ask')
    expect(response).toEqual({ kind: 'cancel', reason: 'aborted' })
    expect(session.pendingInputCount).toBe(0)
    expect(t.broadcasts.some((event) => event.type === 'input_request')).toBe(false)
    expect(await result).toEqual({})
  })

  it('AB-04 abort while idle resolves; inputs stay closed until the next run-starting call', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    await withTimeout(session.abort(), 2000, 'idle abort')
    await expectInputsClosed(session, 'p1')
    await expectInputsClosed(session, 'p2')
    t.kit.queue(answer('a'))
    expect(await session.submitUser('u')).toEqual({})
    await expectInputsOpen(session, 'p3')
  })

  it('AB-05 concurrent aborts both resolve; an abort racing a finishing run resolves', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    const stall = stalled()
    t.kit.queue(stall.step)
    const first = session.submitUser('u1')
    await stall.reached
    await withTimeout(Promise.all([session.abort(), session.abort()]), 3000, 'two aborts')
    expect(await first).toEqual({})

    const run = held(answer('a2'))
    t.kit.queue(run.step)
    const second = session.submitUser('u2')
    await run.reached
    run.release()
    await withTimeout(session.abort(), 3000, 'abort racing the answer')
    expect(await second).toEqual({})
    expect(session.isBusy()).toBe(false)
  })

  it("AB-06 abort targets the current conversation; another conversation's run is unaffected", async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    const stall = stalled()
    t.kit.queue(stall.step)
    const mine = session.submitUser('mine')
    await stall.reached
    const other = await session.harness.createConversation({ ownership: { kind: 'ownerless' } }, BG)
    await other.configure({ model: t.kit.model }, BG)
    const side = held(answer('side done'))
    t.kit.queue(side.step)
    const submission = await other.submit({ type: 'input', content: 'side' }, BG)
    await side.reached
    await withTimeout(session.abort(), 3000, 'abort current')
    expect(await mine).toEqual({})
    expect((await submission.status(BG)).status).toBe('placed')
    expect(session.runState).toBe('busy')
    side.release()
    expect((await withTimeout(submission.wait(BG), 3000, 'side run')).status).toBe('done')
  })

  it('AB-07 every run-starting path reopens inputs (followUp, steer, submitUser); continue on an idle session is a no-op', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)

    await session.abort()
    await expectInputsClosed(session, 'c1')
    t.kit.queue(answer('f'))
    const followUp = await session.followUp('f')
    await expectInputsOpen(session, 'o1')
    await (await session.harness.submission(followUp.submissionId!, BG))!.wait(BG)

    await session.abort()
    await expectInputsClosed(session, 'c2')
    t.kit.queue(answer('s'))
    const steer = await session.steer('s')
    await expectInputsOpen(session, 'o2')
    await (await session.harness.submission(steer.submissionId!, BG))!.wait(BG)

    await session.abort()
    await expectInputsClosed(session, 'c3')
    // P3-10a 裁定：空闲且没被中断的 continue 什么都不做 —— 不起 run，也不重开询问
    expect(await session.continue()).toEqual({})
    await expectInputsClosed(session, 'c3b')

    await session.abort()
    await expectInputsClosed(session, 'c4')
    t.kit.queue(answer('u'))
    expect(await session.submitUser('u')).toEqual({})
    await expectInputsOpen(session, 'o4')
  })

  it('AB-08 abort on an interrupted session resolves without re-sending; the old submission ends aborted', async () => {
    const first = await makeHost()
    const original = await first.open()
    await primeRoot(original, first.kit)
    const stall = stalled()
    first.kit.queue(stall.step)
    void original.submitUser('hello')
    await stall.reached
    const t = await first.restart()
    const session = await t.open()
    expect(session.isInterrupted()).toBe(true)
    const submissionId = await placedSubmissionId(session)
    await withTimeout(session.abort(), 3000, 'abort interrupted')
    expect(t.kit.callCount).toBe(0)
    expect(session.isInterrupted()).toBe(false)
    expect(session.isBusy()).toBe(false)
    const submission = await session.harness.submission(submissionId as never, BG)
    expect(await submission!.status(BG)).toMatchObject({ status: 'unanswered', reason: 'aborted' })
  })

  it('AB-09 the before-abort seam runs after inputs close and before the asks are cancelled and the conversation aborts', async () => {
    const ref: { session?: DurableSession } = {}
    const seen: { busy: boolean; pending: number; probe?: Promise<InputResponse> }[] = []
    const t = await makeHost({
      tools: [askingTool('askme', () => ref.session!)],
      beforeAbort: (sessionId) => {
        expect(sessionId).toBe('s1')
        const current = ref.session!
        seen.push({
          busy: current.isBusy(),
          pending: current.pendingInputCount,
          probe: current.requestUserInput(probe('inside'))
        })
      }
    })
    const session = (ref.session = await t.open())
    await primeRoot(session, t.kit)
    t.kit.queue(callTool('askme'), answer('not reached'))
    void session.submitUser('go')
    await waitFor(() => session.pendingInputCount === 1, 3000, 'ask pending')
    await withTimeout(session.abort(), 2000, 'abort')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.busy).toBe(true)
    expect(seen[0]!.pending).toBe(1)
    await expect(seen[0]!.probe).resolves.toEqual({ kind: 'cancel', reason: 'aborted' })
    expect(session.pendingInputCount).toBe(0)
    expect(session.isBusy()).toBe(false)
  })
})
