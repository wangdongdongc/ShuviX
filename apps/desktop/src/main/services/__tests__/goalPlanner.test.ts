/**
 * 目标规划（goalService.planGoal）：设目标时、发出目标消息之前，宿主派内置 goal-planner（`agentManager.runTask`，
 * owner `{anchor: true}`，结论契约 GOAL_PLAN_SCHEMA）。替身与 goalService.test.ts 同一套（真 durable 会话 + 桌面接缝替身），
 * 只是这里 `agentService.getProfile` 给出 goal-planner 的档案，`runTask` 是可控的替身。
 *
 * GP-1 ready → 照原样开始（消息里没有规格，记录里没有 specPath）· GP-2 spec + 相对路径的真文件 → 绝对 specPath 进记录、
 * 设定消息、续跑通知、恢复通知、判定 payload · GP-3 spec + 绝对路径 · GP-4 规格文件不在 / spec 却没路径 → 没有规格 ·
 * GP-5 runTask 抛错 / 没有结构化结论 → 照样开始 · GP-6 规划途中广播 planning true，之后 false · GP-7 派发参数 +
 * 之前的用户消息（有 / 没有）· GP-8 规划途中暂停 / 清除 → 规划中止、不发目标消息 · GP-9 规划途中设新目标 → 换掉 ·
 * GP-10 没有 goal-planner 档案 → 跳过
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readGoal,
  readTranscriptDigest,
  type DurableSession,
  type GoalCheckPayload
} from '@shuvix/agent-runtime'
import { GOAL_PLAN_SCHEMA, type GoalRecord, type GoalView } from '@shuvix/chat-protocol/types/goal'
import type { InputOrigin } from '@shuvix/chat-protocol/types/inputOrigin'
import {
  makeHost,
  primeRoot,
  registerHostCleanup,
  type TestHost
} from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/host'
import { answer } from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/faux'
import { transcript } from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/transcript'
import {
  sleep,
  waitFor,
  withTimeout
} from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/wait'

// ─────────────────────────── 替身 ───────────────────────────

type Row = { parentId?: string | null; settings?: Record<string, unknown>; title?: string }
type Facade = {
  durable: DurableSession
  maskTexts: (texts: readonly string[]) => Promise<string[]>
  admitSteer: ReturnType<typeof vi.fn>
  createAgent: ReturnType<typeof vi.fn>
}
type TaskInput = {
  sessionId: string
  owner: unknown
  agentType: { name: string; systemPrompt: string; tools: string[] }
  prompt: string
  description: string
  resultContract: { schema: unknown }
  signal: AbortSignal
}
type TaskOutcome = { structured?: unknown; error?: string; result?: string }

const PLANNER_PROFILE = {
  name: 'goal-planner',
  displayName: 'Goal Planner',
  description: 'plans goals',
  tools: ['read', 'write', 'ask'],
  systemPrompt: "You are ShuviX's goal planner.",
  instructionFiles: [],
  projectAwareness: false
}

const mocks = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  rows: new Map<string, Row>(),
  decide: vi.fn(),
  broadcast: vi.fn<(event: Record<string, unknown>) => void>(),
  host: {
    current: undefined as
      | undefined
      | { peek: (id: string) => Promise<unknown>; get: (id: string) => unknown }
  },
  ensure: vi.fn<(id: string) => Promise<unknown>>(),
  transcript: vi.fn<(id: string) => Promise<unknown[]>>(),
  warn: vi.fn<(message: string) => void>(),
  getProfile: vi.fn<(name: string) => unknown>(),
  runTask: vi.fn<(input: TaskInput) => Promise<TaskOutcome>>(),
  workingDirectory: { current: '' }
}))

vi.mock('../settingsService', () => ({
  settingsService: {
    get: (key: string) => mocks.settings.get(key),
    set: (key: string, value: string) => mocks.settings.set(key, value)
  }
}))
vi.mock('../sessionRecords', () => ({
  sessionRecords: {
    pick: (id: string, fields: string[]) => {
      const row = mocks.rows.get(id)
      if (row === undefined) return undefined
      return Object.fromEntries(
        fields.map((field) => [field, (row as Record<string, unknown>)[field]])
      )
    },
    isEphemeral: () => false,
    findChildren: () => []
  }
}))
vi.mock('../hookService', () => ({
  hookService: { agentsBoundTo: () => new Set(['goal-judge']) },
  hookTriggers: { decide: mocks.decide }
}))
vi.mock('../notificationService', () => ({ notifyGoalEnded: () => {} }))
vi.mock('../sessionHost', () => ({
  getSessionHost: () => ({
    peek: async (id: string) => mocks.host.current!.peek(id),
    get: (id: string) => mocks.host.current!.get(id)
  })
}))
vi.mock('../sessionService', () => ({
  sessionService: {
    ensureAgentSession: (id: string) => mocks.ensure(id),
    resolveAgentProfileName: () => 'work'
  }
}))
vi.mock('../sessionSignalSeams', () => ({ sessionSignalsReady: async () => {} }))
vi.mock('../agentService', () => ({
  agentService: { getProfile: (name: string) => mocks.getProfile(name) }
}))
vi.mock('../../agents/AgentManager', () => ({
  agentManager: { runTask: (input: TaskInput) => mocks.runTask(input) }
}))
vi.mock('../toolContext', () => ({
  resolveProjectConfig: () => ({ workingDirectory: mocks.workingDirectory.current })
}))
vi.mock('../taskRegistry', () => ({ taskRegistry: { runningCount: () => 0 } }))
vi.mock('../transcriptSource', () => ({ readSessionTranscript: mocks.transcript }))
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: mocks.broadcast } }))
vi.mock('../../i18n', () => ({
  t: (key: string, vars?: Record<string, unknown>) =>
    vars === undefined ? key : `${key}|${JSON.stringify(vars)}`
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: mocks.warn, error: () => {}, debug: () => {} })
}))

import { GOAL_SESSIONS_SETTING, GoalService } from '../goalService'

registerHostCleanup()

// ─────────────────────────── 夹具 ───────────────────────────

const SID = 'plan-s1'
const LOCAL: InputOrigin = { kind: 'local' }

let t: TestHost
let service: GoalService
let workDir: string
const facades = new Map<string, Facade>()

async function setup(): Promise<{ session: DurableSession }> {
  t = await makeHost({ noticeCoalesceMs: 20 })
  mocks.host.current = t.host
  service = new GoalService({
    now: () => Date.now(),
    checkinFirstMs: 60_000,
    budgetCheckMs: 60_000
  })
  const session = await t.open(SID)
  await primeRoot(session)
  return { session }
}

function facadeOf(session: DurableSession): Facade {
  let facade = facades.get(session.sessionId)
  if (facade === undefined || facade.durable !== session) {
    facade = {
      durable: session,
      maskTexts: async (texts) => [...texts],
      admitSteer: vi.fn(async (text: string, options: Record<string, unknown>) =>
        session.steer(text, options as never)
      ),
      createAgent: vi.fn(async () => {})
    }
    facades.set(session.sessionId, facade)
  }
  return facade
}

beforeEach(() => {
  facades.clear()
  workDir = mkdtempSync(join(tmpdir(), 'goal-planner-'))
  mocks.workingDirectory.current = workDir
  mocks.settings.clear()
  mocks.rows.clear()
  mocks.rows.set(SID, { parentId: null, settings: {}, title: 'Plan session' })
  mocks.decide.mockReset()
  mocks.decide.mockResolvedValue(null)
  mocks.broadcast.mockReset()
  mocks.warn.mockReset()
  mocks.getProfile.mockReset()
  mocks.getProfile.mockImplementation((name: string) =>
    name === 'goal-planner' ? PLANNER_PROFILE : undefined
  )
  mocks.runTask.mockReset()
  mocks.runTask.mockResolvedValue({ structured: { verdict: 'ready' } })
  mocks.ensure.mockImplementation(async (id: string) => facadeOf(await t.host.open(id)))
  mocks.transcript.mockImplementation(async (id: string) => {
    const session = await t.host.peek(id)
    return session === undefined ? [] : (await readTranscriptDigest(session)).items
  })
})

afterEach(() => {
  service?.dispose()
  rmSync(workDir, { recursive: true, force: true })
})

async function drain(sessionId = SID): Promise<void> {
  const serial = (service as unknown as { serial: Map<string, Promise<unknown>> }).serial
  for (let n = 0; n < 50; n++) {
    const pending = serial.get(sessionId)
    if (pending === undefined) return
    await pending
  }
}

async function endRun(session: DurableSession): Promise<void> {
  await waitFor(() => !session.isBusy(), 5000, 'session idle before run end')
  service.onRootRunEnded(session.sessionId, 'ok')
  await drain(session.sessionId)
}

async function goalOf(session: DurableSession): Promise<GoalRecord | undefined> {
  return readGoal(session.harness)
}

function act(objective: string): Promise<unknown> {
  return service.act(SID, { type: 'set', objective }, LOCAL)
}

/** 设定并等那一轮跑完 */
async function setAndRun(session: DurableSession, objective: string): Promise<GoalRecord> {
  const before = t.kit.callCount
  t.kit.queue(answer('working on it'))
  expect(await act(objective)).toEqual({ ok: true })
  await waitFor(() => t.kit.callCount > before && !session.isBusy(), 5000, 'set run')
  return (await goalOf(session))!
}

