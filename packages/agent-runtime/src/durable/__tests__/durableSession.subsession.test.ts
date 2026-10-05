/**
 * P2-09 · 子会话的查询与续跑原语：
 *
 *  - B `requestState(requestId)`：none / pending / settled，不分类型，只看当前对话，只读；
 *  - C `resumeInterrupted()`：不等空闲的「继续」；没被中断 = 严格的无操作（PIN-06）；
 *  - D `lastAnswer()`：当前对话这一轮的回答 —— 从新到旧，先碰到 pi.user 就是还没有回答（PIN-07），
 *    压缩不藏、fork 感知（PIN-08），从不开启调度器。
 *
 * 重启用例都用 SQLite、真实计时器、约 15 秒的超时。
 */
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai'
import {
  AssistantEntry,
  CompactionEntry,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type SubmissionId
} from '@earendil-works/pi-durable'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import { backgroundContext as BG } from '../context'
import { SessionStateDoc } from '../docs'
import { SessionClosedError, type DurableSession } from '../durableSession'
import { testProfile } from './support/agentConfig'
import { recordPublications } from './support/commits'
import { crashWith } from './support/crash'
import { answer, callTool, held, modelError, stalled } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup, TEST_SETTINGS_OVERRIDES } from './support/host'
import { wKit } from './support/scenario'
import { hookRec, liveTasks, seedAgent, startRun, TEST_SPAWN_EXTENSION } from './support/spawn'
import { askingTool } from './support/tools'
import { allEntries, transcript } from './support/transcript'
import { sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const RESTART_TIMEOUT = 15000
const ROOT = ROOT_CONVERSATION_ID

async function scheduling(session: DurableSession): Promise<string> {
  return (await session.harness.inspect(BG)).scheduling
}

async function lines(session: DurableSession): Promise<string[]> {
  return transcript(await session.currentConversation())
}

async function placedSubmissionId(session: DurableSession): Promise<SubmissionId> {
  const placed = (await session.harness.inspect(BG)).submissions.filter(
    (submission) => submission.status === 'placed'
  )
  expect(placed).toHaveLength(1)
  return placed[0]!.id
}

async function point(session: DurableSession, id: ConversationId | number): Promise<void> {
  await session.harness.commit(async (tx) => {
    ;(await tx.doc(SessionStateDoc)).currentConversation = id as ConversationId
  }, BG)
}

/** 手工追加一条 pi.assistant 条目 */
async function appendAssistant(session: DurableSession, message: AssistantMessage): Promise<void> {
  await session.harness.commit(async (tx) => {
    await tx.appendEntry(AssistantEntry, ROOT, { model: [message] })
  }, BG)
}

describe('requestState', () => {
  it('P2-09-16 lifecycle: none → pending (placed, queued follow-up) → settled (answer, model error, withdrawn follow-up, write id)', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session)
    expect(await session.requestState('p')).toBe('none')

    const run = held(answer('a'))
    t.kit.queue(run.step, answer('aF'))
    const placed = session.submitUser('u', { requestId: 'p' })
    await run.reached
    expect(await session.requestState('p')).toBe('pending')
    const followUp = session.submitUser('F', { requestId: 'f', whenBusy: 'followUp' })
    await waitFor(async () => (await session.requestState('f')) === 'pending', 3000, 'queued')
    run.release()
    expect(await placed).toEqual({})
    expect(await followUp).toEqual({})
    expect(await session.requestState('p')).toBe('settled')
    expect(await session.requestState('f')).toBe('settled')

    t.kit.queue(modelError('boom'))
    expect(await session.submitUser('e', { requestId: 'e' })).toMatchObject({
      code: 'model_error'
    })
    expect(await session.requestState('e')).toBe('settled')

    const second = held(answer('never'))
    t.kit.queue(second.step)
    const running = session.submitUser('long')
    await second.reached
    const withdrawn = session.submitUser('W', { requestId: 'w', whenBusy: 'followUp' })
    await waitFor(async () => (await session.requestState('w')) === 'pending', 3000, 'queued w')
    await withTimeout(session.abort(), 5000, 'abort')
    expect(await running).toEqual({})
    expect(await withdrawn).toEqual({})
    expect(await session.requestState('w')).toBe('settled')

    await session.writeNotice({ text: 'N', kind: 'background', requestId: 'n' })
    expect(await session.requestState('n')).toBe('settled')
  })

  it(
    'P2-09-17 after a restart: the interrupted id is pending — read-only, paused, no publication; settled once a fresh send aborts it',
    async () => {
      const { t } = await crashWith({ requestId: 'R' })
      const session = await t.open()
      const recorder = recordPublications(session.harness)
      expect(await session.requestState('R')).toBe('pending')
      recorder.stop()
      expect(recorder.publications).toEqual([])
      expect(await scheduling(session)).toBe('paused')
      await sleep(50)
      expect(t.kit.callCount).toBe(0)
      t.kit.queue(answer('fresh'))
      expect(await withTimeout(session.submitUser('new'), 5000, 'send')).toEqual({})
      expect(await session.requestState('R')).toBe('settled')
    },
    RESTART_TIMEOUT
  )

  it('P2-09-18 scope is the current conversation; a closed handle rejects with SessionClosedError', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session)
    const side = await session.harness.createConversation({ ownership: { kind: 'ownerless' } }, BG)
    await session.harness.commit(async (tx) => {
      await tx.createSubmission({
        conversationId: side.id,
        requestId: 'S',
        type: 'write',
        status: 'unanswered',
        reason: 'stale'
      })
    }, BG)
    expect(await session.requestState('S')).toBe('none')

    t.kit.queue(answer('a1'))
    expect(await session.submitUser('u1', { requestId: 'Y' })).toEqual({})
    const root = await session.currentConversation()
    const firstAnswer = (await allEntries(root)).find((entry) => entry.kind === 'pi.assistant')!
    const fork = await root.fork(firstAnswer.id, { ownership: { kind: 'ownerless' } }, BG)
    await point(session, fork.id)
    expect(await session.requestState('Y')).toBe('none')
    await point(session, ROOT)
    expect(await session.requestState('Y')).toBe('settled')

    await withTimeout(t.host.close('s1'), 5000, 'close')
    await expect(session.requestState('Y')).rejects.toBeInstanceOf(SessionClosedError)
  })
})

