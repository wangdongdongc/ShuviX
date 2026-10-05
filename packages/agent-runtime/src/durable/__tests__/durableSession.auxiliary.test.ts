/**
 * 辅助工作（P2-01，`dispatch: 'hook'` 的 hook agent 及其名下的对话；Q-P2-06）：
 *
 *  - **从不续跑**：打开时把它们活着的任务逐个 `harness.abortTask`（只提交中止标记、不开启调度器）；
 *    下一次开启调度器的调用（发送、继续、写通知……）让它们以 aborted 收场，从不再发请求。
 *  - **不算中断、不进运行状态镜像**：只剩辅助工作时会话报 idle，发送不走中断策略，通知不推迟。
 *  - 进程内的 hook 工作照常跑；分类只在打开时动手（中止标记），状态排除在任何时候都生效。
 *  - 回归：K10/K11/K12、RC-05、R5 在旁边有辅助工作时照旧（G 段）。
 *
 * 锚任务的说明：titler 的锚任务在根对话里，子对话有活任务时它以 completing 陪着活着。P2-01 时它会让运行
 * 状态跟着忙，所以这里进程内看运行状态的用例用 ownerless 的 hook 对话、或先让锚跑完（`settle`）；P2-08 起
 * 这种锚不进运行状态（PIN-02），锚拥有的同形用例在 hosted.regressions.test.ts（期望相同）。
 * 重启用例都用 SQLite、真实计时器、约 15 秒的超时。
 */