function views(): Array<GoalView | null> {
  return mocks.broadcast.mock.calls
    .map(([event]) => event)
    .filter((event) => event.type === 'goal' && event.sessionId === SID)
    .map((event) => event.goal as GoalView | null)
}

function statusTable(): Record<string, string> {
  return JSON.parse(mocks.settings.get(GOAL_SESSIONS_SETTING) ?? '{}') as Record<string, string>
}

function sentText(): string {
  const facade = facades.get(SID)!
  expect(facade.admitSteer).toHaveBeenCalledTimes(1)
  return facade.admitSteer.mock.calls[0]![0] as string
}

/** 挂起的规划员：像真 runTask 一样，signal 落下就交回 error；`resolve` 交结论；`started` 等它被派出 */
function pendingPlanner(): {
  started: Promise<TaskInput>
  resolve: (outcome: TaskOutcome) => void
} {
  let settle: ((value: TaskOutcome) => void) | undefined
  let markStarted: ((input: TaskInput) => void) | undefined
  const started = new Promise<TaskInput>((resolve) => {
    markStarted = resolve
  })
  mocks.runTask.mockImplementationOnce(
    (input) =>
      new Promise<TaskOutcome>((resolve) => {
        settle = resolve
        input.signal.addEventListener('abort', () => resolve({ error: 'aborted' }), { once: true })
        markStarted!(input)
      })
  )
  return { started, resolve: (outcome) => settle?.(outcome) }
}

