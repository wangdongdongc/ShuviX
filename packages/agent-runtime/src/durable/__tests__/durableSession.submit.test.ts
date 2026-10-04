/**
 * 发送面：submitUser（R3 结果形状、whenBusy、幂等、残留队列、显示侧车）、steer（R4）、followUp。
 */
import { InboxDoc, ROOT_CONVERSATION_ID, type SubmissionRecord } from '@earendil-works/pi-durable'
import type { UserInput } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { DisplayDoc } from '../docs'
import { settlementResult, type DurableSession } from '../durableSession'
import { testProfile } from './support/agentConfig'
import { answer, callTool, held, modelError, stalled } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup } from './support/host'
import { askingTool, holdTool } from './support/tools'
import { allEntries, requestTexts, transcript } from './support/transcript'
import { deferred, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

async function inboxModes(session: DurableSession): Promise<string[]> {
  const inbox = await session.harness.snapshot(InboxDoc, ROOT_CONVERSATION_ID, BG)
  return (inbox?.items ?? []).map((item) => item.mode)
}

async function submissionStatus(session: DurableSession, id: number): Promise<SubmissionRecord> {
  const submission = await session.harness.submission(id as never, BG)
  return submission!.status(BG)
}

describe('submitUser', () => {
  it('U-01 idle submit places a pi.user entry, runs, and resolves {} once the answer exists', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(answer('a1'))
    expect(await session.submitUser('u1')).toEqual({})
    expect(await transcript(await session.currentConversation())).toEqual([
      'pi.user:u1',
      'pi.assistant:a1'
    ])
  })

  it('U-02 array content (text + image) is stored verbatim', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(answer('seen'))
    const content: UserInput = [
      { type: 'text', text: 'look at this' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
    ]
    expect(await session.submitUser(content)).toEqual({})
    const user = (await allEntries(await session.currentConversation())).find(
      (entry) => entry.kind === 'pi.user'
    )!
    expect(user.model?.[0]).toMatchObject({ role: 'user', content })
  })

  it("U-03 whenBusy 'reject' while busy → busy, nothing appended or queued; the run is unaffected", async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    const run = held(answer('a1'))
    t.kit.queue(run.step)
    const first = session.submitUser('u1')
    await run.reached
    const before = await session.harness.inspect(BG)
    expect(await session.submitUser('u2')).toEqual({ error: expect.any(String), code: 'busy' })
    expect(await session.submitUser('u3', { whenBusy: 'reject' })).toMatchObject({ code: 'busy' })
    expect(await inboxModes(session)).toEqual([])
    expect((await session.harness.inspect(BG)).submissions).toEqual(before.submissions)
    expect(await transcript(await session.currentConversation())).toEqual(['pi.user:u1'])
    run.release()
    expect(await first).toEqual({})
    expect(await transcript(await session.currentConversation())).toEqual([
      'pi.user:u1',
      'pi.assistant:a1'
    ])
  })

  it("U-04 whenBusy 'followUp' queues and resolves after its own run", async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    const run = held(answer('a1'))
    t.kit.queue(run.step, answer('a2'))
    const first = session.submitUser('u1')
    await run.reached
    let secondDone = false
    const second = session.submitUser('u2', { whenBusy: 'followUp' }).then((result) => {
      secondDone = true
      return result
    })
    await waitFor(async () => (await inboxModes(session)).length === 1, 3000, 'queued')
    expect(await inboxModes(session)).toEqual(['followUp'])
    run.release()
    expect(await first).toEqual({})
    expect(await second).toEqual({})
    expect(secondDone).toBe(true)
    expect(await transcript(await session.currentConversation())).toEqual([
      'pi.user:u1',
      'pi.assistant:a1',
      'pi.user:u2',
      'pi.assistant:a2'
    ])
  })

  it('U-05 a non-retryable model error → { error, code: model_error }', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(modelError('boom'))
    expect(await session.submitUser('u1')).toEqual({ error: 'boom', code: 'model_error' })
  })

  it('U-06 no model configured → { error, code: no_model } (the runtime refuses to create the agent, K4)', async () => {
    const t = await makeHost({ agentConfig: { profile: testProfile() } })
    const session = await t.open()
    const result = await session.submitUser('u1')
    expect(result.code).toBe('no_model')
    expect(result.error).toBeTruthy()
    expect(t.kit.callCount).toBe(0)
  })

  it('U-07 abort while in flight → {}', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    const stall = stalled()
    t.kit.queue(stall.step)
    const result = session.submitUser('u1')
    await stall.reached
    await withTimeout(session.abort(), 5000, 'abort')
    expect(await withTimeout(result, 2000, 'submit')).toEqual({})
  })

  it('U-08 a withdrawn follow-up → {}', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    const stall = stalled()
    t.kit.queue(stall.step)
    const first = session.submitUser('u1')
    await stall.reached
    const second = session.submitUser('u2', { whenBusy: 'followUp' })
    await waitFor(async () => (await inboxModes(session)).length === 1, 3000, 'queued')
    await withTimeout(session.abort(), 5000, 'abort')
    expect(await first).toEqual({})
    expect(await withTimeout(second, 2000, 'withdrawn')).toEqual({})
    expect(await inboxModes(session)).toEqual([])
  })

  it.each([
    [{ status: 'done' }, {}],
    [
      { status: 'unanswered', reason: 'model_error', detail: 'boom' },
      { error: 'boom', code: 'model_error' }
    ],
    [
      { status: 'unanswered', reason: 'model_error' },
      { error: expect.any(String), code: 'model_error' }
    ],
    [
      { status: 'unanswered', reason: 'no_model' },
      { error: expect.any(String), code: 'no_model' }
    ],
    [{ status: 'unanswered', reason: 'aborted' }, {}],
    [{ status: 'unanswered', reason: 'stale' }, {}],
    [{ status: 'unanswered', reason: 'reset' }, {}],
    [
      { status: 'unanswered', reason: 'faulted', detail: 'task bug' },
      { error: 'task bug', code: 'faulted' }
    ],
    [
      { status: 'unanswered', reason: 'orphaned' },
      { error: expect.any(String), code: 'orphaned' }
    ],
    [
      { status: 'unanswered', reason: 'missing_task' },
      { error: expect.stringContaining('missing_task'), code: 'orphaned' }
    ],
    [{ status: 'unanswered', reason: 'something new' }, { error: 'something new' }],
    [
      { status: 'unanswered', reason: 'model_error', detail: { status: 500 } },
      { error: '{"status":500}', code: 'model_error' }
    ]
  ] as const)('U-09 settlement %j → %j', (record, expected) => {
    expect(settlementResult(record)).toEqual(expected)
  })

  it('U-10 the same requestId twice → one entry, one run, both {}', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(answer('a1'))
    const results = await Promise.all([
      session.submitUser('u1', { requestId: 'q1' }),
      session.submitUser('u1', { requestId: 'q1' })
    ])
    expect(results).toEqual([{}, {}])
    expect(await session.submitUser('u1', { requestId: 'q1' })).toEqual({})
    expect(await transcript(await session.currentConversation())).toEqual([
      'pi.user:u1',
      'pi.assistant:a1'
    ])
    expect(t.kit.callCount).toBe(1)
  })

  it('U-11 a queue left by a failed run goes out with the next send, in one request', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    const run = held(modelError('boom'))
    t.kit.queue(run.step)
    const first = session.submitUser('u1')
    await run.reached
    const leftover = session.submitUser('F', { whenBusy: 'followUp' })
    await waitFor(async () => (await inboxModes(session)).length === 1, 3000, 'queued')
    run.release()
    expect(await first).toEqual({ error: 'boom', code: 'model_error' })
    expect(await inboxModes(session)).toEqual(['followUp'])
    t.kit.queue(answer('both'))
    expect(await session.submitUser('next')).toEqual({})
    expect(await leftover).toEqual({})
    const texts = requestTexts(t.kit, 1)
    expect(texts.slice(-2)).toEqual(['user:F', 'user:next'])
    expect(t.kit.callCount).toBe(2)
  })

  it('U-12 after an abort, submitUser reopens inputs (an ask in the new run pends)', async () => {
    const ref: { session?: DurableSession } = {}
    const tools = [askingTool('askme', () => ref.session!)]
    const t = await makeHost({ tools })
    const session = (ref.session = await t.open())
    await primeRoot(session, t.kit)
    await withTimeout(session.abort(), 5000, 'idle abort')
    expect(
      await session.requestUserInput({
        id: 'probe',
        kind: 'ask',
        toolName: 'x',
        command: 'y',
        createdAt: 0
      })
    ).toEqual({ kind: 'cancel', reason: 'aborted' })
    t.kit.queue(callTool('askme'), answer('done'))
    const result = session.submitUser('go')
    await waitFor(() => session.pendingInputCount === 1, 3000, 'ask pending')
    expect(session.respondToInput('call-askme', { kind: 'ask', allowed: true })).toBe(true)
    expect(await result).toEqual({})
    const toolResult = (await transcript(await session.currentConversation())).find((line) =>
      line.startsWith('pi.tool-result:')
    )
    expect(toolResult).toContain('"allowed":true')
  })

  it('U-13 a display sidecar is stored in DisplayDoc under the submission requestId; none without display', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(answer('a1'), answer('a2'))
    const display = { text: 'see @file', tokens: { file: { kind: 'file', path: '/x' } } }
    expect(await session.submitUser('see /x', { display })).toEqual({})
    const doc = await session.harness.snapshot(DisplayDoc, ROOT_CONVERSATION_ID, BG)
    const keys = Object.keys(doc!.items)
    expect(keys).toHaveLength(1)
    expect(doc!.items[keys[0]!]).toEqual(display)
    const user = (await allEntries(await session.currentConversation())).find(
      (entry) => entry.kind === 'pi.user'
    )!
    const record = await session.harness.commit(
      (tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, keys[0]!),
      BG
    )
    expect(record).toMatchObject({ requestId: keys[0], type: 'input', entry: user.id })

    expect(await session.submitUser('plain')).toEqual({})
    expect(
      Object.keys((await session.harness.snapshot(DisplayDoc, ROOT_CONVERSATION_ID, BG))!.items)
    ).toEqual(keys)

    // 给了 requestId 就用它作键
    t.kit.queue(answer('a3'))
    await session.submitUser('again', { display: { text: 'again' }, requestId: 'mine' })
    expect(
      (await session.harness.snapshot(DisplayDoc, ROOT_CONVERSATION_ID, BG))!.items.mine
    ).toEqual({ text: 'again' })
  })
})