describe('resumeInterrupted', () => {
  it(
    'P2-09-19 a non-waiting continue: resolves while the request is held; the deferred notice lands once after the answer',
    async () => {
      const { t } = await crashWith()
      const session = await t.open()
      const old = await placedSubmissionId(session)
      expect(
        await session.writeNotice({ text: 'N', kind: 'background', requestId: 'n' })
      ).toMatchObject({ status: 'deferred' })
      const run = held(answer('x'))
      t.kit.queue(run.step)
      expect(await withTimeout(session.resumeInterrupted(), 3000, 'resume')).toEqual({})
      await withTimeout(run.reached, 3000, 'request held')
      await waitFor(() => session.isBusy(), 3000, 'busy')
      run.release()
      const submission = (await session.harness.submission(old, BG))!
      expect((await withTimeout(submission.wait(BG), 3000, 'old submission')).status).toBe('done')
      await waitFor(
        async () => (await lines(session)).includes('shuvix.notice:N'),
        3000,
        'notice placed'
      )
      const all = await lines(session)
      expect(all.slice(-2)).toEqual(['pi.assistant:x', 'shuvix.notice:N'])
      expect(all.filter((line) => line === 'shuvix.notice:N')).toHaveLength(1)
      expect((await session.harness.snapshot(SessionStateDoc, BG))?.deferredNotices).toEqual([])
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-09-20 a strict no-op when not interrupted: (a) an idle restart; (b) only marked auxiliary work',
    async () => {
      // (a)
      const onInputsReopened = vi.fn()
      const first = await makeHost({ onInputsReopened })
      const s1 = await first.open()
      await primeRoot(s1)
      first.kit.queue(answer('a1'))
      expect(await s1.submitUser('u1')).toEqual({})
      const t = await first.restart()
      const session = await t.open()
      onInputsReopened.mockClear()
      const configCalls = t.configCalls.length
      const recorder = recordPublications(session.harness)
      expect(await session.resumeInterrupted()).toEqual({})
      recorder.stop()
      expect(recorder.publications).toEqual([])
      expect(await scheduling(session)).toBe('paused')
      expect(onInputsReopened).not.toHaveBeenCalled()
      expect(t.configCalls).toHaveLength(configCalls)
      await t.host.closeAll()

      // (b)
      const host = await makeHost({ makeKit: wKit, extensions: [TEST_SPAWN_EXTENSION] })
      const root = await host.open()
      await primeRoot(root)
      const seeded = await seedAgent(root, { record: hookRec() })
      const stall = stalled()
      host.kit.queue(stall.step)
      await startRun(root, seeded.conversationId, 'TITLE-ME')
      await stall.reached
      const t2 = await host.restart()
      const reopened = await t2.open()
      expect(reopened.isInterrupted()).toBe(false)
      const before = await liveTasks(reopened, seeded.conversationId)
      expect(before.length).toBeGreaterThan(0)
      expect(before.every((task) => task.abortRequested)).toBe(true)
      const configCalls2 = t2.configCalls.length
      const recorder2 = recordPublications(reopened.harness)
      expect(await reopened.resumeInterrupted()).toEqual({})
      recorder2.stop()
      expect(recorder2.publications).toEqual([])
      expect(await scheduling(reopened)).toBe('paused')
      expect(t2.configCalls).toHaveLength(configCalls2)
      await sleep(50)
      expect(t2.kit.callCount).toBe(0)
      const after = await liveTasks(reopened, seeded.conversationId)
      expect(after.map((task) => task.id)).toEqual(before.map((task) => task.id))
      expect(after.every((task) => task.abortRequested)).toBe(true)
    },
    RESTART_TIMEOUT * 2
  )

  it(
    'P2-09-21 reopens inputs: an ask in the resumed run pends and answering it completes the run',
    async () => {
      const ref: { session?: DurableSession } = {}
      const onInputsReopened = vi.fn()
      const { t } = await crashWith({
        host: { tools: [askingTool('askme', () => ref.session!)] },
        restart: { onInputsReopened }
      })
      const session = (ref.session = await t.open())
      onInputsReopened.mockClear()
      t.kit.queue(callTool('askme'), answer('done'))
      expect(await withTimeout(session.resumeInterrupted(), 3000, 'resume')).toEqual({})
      expect(onInputsReopened).toHaveBeenCalledTimes(1)
      await waitFor(() => session.pendingInputCount === 1, 3000, 'ask pending')
      expect(session.respondToInput('call-askme', { kind: 'ask', allowed: true })).toBe(true)
      await waitFor(
        async () => (await lines(session)).at(-1) === 'pi.assistant:done',
        3000,
        'run completed'
      )
      expect(onInputsReopened).toHaveBeenCalledTimes(1)
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-09-22 concurrent resumeInterrupted and continue: one request, both {}; a later resumeInterrupted is a no-op',
    async () => {
      const { t } = await crashWith()
      const session = await t.open()
      t.kit.queue(answer('x'))
      const results = await withTimeout(
        Promise.all([session.resumeInterrupted(), session.continue()]),
        5000,
        'both'
      )
      expect(results).toEqual([{}, {}])
      expect(t.kit.callCount).toBe(1)
      expect(await lines(session)).toEqual(['pi.user:hello', 'pi.assistant:x'])
      expect(await session.resumeInterrupted()).toEqual({})
      await sleep(50)
      expect(t.kit.callCount).toBe(1)
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-09-23 the agent is refused (lock cleared at reopen, no model): no_model; still interrupted and paused',
    async () => {
      const { t } = await crashWith({
        after: async (session) => {
          await session.harness.commit(async (tx) => {
            ;(await tx.doc(SessionStateDoc)).lock = { conversationId: ROOT, profileName: 'work' }
          }, BG)
        },
        restart: { agentConfig: { profile: testProfile() } }
      })
      const session = await t.open()
      expect(session.lock).toBeUndefined()
      expect(session.isInterrupted()).toBe(true)
      const result = await session.resumeInterrupted()
      expect(result).toEqual({ error: expect.any(String), code: 'no_model' })
      expect(session.isInterrupted()).toBe(true)
      expect(await scheduling(session)).toBe('paused')
      await sleep(50)
      expect(t.kit.callCount).toBe(0)
    },
    RESTART_TIMEOUT
  )
})

describe('lastAnswer', () => {
  it('P2-09-24 shapes: undefined when nothing answered (fresh, notice only); exactly { text } after an answer', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session)
    expect(await session.lastAnswer()).toBeUndefined()
    await session.writeNotice({ text: 'N', kind: 'background' })
    expect(await session.lastAnswer()).toBeUndefined()
    t.kit.queue(answer('a1'))
    expect(await session.submitUser('u1')).toEqual({})
    expect(await session.lastAnswer()).toStrictEqual({ text: 'a1' })
  })

  it('P2-09-25 text extraction: text parts only, joined; toolUse-only → empty text; an aborted partial carries no flag', async () => {
    const t = await makeHost()
    const session = await t.open()
    await appendAssistant(
      session,
      fauxAssistantMessage(
        [fauxThinking('T'), fauxText('Hel'), fauxToolCall('x', {}, { id: 'c1' }), fauxText('lo')],
        { stopReason: 'toolUse' }
      )
    )
    expect(await session.lastAnswer()).toStrictEqual({ text: 'Hello' })
    await appendAssistant(
      session,
      fauxAssistantMessage([fauxToolCall('x', {}, { id: 'c2' })], { stopReason: 'toolUse' })
    )
    expect(await session.lastAnswer()).toStrictEqual({ text: '' })
    await appendAssistant(
      session,
      fauxAssistantMessage([fauxText('partial')], { stopReason: 'aborted' })
    )
    expect(await session.lastAnswer()).toStrictEqual({ text: 'partial' })
  })

  it("P2-09-26 errors: the model's error text with isError (equal to submitUser's error); durable's detail text when errorMessage is absent or empty; during a retry wait", async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session)
    t.kit.queue(modelError('boom'))
    const result = await session.submitUser('u1')
    expect(result).toEqual({ error: 'boom', code: 'model_error' })
    expect(await session.lastAnswer()).toStrictEqual({ text: 'boom', isError: true })

    // errorMessage 缺省：durable 的运行细节文案，与发送结果一致
    t.kit.queue(fauxAssistantMessage([], { stopReason: 'error' }))
    const absent = await session.submitUser('u2')
    expect(absent.code).toBe('model_error')
    const absentAnswer = await session.lastAnswer()
    expect(absentAnswer).toStrictEqual({
      text: 'Model response ended with stop reason error',
      isError: true
    })
    expect(absentAnswer!.text).toBe(absent.error)

    // errorMessage 为空串：durable 的细节同样是 ''（`errorMessage ?? …`，PIN-07 的公式）
    await appendAssistant(
      session,
      fauxAssistantMessage([], { stopReason: 'error', errorMessage: '' })
    )
    expect(await session.lastAnswer()).toStrictEqual({ text: '', isError: true })

    // 重试等待中：最新的错误条目
    const retrying = await makeHost({
      settingsOverrides: {
        ...TEST_SETTINGS_OVERRIDES,
        retry: { enabled: true, baseDelayMs: 60000 }
      }
    })
    const other = await retrying.open()
    await primeRoot(other)
    retrying.kit.queue(modelError('overloaded: try again later'))
    const pending = other.submitUser('u1')
    await waitFor(
      async () =>
        (await other.harness.snapshot(LiveDoc, ROOT, BG))?.generation?.retry !== undefined,
      3000,
      'retry wait'
    )
    expect(await other.lastAnswer()).toStrictEqual({
      text: 'overloaded: try again later',
      isError: true
    })
    await withTimeout(other.abort(), 5000, 'abort')
    expect(await pending).toEqual({})
  })

  it('P2-09-27 turn boundary: a new unanswered turn (held, or aborted before any token) → undefined; notices after the answer are skipped', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session)
    t.kit.queue(answer('a1'))
    expect(await session.submitUser('u1')).toEqual({})
    await session.writeNotice({ text: 'N', kind: 'background' })
    await session.writeNotice({ text: 'D', kind: 'date', data: { date: '2026-10-05' } })
    expect(await session.lastAnswer()).toStrictEqual({ text: 'a1' })

    const run = held(answer('never'))
    t.kit.queue(run.step)
    const pending = session.submitUser('u2')
    await run.reached
    expect(await session.lastAnswer()).toBeUndefined()
    await withTimeout(session.abort(), 5000, 'abort')
    expect(await pending).toEqual({})
    expect(await session.lastAnswer()).toBeUndefined()
  })

  it('P2-09-28 compaction never hides the answer and the summary is never returned', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session)
    t.kit.queue(answer('a1'))
    expect(await session.submitUser('u1')).toEqual({})
    await session.harness.commit(async (tx) => {
      await tx.appendEntry(CompactionEntry, ROOT, {
        model: [{ role: 'user', content: 'SUMMARY', timestamp: Date.now() }],
        head: 'self',
        data: { reason: 'manual' }
      })
    }, BG)
    const context = await (await session.currentConversation()).context(BG)
    expect(context.entries.some((entry) => entry.kind === 'pi.assistant')).toBe(false)
    expect(await session.lastAnswer()).toStrictEqual({ text: 'a1' })
  })

  it('P2-09-29 fork-aware: the fork’s own history; back on root, root’s; a missing pointer falls back to root with a warning', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session)
    t.kit.queue(answer('a1'), answer('a2'))
    expect(await session.submitUser('u1')).toEqual({})
    expect(await session.submitUser('u2')).toEqual({})
    const root = await session.currentConversation()
    const a1 = (await allEntries(root)).find((entry) => entry.kind === 'pi.assistant')!
    const fork = await root.fork(a1.id, { ownership: { kind: 'ownerless' } }, BG)
    await point(session, fork.id)
    expect(await session.lastAnswer()).toStrictEqual({ text: 'a1' })
    t.kit.queue(answer('a3'))
    expect(await session.submitUser('u3')).toEqual({})
    expect(await session.lastAnswer()).toStrictEqual({ text: 'a3' })
    await point(session, ROOT)
    expect(await session.lastAnswer()).toStrictEqual({ text: 'a2' })

    await point(session, 999)
    await sleep(20)
    const missing = (): number =>
      t.warnings.filter((warning) => warning.includes('does not exist')).length
    const before = missing()
    expect(await session.lastAnswer()).toStrictEqual({ text: 'a2' })
    expect(missing()).toBe(before + 1)
  })

  it(
    'P2-09-30 the current conversation only, read-only; a closed handle rejects',
    async () => {
      const t = await makeHost({ makeKit: wKit, extensions: [TEST_SPAWN_EXTENSION] })
      const session = await t.open()
      await primeRoot(session)
      t.kit.queue(answer('a1'))
      expect(await session.submitUser('u1')).toEqual({})

      const side = await session.harness.createConversation(
        { ownership: { kind: 'ownerless' } },
        BG
      )
      await side.configure({ model: t.kit.model }, BG)
      t.kit.queue(answer('OTHER'))
      expect((await (await side.submit({ type: 'input', content: 'q' }, BG)).wait(BG)).status).toBe(
        'done'
      )
      expect(await session.lastAnswer()).toStrictEqual({ text: 'a1' })

      const seeded = await seedAgent(session, { record: hookRec(), settle: true })
      t.kit.queue(answer('OTHER'))
      const titled = await startRun(session, seeded.conversationId, 'TITLE-ME')
      expect((await withTimeout(titled.wait(BG), 3000, 'titler')).status).toBe('done')
      expect(await session.lastAnswer()).toStrictEqual({ text: 'a1' })

      await withTimeout(t.host.close('s1'), 5000, 'close')
      await expect(session.lastAnswer()).rejects.toBeInstanceOf(SessionClosedError)

      // 被中断的会话上：只读，不开启调度器
      const { t: t2 } = await crashWith()
      const interrupted = await t2.open()
      const recorder = recordPublications(interrupted.harness)
      expect(await interrupted.lastAnswer()).toBeUndefined()
      recorder.stop()
      expect(recorder.publications).toEqual([])
      expect(await scheduling(interrupted)).toBe('paused')
    },
    RESTART_TIMEOUT
  )
})