function writeSpec(relative: string, body = '# Done when\n- tests pass\n'): string {
  const absolute = join(workDir, relative)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, body)
  return absolute
}

// ─────────────────────────── 用例 ───────────────────────────

describe('goal planner · outcomes', () => {
  it('GP-1 ready → 照原样开始：消息没有规格那句、记录没有 specPath、起一轮', async () => {
    const { session } = await setup()
    const goal = await setAndRun(session, 'Make the e2e suite green')
    expect(mocks.runTask).toHaveBeenCalledTimes(1)
    expect(goal.specPath).toBeUndefined()
    expect(goal.status).toBe('active')
    const text = sentText()
    expect(text.startsWith(`Make the e2e suite green\n\n<goal-set id="${goal.id}">`)).toBe(true)
    expect(text).not.toContain('acceptance spec')
    expect(t.kit.callCount).toBe(1)
  })

  it('GP-2 spec + 工作目录里的相对路径 → 绝对 specPath 进记录、设定消息、续跑通知、判定 payload、恢复通知', async () => {
    const { session } = await setup()
    const absolute = writeSpec('docs/goal-spec.md')
    mocks.runTask.mockResolvedValueOnce({
      structured: { verdict: 'spec', specPath: 'docs/goal-spec.md' }
    })
    const goal = await setAndRun(session, 'Make login robust')
    expect(goal.specPath).toBe(absolute)
    const text = sentText()
    expect(text).toMatch(/<goal-set id="[^"]+">[\s\S]*<\/goal-set>$/)
    const note = text.slice(text.indexOf('<goal-set'))
    expect(note).toContain(`has written the acceptance spec for this goal`)
    expect(note).toContain(`to ${absolute}. Read it before you start`)
    expect(views().at(-1)).toMatchObject({ id: goal.id, specPath: absolute, planning: false })

    // 判定的 payload 带着它，续跑通知点名它
    const notify = vi.spyOn(session, 'notify')
    mocks.decide.mockResolvedValueOnce({
      result: { verdict: 'not_met', reason: 'spec item 2 open' },
      hook: 'goal-check'
    })
    t.kit.queue(answer('continuing'))
    await endRun(session)
    const payload = mocks.decide.mock.calls[0]![1] as GoalCheckPayload
    expect(payload.goal.specPath).toBe(absolute)
    const cont = notify.mock.calls.find(([, options]) => options?.kind === 'goal-continue')!
    expect(cont[0]).toContain(`Acceptance spec (written before the work began`)
    expect(cont[0]).toContain(absolute)
    await waitFor(() => t.kit.callCount === 2 && !session.isBusy(), 5000, 'continuation run')

    // 暂停再恢复：恢复通知也点名它
    expect(await service.act(SID, { type: 'pause' }, LOCAL)).toEqual({ ok: true })
    t.kit.queue(answer('resumed'))
    expect(await service.act(SID, { type: 'resume' }, LOCAL)).toEqual({ ok: true })
    const resumed = notify.mock.calls.filter(([, options]) => options?.kind === 'goal-continue')
    expect(resumed.at(-1)![0]).toContain('The user resumed this goal')
    expect(resumed.at(-1)![0]).toContain(absolute)
    await waitFor(() => t.kit.callCount === 3, 5000, 'resumed run')
    expect((await goalOf(session))!.specPath).toBe(absolute)
  })

  it('GP-3 spec + 绝对路径（工作目录外也照收，文件在就行）', async () => {
    const { session } = await setup()
    const absolute = writeSpec('nested/acceptance.md')
    mocks.runTask.mockResolvedValueOnce({ structured: { verdict: 'spec', specPath: absolute } })
    mocks.workingDirectory.current = join(workDir, 'elsewhere')
    const goal = await setAndRun(session, 'Ship the importer')
    expect(goal.specPath).toBe(absolute)
    expect(sentText()).toContain(absolute)
  })

  it('GP-4 spec 却没有这个文件 / spec 却没给路径 → 没有规格，照原样开始（记一条 warn）', async () => {
    const { session } = await setup()
    mocks.runTask.mockResolvedValueOnce({
      structured: { verdict: 'spec', specPath: 'docs/missing.md' }
    })
    const goal = await setAndRun(session, 'First goal')
    expect(goal.specPath).toBeUndefined()
    expect(sentText()).not.toContain('acceptance spec')
    expect(mocks.warn.mock.calls.some(([m]) => m.includes(join(workDir, 'docs/missing.md')))).toBe(
      true
    )

    facades.get(SID)!.admitSteer.mockClear()
    mocks.runTask.mockResolvedValueOnce({ structured: { verdict: 'spec' } })
    const second = await setAndRun(session, 'Second goal')
    expect(second.specPath).toBeUndefined()
    expect(sentText()).not.toContain('acceptance spec')
  })

  it('GP-5 runTask 抛错 / 没有结构化结论 / 结论形状不对 → 目标照样开始，不挡', async () => {
    const { session } = await setup()
    const outcomes: Array<() => Promise<TaskOutcome>> = [
      () => Promise.reject(new Error('model down')),
      () => Promise.resolve({ error: 'no next call' }),
      () => Promise.resolve({ structured: { verdict: 'maybe' } })
    ]
    for (const [index, outcome] of outcomes.entries()) {
      facades.get(SID)?.admitSteer.mockClear()
      mocks.runTask.mockImplementationOnce(outcome)
      const goal = await setAndRun(session, `goal ${index}`)
      expect(goal.status, `case ${index}`).toBe('active')
      expect(goal.specPath, `case ${index}`).toBeUndefined()
      expect(sentText()).toContain(`goal ${index}\n\n<goal-set`)
    }
    expect(mocks.warn.mock.calls.some(([m]) => m.includes('model down'))).toBe(true)
    expect(mocks.warn.mock.calls.some(([m]) => m.includes('no next call'))).toBe(true)
  })

  it('GP-10 没有 goal-planner 档案 → 不派发，照原样开始，视图从不 planning', async () => {
    const { session } = await setup()
    mocks.getProfile.mockReturnValue(undefined)
    const goal = await setAndRun(session, 'No planner here')
    expect(mocks.runTask).not.toHaveBeenCalled()
    expect(goal.specPath).toBeUndefined()
    expect(sentText()).toContain('No planner here\n\n<goal-set')
    expect(views().every((view) => view?.planning === false)).toBe(true)
  })
})