describe('steer', () => {
  it('ST-01 a steer during a held tool round joins the next request after the tool result; one run', async () => {
    const gate = deferred()
    const running = deferred()
    const t = await makeHost({
      tools: [holdTool('hold', gate.promise, { onRun: () => running.resolve() })]
    })
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(callTool('hold'), answer('done'))
    const result = session.submitUser('go')
    await running.promise
    const steer = await session.steer('S')
    expect(steer.submissionId).toBeDefined()
    gate.resolve()
    expect(await result).toEqual({})
    expect(requestTexts(t.kit, 1).slice(-2)).toEqual(['toolResult:hold done', 'user:S'])
    expect(t.kit.callCount).toBe(2)
    expect((await submissionStatus(session, steer.submissionId!)).status).toBe('done')
  })

  it("ST-02 two steers land in the same next request ('all')", async () => {
    const gate = deferred()
    const running = deferred()
    const t = await makeHost({
      tools: [holdTool('hold', gate.promise, { onRun: () => running.resolve() })]
    })
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(callTool('hold'), answer('done'))
    const result = session.submitUser('go')
    await running.promise
    await session.steer('S1')
    await session.steer('S2')
    gate.resolve()
    expect(await result).toEqual({})
    expect(requestTexts(t.kit, 1).slice(-3)).toEqual(['toolResult:hold done', 'user:S1', 'user:S2'])
    expect(t.kit.callCount).toBe(2)
  })

  it('ST-03 a steer while idle starts a run (R4) and reopens inputs', async () => {
    const ref: { session?: DurableSession } = {}
    const tools = [askingTool('askme', () => ref.session!)]
    const t = await makeHost({ tools })
    const session = (ref.session = await t.open())
    await primeRoot(session, t.kit)
    await withTimeout(session.abort(), 5000, 'idle abort')
    t.kit.queue(callTool('askme'), answer('done'))
    const steer = await session.steer('S')
    expect(steer.submissionId).toBeDefined()
    await waitFor(() => session.pendingInputCount === 1, 3000, 'ask pending')
    session.respondToInput('call-askme', { kind: 'ask', allowed: true })
    const submission = await session.harness.submission(steer.submissionId!, BG)
    expect((await withTimeout(submission!.wait(BG), 3000, 'steer run')).status).toBe('done')
    expect((await transcript(await session.currentConversation()))[0]).toBe('pi.user:S')
  })
})