import { Type } from '@earendil-works/pi-ai'
import {
  AgentDoc,
  configure,
  defineTool,
  ROOT_CONVERSATION_ID,
  type Conversation,
  type ConversationId,
  type SubmissionId
} from '@earendil-works/pi-durable'
import { describe, expect, it, vi } from 'vitest'
import { writeSpawnedAgentRecord } from '../agentRecord'
import { backgroundContext as BG } from '../context'
import { SessionStateDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import { agentExtensionName } from '../lock'
import { answer, callTool, held, stalled } from './support/faux'
import {
  makeHost,
  primeRoot,
  registerHostCleanup,
  type TestHost,
  type TestHostOptions
} from './support/host'
import { extensionTools, lockW, scenarioW, wKit } from './support/scenario'
import {
  holdGate,
  hookRec,
  liveTasks,
  mentions,
  rec,
  requestsWith,
  seedAgent,
  startRun,
  tasksOf,
  TEST_SPAWN_EXTENSION
} from './support/spawn'
import { holdTool } from './support/tools'
import { allEntries, requestTexts, transcript } from './support/transcript'
import { deferred, sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const RESTART_TIMEOUT = 15000
const ROOT = ROOT_CONVERSATION_ID

function host(options: Partial<TestHostOptions> = {}): Promise<TestHost> {
  return makeHost({ makeKit: wKit, extensions: [TEST_SPAWN_EXTENSION], ...options })
}

async function scheduling(session: DurableSession): Promise<string> {
  return (await session.harness.inspect(BG)).scheduling
}

async function conversation(session: DurableSession, id: ConversationId): Promise<Conversation> {
  return (await session.harness.conversation(id, BG))!
}

/** 某对话的 run（generation 任务）都已以 aborted 终态收场 */
async function waitAborted(
  session: DurableSession,
  conversationId: ConversationId,
  kind = 'pi.generation'
): Promise<void> {
  await waitFor(
    async () => {
      const tasks = await tasksOf(session, conversationId, kind)
      return (
        tasks.length > 0 &&
        tasks.every(
          (task) => task.state.status === 'terminal' && task.state.outcome.status === 'aborted'
        )
      )
    },
    5000,
    `${kind} tasks of conversation ${conversationId} aborted`
  )
}

/** 某对话里正 placed 的那条 submission（只该有一条） */
async function placedIn(
  session: DurableSession,
  conversationId: ConversationId
): Promise<SubmissionId> {
  const placed = (await session.harness.inspect(BG)).submissions.filter(
    (submission) => submission.conversationId === conversationId && submission.status === 'placed'
  )
  expect(placed).toHaveLength(1)
  return placed[0]!.id
}

/** 转写里工具结果的文本（durable 包在 `<harness>` 围栏里） */
function toolResults(lines: readonly string[]): string[] {
  return lines
    .filter((line) => line.startsWith('pi.tool-result:'))
    .map((line) => line.slice('pi.tool-result:'.length))
}

async function submissionStatus(session: DurableSession, id: SubmissionId): Promise<unknown> {
  return (await session.harness.submission(id, BG))!.status(BG)
}

interface Crashed {
  /** 进程 2 的宿主（会话还没打开） */
  readonly t: TestHost
  readonly child: ConversationId
  readonly childSubmission: SubmissionId
  /** `rootStalled` 时根上那条被中断的 submission */
  readonly rootSubmission?: SubmissionId
}

/**
 * 进程 1：根有 agent、一轮问答；（可选）根上再起一轮挂住；种一个 titler（锚拥有）并让它的一轮挂在
 * 'TITLE-ME' 上；然后重启。返回进程 2 的宿主。
 */
async function crashWithTitler(
  options: {
    first?: TestHost
    rootStalled?: boolean
    restart?: Partial<TestHostOptions>
    beforeRestart?: (session: DurableSession, child: ConversationId) => Promise<void>
  } = {}
): Promise<Crashed> {
  const first = options.first ?? (await host())
  const session = await first.open()
  if (session.lock === undefined) await primeRoot(session)
  first.kit.queue(answer('a1'))
  expect(await session.submitUser('u1')).toEqual({})
  let rootSubmission: SubmissionId | undefined
  if (options.rootStalled === true) {
    const stall = stalled()
    first.kit.queue(stall.step)
    void session.submitUser('hello')
    await stall.reached
    rootSubmission = await placedIn(session, ROOT)
  }
  const seeded = await seedAgent(session, { record: hookRec() })
  const stall = stalled()
  first.kit.queue(stall.step)
  const submission = await startRun(session, seeded.conversationId, 'TITLE-ME')
  await stall.reached
  await options.beforeRestart?.(session, seeded.conversationId)
  const t = await first.restart(options.restart)
  return {
    t,
    child: seeded.conversationId,
    childSubmission: submission.id,
    ...(rootSubmission === undefined ? {} : { rootSubmission })
  }
}

describe('auxiliary work · abort-marked at open, never resumed', () => {
  it(
    'P2-01-31 headline: right after open every live titler task is marked, nothing else is, nothing runs, its submission is still placed',
    async () => {
      const { t, child, childSubmission } = await crashWithTitler()
      const session = await t.open()
      const childTasks = await liveTasks(session, child)
      expect(childTasks.length).toBeGreaterThan(0)
      expect(childTasks.every((task) => task.abortRequested)).toBe(true)
      const others = (await liveTasks(session)).filter((task) => task.conversationId !== child)
      expect(others.every((task) => !task.abortRequested)).toBe(true)
      expect(await scheduling(session)).toBe('paused')
      await sleep(150)
      expect(t.kit.callCount).toBe(0)
      expect(await submissionStatus(session, childSubmission)).toMatchObject({ status: 'placed' })
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-01-32 a send never resumes it: one request (the send), the titler ends aborted, no interrupted policy',
    async () => {
      const beforeAbort = vi.fn()
      const { t, child, childSubmission } = await crashWithTitler({ restart: { beforeAbort } })
      const session = await t.open()
      t.kit.queue(answer('hello back'))
      expect(await withTimeout(session.submitUser('hi'), 5000, 'send')).toEqual({})
      expect(t.kit.callCount).toBe(1)
      expect(requestTexts(t.kit, 0).at(-1)).toBe('user:hi')
      const settled = await withTimeout(
        (await session.harness.submission(childSubmission, BG))!.wait(BG),
        5000,
        'titler submission'
      )
      expect(settled).toMatchObject({ status: 'unanswered', reason: 'aborted' })
      await waitAborted(session, child)
      expect(await transcript(await conversation(session, child))).toEqual(['pi.user:TITLE-ME'])
      expect(beforeAbort).not.toHaveBeenCalled()
      await sleep(50)
      expect(t.kit.callCount).toBe(1)
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-01-33 root interrupted beside the titler: continue resumes only the root',
    async () => {
      const { t, child } = await crashWithTitler({ rootStalled: true })
      const session = await t.open()
      expect(session.isInterrupted()).toBe(true)
      const rootTasks = await liveTasks(session, ROOT)
      expect(rootTasks.some((task) => task.kind === 'pi.generation')).toBe(true)
      expect(rootTasks.every((task) => !task.abortRequested)).toBe(true)
      expect((await liveTasks(session, child)).every((task) => task.abortRequested)).toBe(true)
      t.kit.queue(answer('resumed'))
      expect(await withTimeout(session.continue(), 5000, 'continue')).toEqual({})
      expect(t.kit.callCount).toBe(1)
      expect(mentions(t.kit, 'TITLE-ME')).toBe(false)
      expect((await transcript(await conversation(session, ROOT))).at(-1)).toBe(
        'pi.assistant:resumed'
      )
      await waitAborted(session, child)
      await sleep(50)
      expect(t.kit.callCount).toBe(1)
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-01-34 reviewer shape (owned by the asking tool task): the reviewer is marked, the root is not; continue gives the interrupted tool result',
    async () => {
      const reviewers: ConversationId[] = []
      const askReview = defineTool({
        name: 'ask_review',
        description: 'ask_review: asks a reviewer',
        parameters: Type.Object({}),
        execute: async (_args, api, context) => {
          const reviewer = await api.commit(async (tx) => {
            const created = await tx.createConversation({
              ownership: { kind: 'task', taskId: api.taskId }
            })
            await configure(tx, created.id, { model: { provider: 'faux', modelId: 'faux-2' } })
            await writeSpawnedAgentRecord(
              tx,
              created.id,
              hookRec({
                profileName: 'permission-reviewer',
                agentId: 'sub-r1',
                hook: 'auto-review',
                displayName: 'Reviewer',
                conversationId: created.id,
                ownerTaskId: api.taskId,
                parentConversationId: api.conversationId,
                extensions: ['shuvix.builtin', agentExtensionName(created.id)]
              })
            )
            return created.id
          }, context)
          reviewers.push(reviewer)
          const handle = await api.conversation(reviewer, context)
          const submission = await handle!.submit({ type: 'input', content: 'REVIEW-ME' }, context)
          await submission.wait(context)
          return { content: [{ type: 'text', text: 'reviewed' }] }
        }
      })
      const first = await host({ tools: [askReview] })
      const session = await first.open()
      await primeRoot(session)
      const stall = stalled()
      first.kit.queue(callTool('ask_review'), stall.step)
      void session.submitUser('review this')
      await stall.reached
      const t = await first.restart()
      const reopened = await t.open()
      const reviewer = reviewers[0]!
      const reviewerTasks = await liveTasks(reopened, reviewer)
      expect(reviewerTasks.length).toBeGreaterThan(0)
      expect(reviewerTasks.every((task) => task.abortRequested)).toBe(true)
      const rootTasks = await liveTasks(reopened, ROOT)
      expect(rootTasks.map((task) => task.kind)).toEqual(
        expect.arrayContaining(['pi.generation', 'pi.tool'])
      )
      expect(rootTasks.every((task) => !task.abortRequested)).toBe(true)
      expect(reopened.isInterrupted()).toBe(true)

      t.kit.queue(answer('after'))
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
      const rootTranscript = await transcript(await conversation(reopened, ROOT))
      expect(
        toolResults(rootTranscript).some((text) =>
          text.includes('Tool ask_review was interrupted and may have partially run')
        )
      ).toBe(true)
      expect(rootTranscript.at(-1)).toBe('pi.assistant:after')
      expect(mentions(t.kit, 'REVIEW-ME')).toBe(false)
      await waitAborted(reopened, reviewer)
    },
    RESTART_TIMEOUT
  )

  it(
    "P2-01-35 a 'tool' child is not marked: it is interrupted work and continue resumes it",
    async () => {
      const first = await host()
      const session = await first.open()
      await primeRoot(session)
      const seeded = await seedAgent(session)
      const stall = stalled()
      first.kit.queue(stall.step)
      const submission = await startRun(session, seeded.conversationId, 'CHILD-Q')
      await stall.reached
      const t = await first.restart()
      const reopened = await t.open()
      const childTasks = await liveTasks(reopened, seeded.conversationId)
      expect(childTasks.length).toBeGreaterThan(0)
      expect(childTasks.every((task) => !task.abortRequested)).toBe(true)
      expect(reopened.isInterrupted()).toBe(true)
      expect(reopened.runState).toBe('interrupted')
      await sleep(10)
      expect(t.statesOf('s1')).toEqual(['interrupted'])

      t.kit.queue(answer('child done'))
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
      const settled = await withTimeout(
        (await reopened.harness.submission(submission.id, BG))!.wait(BG),
        5000,
        'child submission'
      )
      expect(settled.status).toBe('done')
      expect(requestsWith(t.kit, 'CHILD-Q')).toHaveLength(1)
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-01-36 a plain side conversation is not marked; it counts as interrupted (R2)',
    async () => {
      const first = await host()
      const session = await first.open()
      await primeRoot(session)
      const side = await session.harness.createConversation(
        { ownership: { kind: 'ownerless' } },
        BG
      )
      await side.configure({ model: first.kit.model }, BG)
      const stall = stalled()
      first.kit.queue(stall.step)
      await side.submit({ type: 'input', content: 'SIDE-Q' }, BG)
      await stall.reached
      const t = await first.restart()
      const reopened = await t.open()
      const sideTasks = await liveTasks(reopened, side.id)
      expect(sideTasks.length).toBeGreaterThan(0)
      expect(sideTasks.every((task) => !task.abortRequested)).toBe(true)
      expect(reopened.isInterrupted()).toBe(true)
      expect(reopened.runState).toBe('interrupted')
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-01-37 opening writes nothing but the marks: session state, root pi.agent and transcripts are unchanged; idle reported once',
    async () => {
      type Snapshot = { state: unknown; agent: unknown; root: unknown; child: unknown }
      const capture = async (
        session: DurableSession,
        child: ConversationId
      ): Promise<Snapshot> => ({
        state: await session.harness.snapshot(SessionStateDoc, BG),
        agent: await session.harness.snapshot(AgentDoc, ROOT, BG),
        root: await allEntries(await conversation(session, ROOT)),
        child: await allEntries(await conversation(session, child))
      })
      let before: Snapshot | undefined
      const { t, child } = await crashWithTitler({
        beforeRestart: async (session, conversationId) => {
          before = await capture(session, conversationId)
        }
      })
      const session = await t.open()
      expect(await capture(session, child)).toEqual(before)
      await sleep(20)
      expect(t.statesOf('s1')).toEqual(['idle'])
      expect(t.mirror).toEqual([['s1', true]])
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-01-38 marks are idempotent across reopens: an untouched second open leaves them, a third open finds them; a later send aborts them',
    async () => {
      const { t, child, childSubmission } = await crashWithTitler()
      await t.open()
      const third = await t.restart()
      const session = await third.open()
      const childTasks = await liveTasks(session, child)
      expect(childTasks.length).toBeGreaterThan(0)
      expect(childTasks.every((task) => task.abortRequested)).toBe(true)
      expect(await scheduling(session)).toBe('paused')
      expect(t.warnings).toEqual([])
      expect(third.warnings).toEqual([])
      await sleep(150)
      expect(third.kit.callCount).toBe(0)

      third.kit.queue(answer('ok'))
      expect(await withTimeout(session.submitUser('hi'), 5000, 'send')).toEqual({})
      await waitAborted(session, child)
      expect(await submissionStatus(session, childSubmission)).toMatchObject({
        status: 'unanswered',
        reason: 'aborted'
      })
      expect(third.kit.callCount).toBe(1)
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-01-39 titler work inside a tool round: both the generation and the tool task are marked; a send aborts the tool without a second titler request',
    async () => {
      const gate = deferred()
      const running = deferred()
      const tools = [holdTool('hold', gate.promise, { onRun: () => running.resolve() })]
      const first = await host({ tools })
      const session = await first.open()
      await primeRoot(session)
      const seeded = await seedAgent(session, { record: hookRec() })
      first.kit.queue(callTool('hold'))
      await startRun(session, seeded.conversationId, 'TITLE-ME')
      await running.promise
      const t = await first.restart()
      const reopened = await t.open()
      const childTasks = await liveTasks(reopened, seeded.conversationId)
      expect(childTasks.map((task) => task.kind)).toEqual(
        expect.arrayContaining(['pi.generation', 'pi.tool'])
      )
      expect(childTasks.every((task) => task.abortRequested)).toBe(true)

      t.kit.queue(answer('ok'))
      expect(await withTimeout(reopened.submitUser('hi'), 5000, 'send')).toEqual({})
      await waitAborted(reopened, seeded.conversationId, 'pi.tool')
      await waitAborted(reopened, seeded.conversationId)
      const childTranscript = await transcript(await conversation(reopened, seeded.conversationId))
      expect(
        toolResults(childTranscript).some((text) => text.includes('Tool hold was aborted'))
      ).toBe(true)
      await sleep(50)
      expect(t.kit.callCount).toBe(1)
      expect(requestTexts(t.kit, 0).at(-1)).toBe('user:hi')
    },
    RESTART_TIMEOUT
  )

  it('P2-01-40 in-process hook work runs normally; nothing is marked', async () => {
    const t = await host()
    const session = await t.open()
    await primeRoot(session)
    const seeded = await seedAgent(session, { record: hookRec() })
    t.kit.queue(answer('Title'))
    const submission = await startRun(session, seeded.conversationId, 'TITLE-ME')
    expect((await withTimeout(submission.wait(BG), 5000, 'titler run')).status).toBe('done')
    expect((await transcript(await conversation(session, seeded.conversationId))).at(-1)).toBe(
      'pi.assistant:Title'
    )
    const tasks = await tasksOf(session, seeded.conversationId)
    expect(tasks.length).toBeGreaterThan(0)
    expect(tasks.every((task) => !task.abortRequested)).toBe(true)
  })

  it('P2-01-41 classification timing: within one publication, and on a later record commit', async () => {
    // (a) 一个提交里建 hook 对话、记录和一个扣住的任务：开启调度器前后都不忙
    const t = await host()
    const session = await t.open()
    const gate = 'p2-01-41a'
    const seeded = await seedAgent(session, { record: hookRec(), owner: 'none', hold: gate })
    expect(session.isInterrupted()).toBe(false)
    expect(session.runState).toBe('idle')
    session.harness.resume()
    await waitFor(async () =>
      (await liveTasks(session, seeded.conversationId)).some(
        (task) => task.state.status === 'running'
      )
    )
    expect(session.runState).toBe('idle')
    holdGate(gate).resolve()
    await waitFor(async () => (await liveTasks(session, seeded.conversationId)).length === 0)
    await sleep(20)
    expect(t.statesOf('s1')).not.toContain('busy')

    // (b) 没有记录的子对话在跑（忙）；之后提交 HOOK 记录 → 当场转闲；放行之后不再报
    const other = await host()
    const second = await other.open()
    const child = await second.harness.createConversation({ ownership: { kind: 'ownerless' } }, BG)
    await child.configure({ model: { provider: 'faux', modelId: 'faux-2' } }, BG)
    const run = held(answer('side'))
    other.kit.queue(run.step)
    const submission = await child.submit({ type: 'input', content: 'side work' }, BG)
    await run.reached
    await waitFor(() => other.statesOf('s1').at(-1) === 'busy', 3000, 'busy reported')
    expect(second.runState).toBe('busy')
    await second.harness.commit(
      (tx) => writeSpawnedAgentRecord(tx, child.id, hookRec({ conversationId: child.id })),
      BG
    )
    expect(second.runState).toBe('idle')
    await waitFor(() => other.statesOf('s1').at(-1) === 'idle', 3000, 'idle reported')
    const reported = other.statesOf('s1').length
    run.release()
    expect((await withTimeout(submission.wait(BG), 3000, 'side run')).status).toBe('done')
    await sleep(30)
    expect(other.statesOf('s1')).toHaveLength(reported)
  })

  it(
    'P2-01-42 work below a titler is auxiliary too (PIN-08): a tool grandchild is marked and not interrupted',
    async () => {
      const first = await host()
      const session = await first.open()
      await primeRoot(session)
      const titler = await seedAgent(session, { record: hookRec() })
      const grandchild = await seedAgent(session, {
        record: rec({ agentId: 'sub-g1', depth: 2 }),
        parent: titler.conversationId
      })
      const stall = stalled()
      first.kit.queue(stall.step)
      await startRun(session, grandchild.conversationId, 'GRANDCHILD-Q')
      await stall.reached
      const t = await first.restart()
      const reopened = await t.open()
      const tasks = await liveTasks(reopened, grandchild.conversationId)
      expect(tasks.length).toBeGreaterThan(0)
      expect(tasks.every((task) => task.abortRequested)).toBe(true)
      expect(reopened.isInterrupted()).toBe(false)
      expect(reopened.runState).toBe('idle')
    },
    RESTART_TIMEOUT
  )
})

describe('auxiliary work · isInterrupted and runState exclude it', () => {
  it(
    'P2-01-43 only marked titler work after reopen: idle, notices are written not deferred, continue sends nothing',
    async () => {
      const { t, child } = await crashWithTitler()
      const session = await t.open()
      expect(session.isInterrupted()).toBe(false)
      expect(session.runState).toBe('idle')
      expect(session.isBusy()).toBe(false)
      await sleep(10)
      expect(t.statesOf('s1')).toEqual(['idle'])

      const notice = await session.writeNotice({ text: 'N', kind: 'background' })
      expect(notice.status).toBe('submitted')
      expect((await transcript(await conversation(session, ROOT))).at(-1)).toBe('shuvix.notice:N')
      expect((await session.harness.snapshot(SessionStateDoc, BG))?.deferredNotices).toEqual([])

      expect(await withTimeout(session.continue(), 5000, 'continue')).toEqual({})
      await waitAborted(session, child)
      expect(t.kit.callCount).toBe(0)
    },
    RESTART_TIMEOUT
  )

  it('P2-01-44 the mirror stays idle while titler work runs', async () => {
    const t = await host()
    const session = await t.open()
    const seeded = await seedAgent(session, { record: hookRec(), owner: 'none' })
    const run = held(answer('Title'))
    t.kit.queue(run.step)
    const submission = await startRun(session, seeded.conversationId, 'TITLE-ME')
    await run.reached
    expect(session.runState).toBe('idle')
    expect(session.isBusy()).toBe(false)
    expect(session.isInterrupted()).toBe(false)
    run.release()
    expect((await withTimeout(submission.wait(BG), 3000, 'titler run')).status).toBe('done')
    await sleep(30)
    expect(t.statesOf('s1')).toEqual(['idle'])
  })

  it('P2-01-45 a root run beside titler work: one busy/idle pair, idle when the root ends; the titler ending reports nothing', async () => {
    const t = await host()
    const session = await t.open()
    await primeRoot(session)
    const seeded = await seedAgent(session, { record: hookRec(), owner: 'none' })
    const titler = held(answer('Title'))
    t.kit.queue(titler.step)
    const titlerRun = await startRun(session, seeded.conversationId, 'TITLE-ME')
    await titler.reached
    const root = held(answer('root'))
    t.kit.queue(root.step)
    const result = session.submitUser('hi')
    await root.reached
    root.release()
    expect(await withTimeout(result, 3000, 'root run')).toEqual({})
    await waitFor(() => t.statesOf('s1').at(-1) === 'idle', 3000, 'idle reported')
    expect(t.statesOf('s1')).toEqual(['idle', 'busy', 'idle'])
    expect((await liveTasks(session, seeded.conversationId)).length).toBeGreaterThan(0)
    titler.release()
    expect((await withTimeout(titlerRun.wait(BG), 3000, 'titler run')).status).toBe('done')
    await sleep(30)
    expect(t.statesOf('s1')).toEqual(['idle', 'busy', 'idle'])
  })

  it("P2-01-46 a 'tool' child counts: busy while it runs (isBusy stays false), one pair", async () => {
    const t = await host()
    const session = await t.open()
    await primeRoot(session)
    const seeded = await seedAgent(session)
    const run = held(answer('done'))
    t.kit.queue(run.step)
    const submission = await startRun(session, seeded.conversationId, 'CHILD-Q')
    await run.reached
    await waitFor(() => session.runState === 'busy', 3000, 'busy')
    expect(session.isBusy()).toBe(false)
    run.release()
    expect((await withTimeout(submission.wait(BG), 3000, 'child run')).status).toBe('done')
    await waitFor(() => t.statesOf('s1').at(-1) === 'idle', 3000, 'idle reported')
    expect(t.statesOf('s1')).toEqual(['idle', 'busy', 'idle'])
  })

  it(
    'P2-01-47 no busy marker from titler work, and process 2 reports idle',
    async () => {
      const first = await host()
      const session = await first.open()
      // 先让锚跑完（它在根里，跑的那一下运行状态会闪忙，PIN-12）；从那之后开始数
      const seeded = await seedAgent(session, { record: hookRec(), settle: true })
      await waitFor(() => session.runState === 'idle', 3000, 'anchor settled')
      await sleep(10)
      const mark = first.statesOf('s1').length
      const run = held(answer('Title'))
      first.kit.queue(run.step)
      await startRun(session, seeded.conversationId, 'TITLE-ME')
      await run.reached
      await sleep(20)
      expect(first.statesOf('s1').slice(mark)).toEqual([])
      const t = await first.restart()
      const reopened = await t.open()
      await sleep(10)
      expect(t.statesOf('s1')).toEqual(['idle'])
      expect(reopened.runState).toBe('idle')
      expect(
        (await liveTasks(reopened, seeded.conversationId)).every((task) => task.abortRequested)
      ).toBe(true)
    },
    RESTART_TIMEOUT
  )
})

describe('auxiliary work · P1-07 / P1-09 rulings still hold', () => {
  it(
    'P2-01-51 K11/K12: reopening with titler work rebuilds only the lock, reconciles the mirror, installs no spawned extension',
    async () => {
      const { t: first } = await scenarioW({ extensions: [TEST_SPAWN_EXTENSION] })
      const { t, child } = await crashWithTitler({ first })
      const session = await t.open()
      expect(session.lock).toEqual(lockW())
      expect(t.toolHost.rebuildCalls).toEqual([lockW()])
      expect(t.configCalls).toEqual([])
      expect(t.toolHost.resolveCalls).toEqual([])
      expect(t.mirror).toEqual([['s1', true]])
      expect(extensionTools(t, agentExtensionName(ROOT))).toBeDefined()
      expect(extensionTools(t, agentExtensionName(child))).toBeUndefined()
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-01-52 RC-05 extended: identity lookups and the other read paths never resume beside marked titler work',
    async () => {
      const { t, child } = await crashWithTitler({ rootStalled: true })
      const session = await t.open()
      expect(session.agentIdentity(ROOT)).toMatchObject({ kind: 'root', profileName: 'test' })
      expect(session.agentIdentity(child)).toMatchObject({ kind: 'spawned', callerId: 'sub-h1' })
      expect(session.agentIdentity(999)).toEqual(session.agentIdentity(ROOT))
      expect((await session.currentConversation()).id).toBe(ROOT)
      expect(session.isBusy()).toBe(false)
      expect(session.runState).toBe('interrupted')
      await sleep(50)
      expect(await scheduling(session)).toBe('paused')
      expect(session.isInterrupted()).toBe(true)
      expect(t.kit.callCount).toBe(0)
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-01-53 K10: destroyAgent with only marked titler work unlocks without aborting; the work stays marked; nothing runs',
    async () => {
      const beforeAbort = vi.fn()
      const { t, child } = await crashWithTitler({ restart: { beforeAbort } })
      const session = await t.open()
      await withTimeout(session.destroyAgent(), 5000, 'destroy')
      expect(session.lock).toBeUndefined()
      expect(beforeAbort).not.toHaveBeenCalled()
      const tasks = await liveTasks(session, child)
      expect(tasks.length).toBeGreaterThan(0)
      expect(tasks.every((task) => task.abortRequested)).toBe(true)
      await sleep(50)
      expect(await scheduling(session)).toBe('paused')
      expect(t.kit.callCount).toBe(0)
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-01-54 R5 abort-then-send beside marked titler work: the old root submission ends aborted, one request, the titler aborted',
    async () => {
      const { t, child, rootSubmission } = await crashWithTitler({ rootStalled: true })
      const session = await t.open()
      t.kit.queue(answer('fresh'))
      expect(await withTimeout(session.submitUser('new'), 5000, 'send')).toEqual({})
      expect(await submissionStatus(session, rootSubmission!)).toMatchObject({
        status: 'unanswered',
        reason: 'aborted'
      })
      expect(t.kit.callCount).toBe(1)
      expect(requestTexts(t.kit, 0).at(-1)).toBe('user:new')
      await waitAborted(session, child)
      expect(mentions(t.kit, 'TITLE-ME')).toBe(false)
    },
    RESTART_TIMEOUT
  )
})