describe('goal planner · dispatch', () => {
  it('GP-7 派发参数：goal-planner 档案、anchor owner、结论契约、signal；目标原文在 <goal> 里；会话里没有之前的人话 → 没有 <earlier-user-words>', async () => {
    const { session } = await setup()
    await setAndRun(session, 'Tidy the README')
    const input = mocks.runTask.mock.calls[0]![0]
    expect(input).toMatchObject({
      sessionId: SID,
      owner: { anchor: true },
      agentType: { name: 'goal-planner', systemPrompt: PLANNER_PROFILE.systemPrompt },
      description: 'goal.planningTask',
      resultContract: { schema: GOAL_PLAN_SCHEMA }
    })
    expect(input.signal).toBeInstanceOf(AbortSignal)
    expect(input.prompt).toBe('The goal the user just set:\n<goal>\nTidy the README\n</goal>')
    expect(input.prompt).not.toContain('earlier-user-words')
    // 派发要会话的锁：先建 agent
    expect(facades.get(SID)!.createAgent).toHaveBeenCalled()
  })

  it('GP-7 之前的人话进 <earlier-user-words>（通知、别的会话发来的不算），按先后、--- 分隔', async () => {
    const { session } = await setup()
    t.kit.queue(answer('a'))
    await session.submitUser('keep the public API stable')
    await session.notify('<background-task id="b1">done</background-task>', { resume: 'never' })
    t.kit.queue(answer('b'))
    await session.submitUser('from another session', {
      source: { kind: 'session', sessionId: 'other', title: 'Other' }
    } as never)
    t.kit.queue(answer('c'))
    await session.submitUser('and no new dependencies')
    await waitFor(() => !session.isBusy(), 5000, 'idle')
    await setAndRun(session, 'Refactor the parser')
    const prompt = mocks.runTask.mock.calls[0]![0].prompt
    expect(prompt).toBe(
      [
        '<earlier-user-words>',
        'keep the public API stable\n---\nand no new dependencies',
        '</earlier-user-words>',
        '',
        'The goal the user just set:',
        '<goal>',
        'Refactor the parser',
        '</goal>'
      ].join('\n')
    )
  })

  it('GP-6 规划途中：目标已进行中、广播 planning true、还没发目标消息；规划完 planning 回 false（有规格时）', async () => {
    const { session } = await setup()
    const planner = pendingPlanner()
    t.kit.queue(answer('working'))
    const setting = act('Write the changelog')
    await withTimeout(planner.started, 3000, 'planner dispatched')
    const during = views().at(-1)!
    expect(during).toMatchObject({
      status: 'active',
      planning: true,
      objective: 'Write the changelog'
    })
    expect(statusTable()).toEqual({ [SID]: 'active' })
    expect(facades.get(SID)!.admitSteer).not.toHaveBeenCalled()
    expect(t.kit.callCount).toBe(0)

    const absolute = writeSpec('CHANGELOG-spec.md')
    // 设定本身不等规划：规划员还停着时调用就已回 ok
    expect(await setting).toEqual({ ok: true })
    planner.resolve({ structured: { verdict: 'spec', specPath: 'CHANGELOG-spec.md' } })
    await service.whenIdle(SID)
    expect(views().at(-1)).toMatchObject({ planning: false, specPath: absolute })
    await waitFor(() => t.kit.callCount === 1 && !session.isBusy(), 5000, 'set run')
  })

  // 产品 bug（报告给调用方）：结论是 ready（或规划失败）时，setGoal 在规划结束之后不再广播 —— 最后一份视图停在
  // planning: true，目标栏一直显示「规划中」，直到下一次广播（判定开始）。修好后去掉 .fails。
  it('GP-6 规划途中 → ready：规划完最后一份视图 planning 回 false', async () => {
    const { session } = await setup()
    await setAndRun(session, 'Write the changelog')
    expect(views().some((view) => view?.planning === true)).toBe(true)
    expect(views().at(-1)?.planning).toBe(false)
  })
})