describe('followUp', () => {
  it('FU-01 two follow-ups during a held text answer → one new run with both', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    const run = held(answer('a1'))
    t.kit.queue(run.step, answer('both'))
    const first = session.submitUser('u1')
    await run.reached
    await session.followUp('f1')
    const f2 = await session.followUp('f2')
    run.release()
    expect(await first).toEqual({})
    const submission = await session.harness.submission(f2.submissionId!, BG)
    expect((await withTimeout(submission!.wait(BG), 3000, 'follow-ups')).status).toBe('done')
    expect(t.kit.callCount).toBe(2)
    expect(requestTexts(t.kit, 1).slice(-2)).toEqual(['user:f1', 'user:f2'])
  })

  it('FU-02 a follow-up while idle starts a run', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(answer('a'))
    const followUp = await session.followUp('f')
    const submission = await session.harness.submission(followUp.submissionId!, BG)
    expect((await withTimeout(submission!.wait(BG), 3000, 'run')).status).toBe('done')
    expect(await transcript(await session.currentConversation())).toEqual([
      'pi.user:f',
      'pi.assistant:a'
    ])
  })

  it('FU-03 abort withdraws queued inputs but keeps queued writes; the next send places the write first', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    const stall = stalled()
    t.kit.queue(stall.step)
    const first = session.submitUser('u1')
    await stall.reached
    const followUp = await session.followUp('f1')
    const notice = await session.writeNotice({ text: 'N', kind: 'background' })
    expect(notice.status).toBe('submitted')
    expect(await inboxModes(session)).toEqual(['followUp', 'write'])
    await withTimeout(session.abort(), 5000, 'abort')
    expect(await first).toEqual({})
    expect(await submissionStatus(session, followUp.submissionId!)).toMatchObject({
      status: 'unanswered',
      reason: 'aborted'
    })
    expect(await inboxModes(session)).toEqual(['write'])
    const lines = await transcript(await session.currentConversation())
    expect(lines.some((line) => line.startsWith('shuvix.notice'))).toBe(false)
    t.kit.queue(answer('a2'))
    expect(await session.submitUser('u2')).toEqual({})
    expect((await transcript(await session.currentConversation())).slice(-3)).toEqual([
      'shuvix.notice:N',
      'pi.user:u2',
      'pi.assistant:a2'
    ])
  })
})