describe('goal planner · user actions while planning', () => {
  it('GP-8 规划途中暂停：规划中止（signal 落下）、不发目标消息、不起轮；目标暂停（user）', async () => {
    const { session } = await setup()
    const planner = pendingPlanner()
    const setting = act('Migrate the database')
    const input = await withTimeout(planner.started, 3000, 'planner dispatched')
    expect(await service.act(SID, { type: 'pause' }, LOCAL)).toEqual({ ok: true })
    expect(input.signal.aborted).toBe(true)
    expect(await setting).toEqual({ ok: true })
    await drain()
    expect(facades.get(SID)!.admitSteer).not.toHaveBeenCalled()
    const goal = (await goalOf(session))!
    expect(goal).toMatchObject({
      objective: 'Migrate the database',
      status: 'paused',
      pauseReason: 'user'
    })
    expect(goal.specPath).toBeUndefined()
    expect(statusTable()).toEqual({ [SID]: 'paused' })
    expect(views().at(-1)).toMatchObject({ status: 'paused', planning: false })
    await sleep(80)
    expect(t.kit.callCount).toBe(0)
    // 用户的话没进转写（只有暂停的结局通知）
    expect(
      (await transcript(await session.currentConversation())).filter((l) =>
        l.startsWith('pi.user:')
      )
    ).toEqual([])
  })

  it('GP-8 规划途中清除：规划中止、不发目标消息；记录删掉、表里删掉、广播 null', async () => {
    const { session } = await setup()
    const planner = pendingPlanner()
    const setting = act('Migrate the database')
    const input = await withTimeout(planner.started, 3000, 'planner dispatched')
    expect(await service.act(SID, { type: 'clear' }, LOCAL)).toEqual({ ok: true })
    expect(input.signal.aborted).toBe(true)
    expect(await setting).toEqual({ ok: true })
    await drain()
    expect(facades.get(SID)!.admitSteer).not.toHaveBeenCalled()
    expect(await goalOf(session)).toBeUndefined()
    expect(statusTable()).toEqual({})
    expect(views().at(-1)).toBeNull()
    await sleep(80)
    expect(t.kit.callCount).toBe(0)
  })

  it('GP-8 规划途中 runTask 抛错且已中止 → 同样当作中止，不发目标消息', async () => {
    const { session } = await setup()
    let captured: AbortSignal | undefined
    mocks.runTask.mockImplementationOnce(
      (input) =>
        new Promise<TaskOutcome>((_resolve, reject) => {
          captured = input.signal
          input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
    )
    const setting = act('Migrate the database')
    await waitFor(() => captured !== undefined, 3000, 'planner dispatched')
    expect(await service.act(SID, { type: 'clear' }, LOCAL)).toEqual({ ok: true })
    expect(await setting).toEqual({ ok: true })
    expect(facades.get(SID)!.admitSteer).not.toHaveBeenCalled()
    expect(await goalOf(session)).toBeUndefined()
    expect(mocks.warn.mock.calls.some(([m]) => m.includes('目标规划失败'))).toBe(false)
  })

  it('GP-9 规划途中设新目标：旧规划中止、旧目标不发消息，新目标照常规划并开始', async () => {
    const { session } = await setup()
    const first = pendingPlanner()
    const firstSet = act('Old goal')
    const firstInput = await withTimeout(first.started, 3000, 'first planner')
    const oldId = (await goalOf(session))!.id
    t.kit.queue(answer('on the new goal'))
    const secondSet = act('New goal')
    expect(firstInput.signal.aborted).toBe(true)
    expect(await firstSet).toEqual({ ok: true })
    expect(await secondSet).toEqual({ ok: true })
    await drain()
    expect(mocks.runTask).toHaveBeenCalledTimes(2)
    expect(mocks.runTask.mock.calls[1]![0].prompt).toContain('<goal>\nNew goal\n</goal>')
    const goal = (await goalOf(session))!
    expect(goal.objective).toBe('New goal')
    expect(goal.id).not.toBe(oldId)
    expect(goal.status).toBe('active')
    const text = sentText()
    expect(text.startsWith(`New goal\n\n<goal-set id="${goal.id}">`)).toBe(true)
    expect(text).not.toContain('Old goal')
    await waitFor(() => t.kit.callCount === 1, 5000, 'new goal run')
  })

  it('GP-9 迟到的规格：规划员被中止后才交回 spec → 丢掉，不写进记录', async () => {
    const { session } = await setup()
    const absolute = writeSpec('docs/late.md')
    let release: ((value: TaskOutcome) => void) | undefined
    let captured: AbortSignal | undefined
    // 不理 signal 的规划员：中止之后才回 spec
    mocks.runTask.mockImplementationOnce(
      (input) =>
        new Promise<TaskOutcome>((resolve) => {
          captured = input.signal
          release = resolve
        })
    )
    const setting = act('Old goal')
    await waitFor(() => captured !== undefined, 3000, 'planner dispatched')
    const pausing = service.act(SID, { type: 'pause' }, LOCAL)
    expect(captured!.aborted).toBe(true)
    release!({ structured: { verdict: 'spec', specPath: absolute } })
    expect(await setting).toEqual({ ok: true })
    expect(await pausing).toEqual({ ok: true })
    const goal = (await goalOf(session))!
    expect(goal.specPath).toBeUndefined()
    expect(goal.status).toBe('paused')
    expect(facades.get(SID)!.admitSteer).not.toHaveBeenCalled()
  })
})
