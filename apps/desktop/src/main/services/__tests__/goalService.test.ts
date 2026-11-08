/**
 * 目标模式的宿主侧（services/goalService.ts，docs/goal-mode-design.md）—— 真 durable 会话（agent-runtime 的测试宿主：
 * SQLite + faux）、替身的桌面接缝（设置、会话行、hook 判定、系统通知、任务表、转写、前端广播）。
 *
 * 根运行结束由用例手动交给 `onRootRunEnded`（会话信号的接线另在 sessionSignals 的用例里钉）；`drain()` 等
 * 目标操作的串行队列走空。判定 = `hookTriggers.decide` 的替身（按脚本给结论 / 挂起 / 抛错）。
 *
 * 14a 设定：GV-1 能设目标的会话（D9）· GV-2 原文长度 · GV-3 空闲时设定（缺省上限、脱敏、基线、来源、起一轮）·
 *     GV-4 忙时设定（插话 + 说明，那一轮的结束照常判定）· GV-5 替换（只对进行中 / 暂停中的写 replaced，旧判定中止）·
 *     GV-6 没发出去：旧目标原样放回、不写 replaced · GV-7 设置里的缺省上限（off / 非法 / ≤0 / 取整至少 1）
 * 14b 用户操作：GV-8 暂停（忙时结局通知攒到那一轮结束再写，51e50b75）· GV-9 清除 · GV-10 改原文 · GV-11 只改上限 / 校验 · GV-12 已结束的不能改 · GV-13 恢复 ·
 *     GV-14 喊停之后恢复 / 设新目标照样起轮（B-1 修复）· GV-15 护栏还撞着不让恢复 · GV-16 坏操作
 * 14c 判定：GV-17 运行结束的闸门 · GV-18 中止 / 出错 · GV-19 后台工作 · GV-20 runFactsOf · GV-21 判定的 payload ·
 *     GV-22 not_met → 续跑 · GV-23 met / impossible · GV-24 没有结论 · GV-25 判定途中用户操作 ·
 *     GV-26 不中止判定的操作 + 中止了却没起轮的补判（B-2 修复）· GV-27 判定途中用户发消息 ·
 *     GV-28 下一次判定从上一次事实截止处往后看（B-13 修复）· GV-30 合并窗口里的续跑（已知未修，钉现状）
 * 14d 检查与预算：GV-31 检查的退避 · GV-32 忙 / 中断时的检查 · GV-33 后台工作没了、会话空闲 → 就地判定 ·
 *     GV-34 检查时撞护栏 · GV-35 预算计时器的生命周期 · GV-36 运行中越线 · GV-37 第二次越线照样通知（B-6 修复）·
 *     GV-38 目标的花费（基线、子会话、读失败、价格未知）
 * 14e 启动、fork、删除、状态表：GV-39 启动扫描（另钉 A-7 现状：停机时间算进 activeMs）· GV-40 表与存储不一致按存储
 *     （B-12 修复）· GV-41 判定途中退出 · GV-42 fork 记状态表（观察者本身在 sessionFork.test.ts）· GV-44 删除 ·
 *     GV-46 状态表；GV-43 / GV-45 是 todo
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import {
  readGoal,
  readTranscriptDigest,
  updateGoal,
  type DurableSession,
  type GoalCheckPayload
} from '@shuvix/agent-runtime'
import { GOAL_SET_NOTE_TEXT } from '@shuvix/chat-protocol/goalSet'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type {
  GoalAction,
  GoalRecord,
  GoalVerdict,
  GoalView
} from '@shuvix/chat-protocol/types/goal'
import type { InputOrigin } from '@shuvix/chat-protocol/types/inputOrigin'
import {
  makeHost,
  primeRoot,
  registerHostCleanup,
  type TestHost,
  type TestHostOptions
} from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/host'
import {
  answer,
  callTool,
  stalled
} from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/faux'
import { transcript } from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/transcript'
import { stampUsage } from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/usage'
import {
  deferred,
  sleep,
  waitFor,
  withTimeout,
  type Deferred
} from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/wait'

// ─────────────────────────── 替身 ───────────────────────────

type Row = { parentId?: string | null; settings?: Record<string, unknown>; title?: string }
type Facade = {
  durable: DurableSession
  maskTexts: (texts: readonly string[]) => Promise<string[]>
  admitSteer: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  settingsSet: vi.fn<(key: string, value: string) => void>(),
  rows: new Map<string, Row>(),
  ephemeral: new Set<string>(),
  children: new Map<string, Array<{ id: string; createdAt: number }>>(),
  decide: vi.fn(),
  bound: { names: new Set<string>(['goal-judge']), throws: false },
  broadcast: vi.fn<(event: Record<string, unknown>) => void>(),
  notifyGoalEnded: vi.fn<(sessionId: string, body: string) => void>(),
  running: new Map<string, Record<string, number>>(),
  host: {
    current: undefined as
      | undefined
      | { peek: (id: string) => Promise<unknown>; get: (id: string) => unknown }
  },
  peekError: new Set<string>(),
  ensure: vi.fn<(id: string) => Promise<unknown>>(),
  transcript: vi.fn<(id: string) => Promise<unknown[]>>(),
  warn: vi.fn<(message: string) => void>()
}))

vi.mock('../settingsService', () => ({
  settingsService: {
    get: (key: string) => mocks.settings.get(key),
    set: (key: string, value: string) => {
      mocks.settings.set(key, value)
      mocks.settingsSet(key, value)
    }
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
    isEphemeral: (id: string) => mocks.ephemeral.has(id),
    findChildren: (id: string) => mocks.children.get(id) ?? []
  }
}))
vi.mock('../hookService', () => ({
  hookService: {
    agentsBoundTo: () => {
      if (mocks.bound.throws) throw new Error('registry down')
      return mocks.bound.names
    }
  },
  hookTriggers: { decide: mocks.decide }
}))
vi.mock('../notificationService', () => ({ notifyGoalEnded: mocks.notifyGoalEnded }))
vi.mock('../sessionHost', () => ({
  getSessionHost: () => ({
    peek: async (id: string) => {
      if (mocks.peekError.has(id)) throw new Error(`peek failed ${id}`)
      return mocks.host.current!.peek(id)
    },
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
vi.mock('../taskRegistry', () => ({
  taskRegistry: {
    runningCount: (id: string, kind: string) => mocks.running.get(id)?.[kind] ?? 0
  }
}))
vi.mock('../transcriptSource', () => ({ readSessionTranscript: mocks.transcript }))
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: mocks.broadcast } }))
vi.mock('../../i18n', () => ({
  t: (key: string, vars?: Record<string, unknown>) =>
    vars === undefined ? key : `${key}|${JSON.stringify(vars)}`
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: mocks.warn, error: () => {}, debug: () => {} })
}))

import { GOAL_SESSIONS_SETTING, GoalService, runFactsOf } from '../goalService'

registerHostCleanup()

// ─────────────────────────── 夹具 ───────────────────────────

const SID = 'goal-s1'
const ALL_IDS = [SID, 'goal-s2', 'goal-child', 'goal-a', 'goal-b', 'goal-c', 'goal-d', 'goal-e']
const LOCAL: InputOrigin = { kind: 'local' }
const SECRET = 'sk-proj-SECRETSECRET'
const MASKED = '{{REDACTED_API_KEY_aaaaaaaa}}'

let t: TestHost
let service: GoalService
let offset = 0
const facades = new Map<string, Facade>()
/** 下一次 admitSteer 交回的错误（GV-6） */
let admitError: string | undefined

const now = (): number => Date.now() + offset

function okTool(name = 'probe'): ToolRegistration {
  return defineTool({
    name,
    description: `${name}: works`,
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    execute: async () => ({ output: [{ type: 'text', text: `${name} done` }] })
  })
}

function failTool(): ToolRegistration {
  return defineTool({
    name: 'broken',
    description: 'broken: always fails',
    parameters: Type.Object({}),
    execute: async () => {
      throw new Error('boom')
    }
  })
}

interface Held {
  release: () => void
  running: Promise<void>
}

/** 每个用例一个新宿主；`hold` 给一个扣住的工具 */
async function setup(
  options: { host?: TestHostOptions; checkinFirstMs?: number; budgetCheckMs?: number } = {}
): Promise<{ session: DurableSession; hold: () => Held }> {
  const holds: Array<{ gate: Deferred; running: Deferred }> = []
  let current: { gate: Deferred; running: Deferred } | undefined
  const hold = defineTool({
    name: 'hold',
    description: 'hold: waits for the test',
    parameters: Type.Object({}),
    execute: async (_args, _api, context) => {
      const entry = current ?? { gate: deferred(), running: deferred() }
      current = undefined
      entry.running.resolve()
      const signal = context.abortSignal
      await Promise.race([
        entry.gate.promise,
        new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))
      ])
      return { output: [{ type: 'text', text: 'hold done' }] }
    }
  })
  t = await makeHost({
    noticeCoalesceMs: 20,
    tools: [okTool(), failTool(), hold],
    ...options.host
  })
  mocks.host.current = t.host
  service = new GoalService({
    now,
    checkinFirstMs: options.checkinFirstMs ?? 60_000,
    budgetCheckMs: options.budgetCheckMs ?? 60_000
  })
  const session = await t.open(SID)
  await primeRoot(session)
  return {
    session,
    hold: () => {
      const entry = { gate: deferred(), running: deferred() }
      holds.push(entry)
      current = entry
      return { release: () => entry.gate.resolve(), running: entry.running.promise }
    }
  }
}

function facadeOf(session: DurableSession): Facade {
  let facade = facades.get(session.sessionId)
  if (facade === undefined || facade.durable !== session) {
    facade = {
      durable: session,
      maskTexts: async (texts) => texts.map((text) => text.split(SECRET).join(MASKED)),
      admitSteer: vi.fn(async (text: string, options: Record<string, unknown>) => {
        if (admitError !== undefined) return { error: admitError }
        return session.steer(text, options as never)
      })
    }
    facades.set(session.sessionId, facade)
  }
  return facade
}

beforeEach(() => {
  offset = 0
  admitError = undefined
  facades.clear()
  mocks.settings.clear()
  mocks.settingsSet.mockReset()
  mocks.rows.clear()
  mocks.ephemeral.clear()
  mocks.children.clear()
  mocks.decide.mockReset()
  mocks.decide.mockResolvedValue(null)
  mocks.bound.names = new Set(['goal-judge'])
  mocks.bound.throws = false
  mocks.broadcast.mockReset()
  mocks.notifyGoalEnded.mockReset()
  mocks.running.clear()
  mocks.peekError.clear()
  mocks.warn.mockReset()
  for (const id of ALL_IDS)
    mocks.rows.set(id, { parentId: null, settings: {}, title: 'Goal session' })
  mocks.ensure.mockImplementation(async (id: string) => facadeOf(await t.host.open(id)))
  mocks.transcript.mockImplementation(async (id: string) => {
    const session = await t.host.peek(id)
    return session === undefined ? [] : (await readTranscriptDigest(session)).items
  })
})

afterEach(() => {
  service?.dispose()
})

/** 目标操作的串行队列走空 */
async function drain(sessionId = SID): Promise<void> {
  const serial = (service as unknown as { serial: Map<string, Promise<unknown>> }).serial
  for (let n = 0; n < 50; n++) {
    const pending = serial.get(sessionId)
    if (pending === undefined) return
    await pending
  }
}

/** 等会话空闲，交一次根运行结束，等队列走空 */
async function endRun(
  session: DurableSession,
  reason: 'ok' | 'aborted' | 'error' = 'ok'
): Promise<void> {
  await waitFor(() => !session.isBusy(), 5000, 'session idle before run end')
  service.onRootRunEnded(session.sessionId, reason)
  await drain(session.sessionId)
}

async function goalOf(session: DurableSession): Promise<GoalRecord | undefined> {
  return readGoal(session.harness)
}

async function lines(session: DurableSession): Promise<string[]> {
  return transcript(await session.currentConversation())
}

function act(action: GoalAction, sessionId = SID): Promise<unknown> {
  return service.act(sessionId, action, LOCAL)
}

/** 设定并等那一轮跑完（排好那一轮的应答） */
async function setAndRun(
  session: DurableSession,
  objective = 'Make e2e green',
  limits?: GoalAction extends { limits?: infer L } ? L : never
): Promise<GoalRecord> {
  const before = t.kit.callCount
  t.kit.queue(answer('working on it'))
  expect(
    await act({ type: 'set', objective, ...(limits === undefined ? {} : { limits }) })
  ).toEqual({ ok: true })
  await waitFor(() => t.kit.callCount > before && !session.isBusy(), 5000, 'set run')
  return (await goalOf(session))!
}

function verdictOnce(verdict: GoalVerdict): void {
  mocks.decide.mockResolvedValueOnce({ result: verdict, hook: 'goal-check' })
}

/** 广播出去的目标视图（按次序） */
function views(sessionId = SID): Array<GoalView | null> {
  return mocks.broadcast.mock.calls
    .map(([event]) => event)
    .filter((event) => event.type === 'goal' && event.sessionId === sessionId)
    .map((event) => event.goal as GoalView | null)
}

function lastView(sessionId = SID): GoalView | null | undefined {
  return views(sessionId).at(-1)
}

function statusTable(): Record<string, string> {
  return JSON.parse(mocks.settings.get(GOAL_SESSIONS_SETTING) ?? '{}') as Record<string, string>
}

/** 直接写一份目标进存储（并记表） */
async function seedGoal(
  session: DurableSession,
  over: Partial<GoalRecord> = {}
): Promise<GoalRecord> {
  const goal: GoalRecord = {
    id: 'g_seed',
    objective: 'Seeded goal',
    status: 'active',
    setAt: now(),
    limits: { costUsd: 5, maxTurns: 50, stallTurns: 3 },
    baselineCostUsd: 0,
    turns: 0,
    stalls: 0,
    activeMs: 0,
    activeSince: now(),
    ...over
  }
  await updateGoal(session.harness, () => goal)
  const table = statusTable()
  if (goal.status === 'active' || goal.status === 'paused') table[session.sessionId] = goal.status
  else delete table[session.sessionId]
  mocks.settings.set(GOAL_SESSIONS_SETTING, JSON.stringify(table))
  // 表是服务自己缓存的（产品里只有它写）：直接改了设置，缓存跟着作废
  ;(service as unknown as { statusCache: unknown }).statusCache = undefined
  return (await goalOf(session))!
}

/** 挂起的判定：像真 runner 一样，signal 落下就交回 null；`resolve` 给结论 */
function pendingJudge(): {
  signal: () => AbortSignal | undefined
  resolve: (value: { result: GoalVerdict; hook: string } | null) => void
} {
  let signal: AbortSignal | undefined
  let settle: ((value: unknown) => void) | undefined
  mocks.decide.mockImplementationOnce(
    (_id: string, _payload: unknown, opts: { signal: AbortSignal }) =>
      new Promise((resolve) => {
        signal = opts.signal
        settle = resolve
        opts.signal.addEventListener('abort', () => resolve(null), { once: true })
      })
  )
  return { signal: () => signal, resolve: (value) => settle?.(value) }
}

const notices = async (session: DurableSession, tag: string): Promise<string[]> =>
  (await lines(session)).filter((line) => line.includes(`<${tag}`))

/**
 * 等某种通知的那一行出现，交回最后一条。忙时 steer 的通知偶尔晚一拍（提交之后、放下之前那一轮已经答完，它就自成
 * 一轮）—— 用例给这种情形多排一个应答，断言只看它到了、是 pi.user（不是写下的 shuvix.notice）
 */
async function lineOf(session: DurableSession, tag: string, contains = ''): Promise<string> {
  let found: string | undefined
  await waitFor(
    async () => {
      found = (await notices(session, tag)).filter((line) => line.includes(contains)).at(-1)
      return found !== undefined
    },
    5000,
    `${tag} line`
  )
  return found!
}

// ─────────────────────────── 14a 设定 ───────────────────────────

describe('14a · set / eligibility / defaults', () => {
  it('GV-1 能设目标的只有人发起的根会话（D9）：子会话、bot、笔记本、Chrome 标签页、内存会话、不认识的 → errorNotEligible，什么都不写', async () => {
    const { session } = await setup()
    const cases: Array<[string, Row | undefined, boolean]> = [
      ['root work', { parentId: null, settings: {} }, true],
      ['root pinned coding', { parentId: null, settings: { agentProfile: 'coding' } }, true],
      ['sub-session', { parentId: 'parent', settings: {} }, false],
      ['bot', { parentId: null, settings: { bot: { name: 'diary' } } }, false],
      ['notebook', { parentId: null, settings: { notebookPath: 'a.md' } }, false],
      [
        'chrome tab',
        { parentId: null, settings: { chromeTab: { installId: 'i', runId: 'r', tabId: 3 } } },
        false
      ],
      ['unknown id', undefined, false]
    ]
    for (const [label, row, eligible] of cases) {
      if (row === undefined) mocks.rows.delete(SID)
      else mocks.rows.set(SID, row)
      expect(service.eligible(SID), label).toBe(eligible)
    }
    mocks.rows.set(SID, { parentId: null, settings: {} })
    mocks.ephemeral.add(SID)
    expect(service.eligible(SID), 'ephemeral').toBe(false)
    const result = await act({ type: 'set', objective: 'x' })
    expect(result).toEqual({ ok: false, error: 'goal.errorNotEligible' })
    expect(await goalOf(session)).toBeUndefined()
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(await lines(session)).toEqual([])
  })

  it('GV-2 原文：纯空白 / 去空白后 4001 字 → 长度错误、什么都不写；4000 字照收', async () => {
    const { session } = await setup()
    for (const objective of ['   ', `  ${'x'.repeat(4001)}  `]) {
      const result = (await act({ type: 'set', objective })) as { ok: boolean; error: string }
      expect(result.ok).toBe(false)
      expect(result.error).toContain('goal.errorObjectiveLength')
    }
    expect(await goalOf(session)).toBeUndefined()
    const goal = await setAndRun(session, 'y'.repeat(4000))
    expect(goal.objective).toHaveLength(4000)
  })

  it('GV-3 空闲时设定：缺省上限 + 补丁、脱敏的原文、基线、表、广播、一条带目标 Token 的人的消息（来源原样）、起一轮', async () => {
    const { session } = await setup()
    const stamp = stampUsage(t.kit)
    stamp.queue({ input: 10, cost: 2 })
    t.kit.queue(answer('before'))
    expect(await session.submitUser('earlier work')).toEqual({})
    mocks.settings.set('goal.defaultCostUsd', '7')
    mocks.settings.set('goal.defaultMaxTurns', '20')
    const remote: InputOrigin = { kind: 'remote', clientId: 'ws:1', address: '10.0.0.2' }
    t.kit.queue(answer('on it'))
    const result = await service.act(
      SID,
      { type: 'set', objective: `  rotate ${SECRET} and redeploy  `, limits: { maxTurns: 5 } },
      remote
    )
    expect(result).toEqual({ ok: true })
    const goal = (await goalOf(session))!
    expect(goal).toMatchObject({
      objective: `rotate ${MASKED} and redeploy`,
      status: 'active',
      limits: { costUsd: 7, maxTurns: 5, stallTurns: 3 },
      turns: 0,
      stalls: 0
    })
    expect(goal.baselineCostUsd).toBeCloseTo(2, 9)
    expect(goal.id).toMatch(/^g_[0-9a-f]{8}$/)
    expect(statusTable()).toEqual({ [SID]: 'active' })
    expect(lastView()).toMatchObject({
      id: goal.id,
      sessionId: SID,
      costUsd: 0,
      judging: false,
      checkerMissing: false
    })

    const facade = facades.get(SID)!
    expect(facade.admitSteer).toHaveBeenCalledTimes(1)
    const [text, options] = facade.admitSteer.mock.calls[0]! as [
      string,
      { source: unknown; display: { tokens: Record<string, { type: string; id: string }> } }
    ]
    expect(text.startsWith(`rotate ${MASKED} and redeploy\n\n<goal-set id="${goal.id}">`)).toBe(
      true
    )
    expect(text).not.toContain(SECRET)
    expect(options.source).toEqual(remote)
    expect(Object.values(options.display.tokens)).toEqual([
      expect.objectContaining({ type: 'goal', id: goal.id })
    ])

    await waitFor(() => t.kit.callCount === 2, 5000, 'set run')
    const view = await session.viewSnapshot()
    const bubble = view.messages.filter((m) => m.role === 'user').at(-1)!
    expect(bubble.content.startsWith(`rotate ${MASKED} and redeploy`)).toBe(true)
    expect(bubble.metadata?.origin).toMatchObject({ kind: 'remote', clientId: 'ws:1' })
  })

  it('GV-4 忙时设定：插话（带插话说明）汇入当前轮，目标立刻进行中；那一轮结束照常判定', async () => {
    const { session, hold } = await setup()
    const held = hold()
    t.kit.queue(callTool('hold'), answer('done'))
    const sending = session.submitUser('go')
    await held.running
    expect(await act({ type: 'set', objective: 'Ship it' })).toEqual({ ok: true })
    expect((await goalOf(session))?.status).toBe('active')
    held.release()
    expect(await withTimeout(sending, 5000, 'round')).toEqual({})
    const userLines = (await lines(session)).filter((line) => line.startsWith('pi.user:'))
    expect(userLines.at(-1)).toContain('Ship it\n\n<goal-set')
    expect(userLines.at(-1)).toContain('[Sent while you were working.')
    verdictOnce({ verdict: 'met', reason: 'shipped' })
    await endRun(session)
    expect(mocks.decide).toHaveBeenCalledTimes(1)
    expect((await goalOf(session))?.status).toBe('met')
  })

  it('GV-5 替换：进行中 / 暂停中的旧目标写一条 replaced（旧 id）；met / impossible 不写；新 id 不同', async () => {
    const { session } = await setup()
    for (const status of ['active', 'paused', 'met', 'impossible'] as const) {
      const old = await seedGoal(session, {
        id: `g_old_${status}`,
        status,
        ...(status === 'paused' ? { pauseReason: 'user' as const } : {})
      })
      const goal = await setAndRun(session, `new goal over ${status}`)
      expect(goal.id).not.toBe(old.id)
      // 设定那一轮还在跑时 replaced 先攒着，那一轮结束时写下（判定的替身缺省没有结论 → 新目标暂停，与本例无关）
      await endRun(session)
      const replaced = (await notices(session, 'goal-status')).filter((line) =>
        line.includes(old.id)
      )
      expect(replaced.length, status).toBe(status === 'active' || status === 'paused' ? 1 : 0)
      if (replaced.length > 0) {
        expect(replaced[0]).toContain('event="replaced"')
        expect(replaced[0]!.startsWith('shuvix.notice:')).toBe(true)
      }
    }
  })

  it('GV-5 替换时中止在途的判定：旧判定的 signal 落下，迟到的结论丢掉', async () => {
    const { session } = await setup()
    const first = await setAndRun(session, 'first goal')
    const judge = pendingJudge()
    service.onRootRunEnded(SID, 'ok')
    await waitFor(() => judge.signal() !== undefined, 3000, 'judging')
    t.kit.queue(answer('second'))
    expect(await act({ type: 'set', objective: 'second goal' })).toEqual({ ok: true })
    expect(judge.signal()!.aborted).toBe(true)
    judge.resolve({ result: { verdict: 'met', reason: 'late' }, hook: 'goal-check' })
    await drain()
    const goal = (await goalOf(session))!
    expect(goal.objective).toBe('second goal')
    expect(goal.id).not.toBe(first.id)
    expect(goal.status).toBe('active')
  })

  it('GV-6 没发出去（admitSteer 报错）：{ok:false, error}；旧目标原样放回，不写 replaced', async () => {
    const { session } = await setup()
    const previous = await seedGoal(session, {
      id: 'g_prev',
      status: 'paused',
      pauseReason: 'budget',
      turns: 4
    })
    admitError = 'No model is configured'
    const result = await act({ type: 'set', objective: 'a new goal' })
    expect(result).toEqual({ ok: false, error: 'No model is configured' })
    expect(await goalOf(session)).toStrictEqual(previous)
    expect(await notices(session, 'goal-status')).toEqual([])
    expect(statusTable()).toEqual({ [SID]: 'paused' })
    expect(lastView()).toMatchObject({ id: 'g_prev', status: 'paused' })
  })

  it('GV-6 没有旧目标时没发出去 → 目标删掉、表里没有它', async () => {
    const { session } = await setup()
    admitError = 'No model is configured'
    expect(await act({ type: 'set', objective: 'a new goal' })).toMatchObject({ ok: false })
    expect(await goalOf(session)).toBeUndefined()
    expect(statusTable()).toEqual({})
    expect(lastView()).toBeNull()
  })

  it('GV-7 设置里的缺省上限：off = 不限花费；非法 / ≤0 → 5；轮数 / 停滞取整且至少 1', async () => {
    await setup()
    const cases: Array<[Record<string, string>, object]> = [
      [{}, { costUsd: 5, maxTurns: 50, stallTurns: 3 }],
      [{ 'goal.defaultCostUsd': 'off' }, { maxTurns: 50, stallTurns: 3 }],
      [{ 'goal.defaultCostUsd': ' off ' }, { maxTurns: 50, stallTurns: 3 }],
      [{ 'goal.defaultCostUsd': 'abc' }, { costUsd: 5, maxTurns: 50, stallTurns: 3 }],
      [{ 'goal.defaultCostUsd': '0' }, { costUsd: 5, maxTurns: 50, stallTurns: 3 }],
      [{ 'goal.defaultCostUsd': '-3' }, { costUsd: 5, maxTurns: 50, stallTurns: 3 }],
      [{ 'goal.defaultCostUsd': '2.5' }, { costUsd: 2.5, maxTurns: 50, stallTurns: 3 }],
      [
        { 'goal.defaultMaxTurns': '0.3', 'goal.stallTurns': '0.2' },
        { costUsd: 5, maxTurns: 1, stallTurns: 1 }
      ],
      [
        { 'goal.defaultMaxTurns': '7.6', 'goal.stallTurns': '-1' },
        { costUsd: 5, maxTurns: 8, stallTurns: 3 }
      ]
    ]
    for (const [settings, expected] of cases) {
      mocks.settings.clear()
      for (const [key, value] of Object.entries(settings)) mocks.settings.set(key, value)
      expect(service.defaultLimits(), JSON.stringify(settings)).toStrictEqual(expected)
    }
  })
})

// ─────────────────────────── 14b 用户操作 ───────────────────────────

describe('14b · user actions', () => {
  it('GV-8 暂停进行中的（空闲）：paused user、写 goal-status（reason user）、广播、不弹系统通知；暂停中 / 已结束的：ok、什么都不写', async () => {
    const { session } = await setup()
    await setAndRun(session)
    const before = (await lines(session)).length
    expect(await act({ type: 'pause' })).toEqual({ ok: true })
    const goal = (await goalOf(session))!
    expect(goal).toMatchObject({ status: 'paused', pauseReason: 'user' })
    expect(goal.activeSince).toBeUndefined()
    const status = await notices(session, 'goal-status')
    expect(status).toHaveLength(1)
    expect(status[0]).toContain('event="paused" reason="user"')
    expect(status[0]!.startsWith('shuvix.notice:')).toBe(true)
    expect(lastView()).toMatchObject({ status: 'paused' })
    expect(statusTable()).toEqual({ [SID]: 'paused' })
    expect(mocks.notifyGoalEnded).not.toHaveBeenCalled()

    const after = (await lines(session)).length
    expect(after).toBe(before + 1)
    expect(await act({ type: 'pause' })).toEqual({ ok: true })
    await seedGoal(session, { id: 'g_met', status: 'met', endedAt: now() })
    expect(await act({ type: 'pause' })).toEqual({ ok: true })
    expect((await lines(session)).length).toBe(after)
    expect(t.kit.callCount).toBe(1)
  })

  it('GV-8 运行中暂停：结局通知不 steer 进那一轮（不多跑一次模型），攒到那一轮结束时写下；那一轮结束不判定', async () => {
    const { session, hold } = await setup()
    await seedGoal(session)
    const held = hold()
    t.kit.queue(callTool('hold'), answer('wrapped up'))
    const sending = session.submitUser('go')
    await held.running
    expect(await act({ type: 'pause' })).toEqual({ ok: true })
    expect((await goalOf(session))!.status).toBe('paused')
    held.release()
    expect(await withTimeout(sending, 5000, 'round')).toEqual({})
    expect(await notices(session, 'goal-status')).toEqual([])
    await endRun(session)
    const status = await notices(session, 'goal-status')
    expect(status).toHaveLength(1)
    expect(status[0]!.startsWith('shuvix.notice:')).toBe(true)
    expect(status[0]).toContain('event="paused" reason="user"')
    expect(t.kit.callCount).toBe(2)
    expect(mocks.decide).not.toHaveBeenCalled()
  })

  it('GV-8 攒着的结局通知：会话删除（forget）时丢掉，不写', async () => {
    const { session, hold } = await setup()
    await seedGoal(session)
    const held = hold()
    t.kit.queue(callTool('hold'), answer('ok'))
    const sending = session.submitUser('go')
    await held.running
    expect(await act({ type: 'clear' })).toEqual({ ok: true })
    service.forget(SID)
    held.release()
    await withTimeout(sending, 5000, 'round')
    await endRun(session)
    expect(await notices(session, 'goal-status')).toEqual([])
  })

  it('GV-9 清除：记录删掉、写 cleared（旧 id）、表里删掉、广播 goal:null、检查计时器停；没有目标 → errorNoGoal', async () => {
    const { session } = await setup({ checkinFirstMs: 30 })
    const goal = await setAndRun(session)
    mocks.running.set(SID, { bash: 1 })
    await endRun(session)
    const checkins = (service as unknown as { checkins: Map<string, unknown> }).checkins
    expect(checkins.has(SID)).toBe(true)
    expect(await act({ type: 'clear' })).toEqual({ ok: true })
    expect(await goalOf(session)).toBeUndefined()
    const cleared = await notices(session, 'goal-status')
    expect(cleared).toHaveLength(1)
    expect(cleared[0]).toContain(`id="${goal.id}" event="cleared"`)
    expect(statusTable()).toEqual({})
    expect(lastView()).toBeNull()
    expect(checkins.has(SID)).toBe(false)
    await sleep(80)
    expect(await notices(session, 'goal-checkin')).toEqual([])
    expect(await act({ type: 'clear' })).toEqual({ ok: false, error: 'goal.errorNoGoal' })
  })

  it('GV-9 运行中清除：那一轮结束时什么都不做', async () => {
    const { session, hold } = await setup()
    await seedGoal(session)
    const held = hold()
    t.kit.queue(callTool('hold'), answer('ok'))
    const sending = session.submitUser('go')
    await held.running
    expect(await act({ type: 'clear' })).toEqual({ ok: true })
    held.release()
    await withTimeout(sending, 5000, 'round')
    await endRun(session)
    expect(mocks.decide).not.toHaveBeenCalled()
    expect(await goalOf(session)).toBeUndefined()
  })

  it('GV-10 改原文（进行中、空闲）：存脱敏的新原文、停滞清零、<goal-updated> 起一轮；下一次续跑重述新原文', async () => {
    const { session } = await setup()
    await setAndRun(session)
    await updateGoal(session.harness, (g) => ({ ...g!, stalls: 2 }))
    t.kit.queue(answer('switching'))
    expect(await act({ type: 'edit', objective: `  new target ${SECRET} ` })).toEqual({ ok: true })
    const goal = (await goalOf(session))!
    expect(goal.objective).toBe(`new target ${MASKED}`)
    expect(goal.stalls).toBe(0)
    await waitFor(() => t.kit.callCount === 2, 5000, 'updated run')
    const updated = await notices(session, 'goal-updated')
    expect(updated).toHaveLength(1)
    expect(updated[0]!.startsWith('pi.user:')).toBe(true)
    expect(updated[0]).toContain(`new target ${MASKED}`)
    expect(updated[0]).not.toContain(SECRET)

    verdictOnce({ verdict: 'not_met', reason: 'not yet' })
    t.kit.queue(answer('continuing'))
    await endRun(session)
    await waitFor(() => t.kit.callCount === 3, 5000, 'continuation run')
    const continued = await notices(session, 'goal-continue')
    expect(continued.at(-1)).toContain(`new target ${MASKED}`)
  })

  it('GV-10 改原文（暂停中）：只写，不起轮；（忙时）steer 进当前轮', async () => {
    const { session, hold } = await setup()
    await seedGoal(session, { status: 'paused', pauseReason: 'user' })
    expect(await act({ type: 'edit', objective: 'paused edit' })).toEqual({ ok: true })
    await sleep(80)
    expect((await notices(session, 'goal-updated'))[0]!.startsWith('shuvix.notice:')).toBe(true)
    expect(t.kit.callCount).toBe(0)

    await updateGoal(session.harness, (g) => ({ ...g!, status: 'active', pauseReason: undefined }))
    const held = hold()
    t.kit.queue(callTool('hold'), answer('ok'), answer('spare'))
    const sending = session.submitUser('go')
    await held.running
    expect(await act({ type: 'edit', objective: 'busy edit' })).toEqual({ ok: true })
    held.release()
    await withTimeout(sending, 5000, 'round')
    expect((await lineOf(session, 'goal-updated', 'busy edit')).startsWith('pi.user:')).toBe(true)
  })

  it('GV-11 只改上限：合并、不写通知、广播；原文为空 / 过长 → 长度错误、什么都不改', async () => {
    const { session } = await setup()
    const goal = await setAndRun(session)
    const before = await lines(session)
    expect(await act({ type: 'edit', limits: { costUsd: 20, wallClockMin: 90 } })).toEqual({
      ok: true
    })
    expect((await goalOf(session))!.limits).toStrictEqual({
      ...goal.limits,
      costUsd: 20,
      wallClockMin: 90
    })
    expect(lastView()?.limits.costUsd).toBe(20)
    // null = 不限（只对花费 / 时长）
    expect(await act({ type: 'edit', limits: { costUsd: null, wallClockMin: null } })).toEqual({
      ok: true
    })
    expect((await goalOf(session))!.limits).toStrictEqual({
      maxTurns: goal.limits.maxTurns,
      stallTurns: 3
    })
    expect(await lines(session)).toEqual(before)

    for (const objective of ['', 'x'.repeat(4001)]) {
      const result = (await act({ type: 'edit', objective })) as { ok: boolean; error: string }
      expect(result.ok).toBe(false)
      expect(result.error).toContain('goal.errorObjectiveLength')
    }
    expect((await goalOf(session))!.objective).toBe('Make e2e green')
  })

  it('GV-12 已结束的目标不能改：{ok:false, errorEnded}，不写通知', async () => {
    const { session } = await setup()
    for (const status of ['met', 'impossible'] as const) {
      await seedGoal(session, { status, endedAt: now() })
      expect(await act({ type: 'edit', objective: 'something else' })).toEqual({
        ok: false,
        error: 'goal.errorEnded'
      })
      expect(await act({ type: 'edit', limits: { costUsd: 9 } })).toEqual({
        ok: false,
        error: 'goal.errorEnded'
      })
      expect((await goalOf(session))!.objective).toBe('Seeded goal')
    }
    expect(await lines(session)).toEqual([])
  })

  it('GV-13 恢复暂停的（空闲）：进行中、停滞清零、activeSince = now、resumed 通知起一轮；进行中 / 已结束的：ok、什么都不做', async () => {
    const { session } = await setup()
    await seedGoal(session, {
      status: 'paused',
      pauseReason: 'stalled',
      stalls: 3,
      turns: 2,
      activeSince: undefined,
      lastVerdict: { verdict: 'not_met', reason: 'lint fails', at: now() }
    })
    offset = 5000
    t.kit.queue(answer('resumed'))
    expect(await act({ type: 'resume' })).toEqual({ ok: true })
    const goal = (await goalOf(session))!
    expect(goal).toMatchObject({ status: 'active', stalls: 0, turns: 2 })
    expect(goal.pauseReason).toBeUndefined()
    expect(Math.abs(goal.activeSince! - now())).toBeLessThan(1000)
    await waitFor(() => t.kit.callCount === 1, 5000, 'resumed run')
    const resumed = await notices(session, 'goal-continue')
    expect(resumed).toHaveLength(1)
    expect(resumed[0]).toContain('resumed="true"')
    expect(resumed[0]).toContain('Last check: lint fails')
    expect(statusTable()).toEqual({ [SID]: 'active' })

    await waitFor(() => !session.isBusy())
    expect(await act({ type: 'resume' })).toEqual({ ok: true })
    await seedGoal(session, { status: 'met', endedAt: now() })
    expect(await act({ type: 'resume' })).toEqual({ ok: true })
    await sleep(80)
    expect(t.kit.callCount).toBe(1)
  })

  it('GV-13 忙时恢复：不写通知，那一轮结束照常判定', async () => {
    const { session, hold } = await setup()
    await seedGoal(session, { status: 'paused', pauseReason: 'user', activeSince: undefined })
    const held = hold()
    t.kit.queue(callTool('hold'), answer('ok'))
    const sending = session.submitUser('go')
    await held.running
    expect(await act({ type: 'resume' })).toEqual({ ok: true })
    held.release()
    await withTimeout(sending, 5000, 'round')
    expect(await notices(session, 'goal-continue')).toEqual([])
    verdictOnce({ verdict: 'met', reason: 'done' })
    await endRun(session)
    expect(mocks.decide).toHaveBeenCalledTimes(1)
  })

  it('GV-14 用户喊停之后：暂停 stopped；点继续（没打字）照样起一轮；之后的续跑也起轮（B-1 修复）', async () => {
    const { session, hold } = await setup()
    await setAndRun(session)
    const held = hold()
    t.kit.queue(callTool('hold'), answer('never'))
    void session.submitUser('long work')
    await held.running
    await withTimeout(session.abort(), 5000, 'abort')
    await endRun(session, 'aborted')
    expect(await goalOf(session)).toMatchObject({ status: 'paused', pauseReason: 'stopped' })
    expect(mocks.notifyGoalEnded).not.toHaveBeenCalled()

    const calls = t.kit.callCount
    t.kit.queue(answer('resumed work'))
    expect(await act({ type: 'resume' })).toEqual({ ok: true })
    await waitFor(() => t.kit.callCount === calls + 1, 5000, 'resumed run after a stop')
    verdictOnce({ verdict: 'not_met', reason: 'more to do' })
    t.kit.queue(answer('continued'))
    await endRun(session)
    await waitFor(() => t.kit.callCount === calls + 2, 5000, 'continuation after a stop')
  })

  it('GV-14 喊停之后设新目标：设定那一轮起，它的续跑也起轮', async () => {
    const { session, hold } = await setup()
    const held = hold()
    t.kit.queue(callTool('hold'), answer('never'))
    void session.submitUser('work')
    await held.running
    await withTimeout(session.abort(), 5000, 'abort')
    await waitFor(() => !session.isBusy())
    const calls = t.kit.callCount
    await setAndRun(session, 'after the stop')
    expect(t.kit.callCount).toBe(calls + 1)
    verdictOnce({ verdict: 'not_met', reason: 'keep going' })
    t.kit.queue(answer('continued'))
    await endRun(session)
    await waitFor(() => t.kit.callCount === calls + 2, 5000, 'continuation')
  })

  it('GV-15 护栏还撞着不让恢复：轮数满 / 超支 → {ok:false, resumeBlocked}，状态不变；调高上限之后能恢复；停滞不挡', async () => {
    const { session } = await setup()
    await seedGoal(session, {
      status: 'paused',
      pauseReason: 'turns',
      turns: 50,
      activeSince: undefined
    })
    expect(await act({ type: 'resume' })).toEqual({ ok: false, error: 'goal.resumeBlocked.turns' })
    expect((await goalOf(session))!.status).toBe('paused')
    expect(await act({ type: 'edit', limits: { maxTurns: 60 } })).toEqual({ ok: true })
    t.kit.queue(answer('resumed'))
    expect(await act({ type: 'resume' })).toEqual({ ok: true })
    expect((await goalOf(session))!.status).toBe('active')
    await waitFor(() => !session.isBusy() && t.kit.callCount === 1)

    const stamp = stampUsage(t.kit)
    stamp.queue({ input: 1, cost: 6 })
    t.kit.queue(answer('spent'))
    await session.submitUser('expensive')
    await seedGoal(session, {
      id: 'g_budget',
      status: 'paused',
      pauseReason: 'budget',
      activeSince: undefined
    })
    expect(await act({ type: 'resume' })).toEqual({ ok: false, error: 'goal.resumeBlocked.budget' })
    await seedGoal(session, {
      id: 'g_stall',
      status: 'paused',
      pauseReason: 'stalled',
      stalls: 3,
      activeSince: undefined,
      limits: { maxTurns: 50, stallTurns: 3 }
    })
    t.kit.queue(answer('ok'))
    expect(await act({ type: 'resume' })).toEqual({ ok: true })
  })

  it('GV-16 没有会话 / 没有目标 → errorNoGoal', async () => {
    const { session } = await setup()
    expect(await act({ type: 'pause' }, 'goal-never-opened')).toEqual({
      ok: false,
      error: 'goal.errorNoGoal'
    })
    expect(await act({ type: 'resume' })).toEqual({ ok: false, error: 'goal.errorNoGoal' })
    expect(await act({ type: 'edit', limits: { costUsd: 1 } })).toEqual({
      ok: false,
      error: 'goal.errorNoGoal'
    })
    expect(await goalOf(session)).toBeUndefined()
  })

  // 网络客户端经 agent:goalAct 能发任意 JSON：形状守卫（isGoalAction）在入队之前拒掉
  it('GV-16 认不出的操作类型 → {ok:false}', async () => {
    const { session } = await setup()
    await seedGoal(session)
    expect(await act({ type: 'bogus' } as unknown as GoalAction)).toMatchObject({ ok: false })
  })

  it(
    'GV-16 objective 不是字符串 → {ok:false} 且什么都不写',
    async () => {
      const { session } = await setup()
      const result = await act({ type: 'set', objective: 42 } as unknown as GoalAction)
      expect(result).toMatchObject({ ok: false })
      expect(await goalOf(session)).toBeUndefined()
    }
  )
})

// ─────────────────────────── 14c 判定 ───────────────────────────

describe('14c · run end → judge → continue / finish / pause', () => {
  it('GV-17 闸门：表里不是 active → 什么都不读；会话关了 → 不判；忙 → 不判（下一次结束再判）；被中断 → 不判', async () => {
    const { session, hold } = await setup()
    await updateGoal(session.harness, () => ({
      id: 'g_x',
      objective: 'x',
      status: 'active',
      setAt: now(),
      limits: { costUsd: 5, maxTurns: 50, stallTurns: 3 },
      baselineCostUsd: 0,
      turns: 0,
      stalls: 0,
      activeMs: 0,
      activeSince: now()
    }))
    // 表里没有它
    service.onRootRunEnded(SID, 'ok')
    await drain()
    expect(mocks.decide).not.toHaveBeenCalled()

    await seedGoal(session)
    const held = hold()
    t.kit.queue(callTool('hold'), answer('ok'))
    const sending = session.submitUser('go')
    await held.running
    service.onRootRunEnded(SID, 'ok')
    await drain()
    expect(mocks.decide).not.toHaveBeenCalled()
    held.release()
    await withTimeout(sending, 5000, 'round')
    verdictOnce({ verdict: 'met', reason: 'done' })
    await endRun(session)
    expect(mocks.decide).toHaveBeenCalledTimes(1)

    await seedGoal(session, { id: 'g_closed' })
    await t.host.close(SID)
    service.onRootRunEnded(SID, 'ok')
    await drain()
    expect(mocks.decide).toHaveBeenCalledTimes(1)
  })

  it('GV-17 被中断的会话：运行结束不判（等用户点继续）', async () => {
    const first = await makeHost({ noticeCoalesceMs: 20 })
    const original = await first.open(SID)
    await primeRoot(original)
    await seedGoalOn(original)
    const stall = stalled()
    first.kit.queue(stall.step)
    void original.submitUser('hello')
    await stall.reached
    t = await first.restart({ noticeCoalesceMs: 20 })
    mocks.host.current = t.host
    service = new GoalService({ now })
    mocks.settings.set(GOAL_SESSIONS_SETTING, JSON.stringify({ [SID]: 'active' }))
    const session = await t.open(SID)
    expect(session.isInterrupted()).toBe(true)
    service.onRootRunEnded(SID, 'ok')
    await drain()
    expect(mocks.decide).not.toHaveBeenCalled()
  })

  it('GV-18 中止 → paused stopped；出错 → paused run-error；都写 goal-status，都不弹系统通知（出错那一轮已经弹过失败）', async () => {
    const { session } = await setup()
    await seedGoal(session)
    await endRun(session, 'aborted')
    expect(await goalOf(session)).toMatchObject({ status: 'paused', pauseReason: 'stopped' })
    await seedGoal(session, { id: 'g_err' })
    await endRun(session, 'error')
    expect(await goalOf(session)).toMatchObject({ status: 'paused', pauseReason: 'run-error' })
    const status = await notices(session, 'goal-status')
    expect(status.map((line) => /reason="([a-z-]+)"/.exec(line)?.[1])).toEqual([
      'stopped',
      'run-error'
    ])
    expect(mocks.notifyGoalEnded).not.toHaveBeenCalled()
    expect(mocks.decide).not.toHaveBeenCalled()
  })

  it('GV-19 后台工作在跑：不判、停滞不动、只起一个检查计时器（第二次等待不重起）；跑完之后照常判', async () => {
    const { session } = await setup({ checkinFirstMs: 60_000 })
    await seedGoal(session, { stalls: 1 })
    mocks.running.set(SID, { bash: 1 })
    await endRun(session)
    const checkins = (service as unknown as { checkins: Map<string, { timer: unknown }> }).checkins
    const first = checkins.get(SID)
    expect(first).toBeDefined()
    expect(mocks.decide).not.toHaveBeenCalled()
    mocks.running.set(SID, { 'sub-session': 1 })
    await endRun(session)
    expect(checkins.get(SID)).toBe(first)
    expect((await goalOf(session))!.stalls).toBe(1)

    mocks.running.clear()
    verdictOnce({ verdict: 'met', reason: 'done' })
    await endRun(session)
    expect(mocks.decide).toHaveBeenCalledTimes(1)
    expect(checkins.has(SID)).toBe(false)
  })

  it('GV-22 not_met → 续跑：轮数 +1、记下结论、广播 judging true → false、goal-continue（resume goal、requestId 带轮数）重述目标、起下一轮', async () => {
    const { session } = await setup()
    const goal = await setAndRun(session)
    const notify = vi.spyOn(session, 'notify')
    verdictOnce({ verdict: 'not_met', reason: 'login.spec fails', next_step: 'fix the selector' })
    t.kit.queue(answer('fixing'))
    mocks.broadcast.mockClear()
    await endRun(session)
    const after = (await goalOf(session))!
    expect(after.turns).toBe(1)
    expect(after.lastVerdict).toMatchObject({
      verdict: 'not_met',
      reason: 'login.spec fails',
      nextStep: 'fix the selector'
    })
    expect(views().map((view) => view?.judging)).toEqual([true, false])
    const call = notify.mock.calls.find(([, options]) => options?.kind === 'goal-continue')!
    expect(call[1]).toEqual({
      kind: 'goal-continue',
      resume: 'goal',
      requestId: `goal:${goal.id}:continue:1`
    })
    expect(call[0]).toContain('<objective>\nMake e2e green\n</objective>')
    expect(call[0]).toContain('Not met yet. Checker: login.spec fails')
    expect(call[0]).toContain('Suggested next step: fix the selector')
    await waitFor(() => t.kit.callCount === 2, 5000, 'continuation run')
    expect(mocks.notifyGoalEnded).not.toHaveBeenCalled()
  })

  it('GV-22 结论的理由 / 下一步过长 → 截到 500 / 300 字再用', async () => {
    const { session } = await setup()
    await setAndRun(session)
    verdictOnce({ verdict: 'not_met', reason: 'r'.repeat(900), next_step: 'n'.repeat(900) })
    t.kit.queue(answer('ok'))
    await endRun(session)
    const after = (await goalOf(session))!
    expect(after.lastVerdict!.reason).toHaveLength(500)
    expect(after.lastVerdict!.reason.endsWith('…')).toBe(true)
    expect(after.lastVerdict!.nextStep).toHaveLength(300)
  })

  it.each(['met', 'impossible'] as const)(
    'GV-23 %s：终态、endedAt、写 goal-status（不起轮）、表里删掉、弹系统通知带理由；之后不再判',
    async (verdict) => {
      const { session } = await setup()
      const goal = await setAndRun(session)
      verdictOnce({ verdict, reason: 'the evidence' })
      await endRun(session)
      const after = (await goalOf(session))!
      expect(after.status).toBe(verdict)
      expect(after.endedAt).toBeDefined()
      const status = await notices(session, 'goal-status')
      expect(status).toHaveLength(1)
      expect(status[0]).toContain(`id="${goal.id}" event="${verdict}"`)
      expect(status[0]!.startsWith('shuvix.notice:')).toBe(true)
      expect(statusTable()).toEqual({})
      expect(mocks.notifyGoalEnded).toHaveBeenCalledTimes(1)
      expect(mocks.notifyGoalEnded.mock.calls[0]![1]).toContain('the evidence')
      await sleep(60)
      expect(t.kit.callCount).toBe(1)
      service.onRootRunEnded(SID, 'ok')
      await drain()
      expect(mocks.decide).toHaveBeenCalledTimes(1)
    }
  )

  it('GV-24 没有结论（null / 抛错）→ paused judge-unavailable + 系统通知；checkerMissing 只在没有 hook 绑定时为真', async () => {
    const { session } = await setup()
    await setAndRun(session)
    mocks.decide.mockResolvedValueOnce(null)
    await endRun(session)
    expect(await goalOf(session)).toMatchObject({
      status: 'paused',
      pauseReason: 'judge-unavailable'
    })
    expect(lastView()?.checkerMissing).toBe(false)
    expect(mocks.notifyGoalEnded).toHaveBeenCalledWith(SID, 'goal.pause.judge-unavailable')

    await seedGoal(session, { id: 'g_throw' })
    mocks.decide.mockRejectedValueOnce(new Error('runner exploded'))
    await endRun(session)
    expect(await goalOf(session)).toMatchObject({
      status: 'paused',
      pauseReason: 'judge-unavailable'
    })

    mocks.bound.names = new Set()
    await seedGoal(session, { id: 'g_nohook' })
    await endRun(session)
    expect(await goalOf(session)).toMatchObject({
      status: 'paused',
      pauseReason: 'judge-unavailable'
    })
    expect(lastView()?.checkerMissing).toBe(true)
    // 读口抛错：不当成「没有检查员」
    mocks.bound.throws = true
    expect((await service.get(SID))?.checkerMissing).toBe(false)
  })

  describe('GV-25 判定途中用户操作：判定的 signal 落下、迟到的结论丢掉、最后只剩用户的操作、没有续跑', () => {
    for (const action of ['pause', 'clear', 'set'] as const) {
      it(action, async () => {
        const { session } = await setup()
        await setAndRun(session)
        const pending = deferred<unknown>()
        let signal: AbortSignal | undefined
        mocks.decide.mockImplementationOnce(
          async (_id: string, _payload: unknown, opts: { signal: AbortSignal }) => {
            signal = opts.signal
            return pending.promise
          }
        )
        service.onRootRunEnded(SID, 'ok')
        await waitFor(() => signal !== undefined, 3000, 'judging')
        expect(lastView()?.judging).toBe(true)
        if (action === 'set') t.kit.queue(answer('new goal run'))
        const acting = act(
          action === 'set' ? { type: 'set', objective: 'replacement' } : { type: action }
        )
        expect(signal!.aborted).toBe(true)
        pending.resolve({ result: { verdict: 'not_met', reason: 'late' }, hook: 'goal-check' })
        expect(await acting).toEqual({ ok: true })
        await drain()
        await sleep(60)
        const goal = await goalOf(session)
        if (action === 'pause')
          expect(goal).toMatchObject({ status: 'paused', pauseReason: 'user', turns: 0 })
        if (action === 'clear') expect(goal).toBeUndefined()
        if (action === 'set')
          expect(goal).toMatchObject({ objective: 'replacement', status: 'active', turns: 0 })
        expect(await notices(session, 'goal-continue')).toEqual([])
        expect(lastView()?.judging ?? false).toBe(false)
      })
    }
  })

  it('GV-26 只改上限 / 恢复进行中的 / 校验不过的设定：不中止判定，结论照常落地', async () => {
    const { session } = await setup()
    await setAndRun(session)
    const pending = deferred<unknown>()
    let signal: AbortSignal | undefined
    mocks.decide.mockImplementationOnce(
      async (_id: string, _payload: unknown, opts: { signal: AbortSignal }) => {
        signal = opts.signal
        return pending.promise
      }
    )
    service.onRootRunEnded(SID, 'ok')
    await waitFor(() => signal !== undefined, 3000, 'judging')
    const edits = [
      act({ type: 'edit', limits: { costUsd: 9 } }),
      act({ type: 'resume' }),
      act({ type: 'set', objective: '   ' })
    ]
    expect(signal!.aborted).toBe(false)
    t.kit.queue(answer('continuing'))
    pending.resolve({ result: { verdict: 'not_met', reason: 'keep going' }, hook: 'goal-check' })
    const results = await Promise.all(edits)
    expect(results[0]).toEqual({ ok: true })
    expect(results[1]).toEqual({ ok: true })
    expect(results[2]).toMatchObject({ ok: false })
    await drain()
    const goal = (await goalOf(session))!
    expect(goal).toMatchObject({ status: 'active', turns: 1, limits: { costUsd: 9 } })
    await waitFor(() => t.kit.callCount === 2, 5000, 'continuation')
    expect(lastView()?.judging).toBe(false)
  })

  it('GV-26 改成同样的原文：中止了判定却没起轮 → 会话空闲时就地补判一次（不留下没人推的进行中目标）', async () => {
    const { session } = await setup()
    await setAndRun(session)
    const judge = pendingJudge()
    service.onRootRunEnded(SID, 'ok')
    await waitFor(() => judge.signal() !== undefined, 3000, 'judging')
    verdictOnce({ verdict: 'met', reason: 'rejudged' })
    expect(await act({ type: 'edit', objective: 'Make e2e green' })).toEqual({ ok: true })
    expect(judge.signal()!.aborted).toBe(true)
    await drain()
    expect(mocks.decide).toHaveBeenCalledTimes(2)
    expect((await goalOf(session))!.status).toBe('met')
    expect(await notices(session, 'goal-updated')).toEqual([])
  })

  it('GV-26 设定被拒、旧目标放回且是进行中：中止的判定就地补判', async () => {
    const { session } = await setup()
    await setAndRun(session)
    const judge = pendingJudge()
    service.onRootRunEnded(SID, 'ok')
    await waitFor(() => judge.signal() !== undefined, 3000, 'judging')
    admitError = 'No model'
    verdictOnce({ verdict: 'impossible', reason: 'rejudged after a failed set' })
    expect(await act({ type: 'set', objective: 'other goal' })).toEqual({
      ok: false,
      error: 'No model'
    })
    expect(judge.signal()!.aborted).toBe(true)
    await drain()
    expect(mocks.decide).toHaveBeenCalledTimes(2)
    const goal = (await goalOf(session))!
    expect(goal).toMatchObject({ objective: 'Make e2e green', status: 'impossible' })
  })

  it('GV-27 判定途中用户发消息：续跑 steer 进用户那一轮、轮数只 +1；那一轮结束再判', async () => {
    const { session, hold } = await setup()
    await setAndRun(session)
    const pending = deferred<unknown>()
    mocks.decide.mockImplementationOnce(async () => pending.promise)
    service.onRootRunEnded(SID, 'ok')
    await waitFor(() => mocks.decide.mock.calls.length === 1, 3000, 'judging')
    const held = hold()
    t.kit.queue(callTool('hold'), answer('done with both'), answer('spare'))
    const sending = session.submitUser('also update the README')
    await held.running
    pending.resolve({ result: { verdict: 'not_met', reason: 'tests fail' }, hook: 'goal-check' })
    await drain()
    held.release()
    expect(await withTimeout(sending, 5000, 'user round')).toEqual({})
    expect((await lineOf(session, 'goal-continue')).startsWith('pi.user:')).toBe(true)
    expect(await notices(session, 'goal-continue')).toHaveLength(1)
    expect((await goalOf(session))!.turns).toBe(1)
    expect(t.kit.callCount).toBeGreaterThanOrEqual(3)
    verdictOnce({ verdict: 'met', reason: 'done' })
    await endRun(session)
    expect(mocks.decide).toHaveBeenCalledTimes(2)
  })

  it('GV-28 判定途中开跑的一轮：它在结论回来之前做的工具调用，下一次判定照样看得到', async () => {
    const { session, hold } = await setup()
    await setAndRun(session)
    const pending = deferred<unknown>()
    mocks.decide.mockImplementationOnce(async () => pending.promise)
    service.onRootRunEnded(SID, 'ok')
    await waitFor(() => mocks.decide.mock.calls.length === 1, 3000, 'judging')
    // 事实收集之后、结论回来之前：用户那一轮先调了 probe（带路径）
    const held = hold()
    t.kit.queue(
      callTool('probe', { path: 'evidence.txt' }, 'call-ev'),
      callTool('hold'),
      answer('done')
    )
    const sending = session.submitUser('check the evidence')
    await held.running
    offset += 2000
    pending.resolve({ result: { verdict: 'not_met', reason: 'not yet' }, hook: 'goal-check' })
    await drain()
    held.release()
    await withTimeout(sending, 5000, 'round')
    verdictOnce({ verdict: 'met', reason: 'done' })
    await endRun(session)
    const payload = mocks.decide.mock.calls[1]![1] as GoalCheckPayload
    expect(payload.lastRun.toolCalls.map((call) => call.summary)).toContain('evidence.txt')
  })

  it('GV-30（已知未修 B-8，钉现状）合并窗口里还没送出的续跑：用户随即暂停，那一轮照样起', async () => {
    const { session } = await setup({ host: { noticeCoalesceMs: 300 } })
    await setAndRun(session)
    verdictOnce({ verdict: 'not_met', reason: 'more' })
    t.kit.queue(answer('continuation ran anyway'))
    await endRun(session)
    expect(await act({ type: 'pause' })).toEqual({ ok: true })
    await waitFor(() => t.kit.callCount === 2, 5000, 'continuation from the window')
    expect((await goalOf(session))!.status).toBe('paused')
  })
})

describe('GV-20 runFactsOf', () => {
  const at = (n: number): number => 1000 + n
  function assistantMsg(createdAt: number, content: string, blocks: unknown[] = []): ChatMessage {
    return {
      id: `a${createdAt}`,
      sessionId: 's',
      role: 'assistant',
      type: 'text',
      content,
      model: 'faux',
      createdAt,
      blocks
    } as unknown as ChatMessage
  }
  const tool = (over: Record<string, unknown>): Record<string, unknown> => ({
    type: 'tool',
    toolCallId: `c${Math.random()}`,
    toolName: 'bash',
    args: {},
    result: 'ok',
    ...over
  })

  it('只看 since 之后的助手消息；成功 / 失败的判法；写过的文件去重；落盘路径；最后一段非空正文', () => {
    const messages = [
      assistantMsg(at(0), 'before', [tool({ args: { command: 'old' } })]),
      {
        id: 'u',
        role: 'user',
        type: 'text',
        content: 'hi',
        createdAt: at(5)
      } as unknown as ChatMessage,
      assistantMsg(at(10), 'first text', [
        tool({
          args: { command: 'npm test\nsecond line' },
          details: { type: 'bash', exitCode: 0 }
        }),
        tool({ args: { command: 'npm run lint' }, details: { type: 'bash', exitCode: 2 } }),
        tool({ toolName: 'read', args: { path: 'a.ts' }, isError: true }),
        tool({ toolName: 'read', args: { path: 'b.ts' }, result: undefined }),
        tool({ toolName: 'write', args: { path: 'src/x.ts' }, details: { type: 'write' } }),
        tool({ toolName: 'edit', args: { file_path: 'src/x.ts' }, details: { type: 'edit' } }),
        tool({
          toolName: 'write',
          args: { path: 'src/y.ts' },
          details: { type: 'write' },
          isError: true
        }),
        tool({
          args: { command: 'cat big' },
          result: 'z'.repeat(2000),
          spill: { path: '/tmp/out.txt' }
        })
      ]),
      assistantMsg(at(20), '   ')
    ]
    const facts = runFactsOf(messages, at(10))
    expect(facts.toolCalls).toBe(8)
    expect(facts.toolSucceeded).toBe(4)
    expect(facts.lastRun.toolCalls.map((call) => call.outcome)).toEqual([
      'ok',
      'error',
      'error',
      'error',
      'ok',
      'ok',
      'error',
      'ok'
    ])
    expect(facts.lastRun.toolCalls[0]!.summary).toBe('npm test')
    expect(facts.lastRun.filesWritten).toEqual(['src/x.ts'])
    const big = facts.lastRun.toolCalls[7]!
    expect(big.outputPath).toBe('/tmp/out.txt')
    expect(big.outputTail!.startsWith('…')).toBe(true)
    expect(big.outputTail!.length).toBeLessThanOrEqual(1500)
    expect(facts.lastRun.assistantText).toBe('first text')
    expect(facts.lastRun.toolCalls.some((call) => call.summary === 'old')).toBe(false)
  })

  it('最多留最后 40 个工具调用；命令首行截到 200；助手正文留尾部 3000', () => {
    const blocks = Array.from({ length: 45 }, (_, n) =>
      tool({ args: { command: `cmd-${n} ${'x'.repeat(300)}` } })
    )
    const facts = runFactsOf([assistantMsg(at(1), 'y'.repeat(5000), blocks)], at(0))
    expect(facts.toolCalls).toBe(45)
    expect(facts.lastRun.toolCalls).toHaveLength(40)
    expect(facts.lastRun.toolCalls[0]!.summary.startsWith('cmd-5 ')).toBe(true)
    expect(facts.lastRun.toolCalls[0]!.summary.length).toBeLessThanOrEqual(200)
    expect(facts.lastRun.assistantText.length).toBeLessThanOrEqual(3000)
    expect(facts.lastRun.assistantText.startsWith('…')).toBe(true)
  })
})

describe('GV-21 判定的 payload', () => {
  it('目标（脱敏原文、花费取到分、时长、上限、轮数）、设定之后人写的消息（不含通知、别的会话发来的、设定那条）、上次结论、本轮事实；payload 在入口拷贝', async () => {
    const { session } = await setup()
    const goal = await setAndRun(session, `ship ${SECRET}`)
    t.kit.queue(answer('a'))
    await session.submitUser('please also keep the API stable')
    await session.notify('<background-task id="b1">done</background-task>', { resume: 'never' })
    t.kit.queue(answer('b'))
    await session.submitUser('from another session', {
      source: { kind: 'session', sessionId: 'other', title: 'Other' }
    } as never)
    await updateGoal(session.harness, (g) => ({
      ...g!,
      turns: 2,
      lastVerdict: {
        verdict: 'not_met',
        reason: 'README missing',
        nextStep: 'write it',
        at: goal.setAt
      }
    }))
    t.kit.queue(callTool('probe', { path: 'README.md' }, 'call-r'), answer('wrote README'))
    await session.submitUser('go on')
    offset = 3 * 60_000
    verdictOnce({ verdict: 'met', reason: 'ok' })
    await endRun(session)
    const payload = mocks.decide.mock.calls[0]![1] as GoalCheckPayload
    expect(mocks.decide.mock.calls[0]![0]).toBe('goal.check')
    expect(payload).toMatchObject({
      sessionId: SID,
      profileName: 'work',
      title: 'Goal session',
      goal: {
        id: goal.id,
        objective: `ship ${MASKED}`,
        turns: 2,
        costUsd: 0,
        limits: goal.limits,
        activeMinutes: 3
      },
      previousVerdict: { verdict: 'not_met', reason: 'README missing', nextStep: 'write it' }
    })
    expect(payload.userMessages.map((m) => m.text)).toEqual([
      'please also keep the API stable',
      'go on'
    ])
    expect(JSON.stringify(payload)).not.toContain(SECRET)
    expect(JSON.stringify(payload.userMessages)).not.toContain(GOAL_SET_NOTE_TEXT)
    expect(payload.lastRun.toolCalls.map((c) => c.summary)).toContain('README.md')
    expect(payload.lastRun.assistantText).toBe('wrote README')
  })

  it('人写的消息最多 10 条、每条截到 1500 字', async () => {
    const { session } = await setup()
    await setAndRun(session)
    for (let n = 0; n < 12; n++) {
      t.kit.queue(answer(`r${n}`))
      await session.submitUser(n === 11 ? 'L'.repeat(2000) : `message ${n}`)
    }
    verdictOnce({ verdict: 'met', reason: 'ok' })
    await endRun(session)
    const payload = mocks.decide.mock.calls[0]![1] as GoalCheckPayload
    expect(payload.userMessages).toHaveLength(10)
    expect(payload.userMessages[0]!.text).toBe('message 2')
    expect(payload.userMessages.at(-1)!.text).toHaveLength(1500)
  })
})

// ─────────────────────────── 14d 检查与预算 ───────────────────────────

describe('14d · check-ins and budget', () => {
  type CheckinEntry = { delayMs: number; since: number }
  const checkinsOf = (): Map<string, CheckinEntry> =>
    (service as unknown as { checkins: Map<string, CheckinEntry> }).checkins

  it('GV-31 退避：30 → 60 → 120 → 120（封顶 4 倍）；每次轮数 +1、requestId 带轮数、resume goal、waited = 等了多久', async () => {
    const { session } = await setup({ checkinFirstMs: 30 })
    const goal = await seedGoal(session)
    const notify = vi.spyOn(session, 'notify').mockResolvedValue()
    mocks.running.set(SID, { bash: 1 })
    offset = 0
    await endRun(session)
    expect(checkinsOf().get(SID)?.delayMs).toBe(30)
    const delays: number[] = []
    for (let n = 1; n <= 4; n++) {
      offset = n * 31 * 60_000
      await waitFor(
        () => notify.mock.calls.filter(([, o]) => o?.kind === 'goal-checkin').length === n,
        3000,
        `check-in ${n}`
      )
      await drain()
      delays.push(checkinsOf().get(SID)!.delayMs)
    }
    expect(delays).toEqual([60, 120, 120, 120])
    const calls = notify.mock.calls.filter(([, o]) => o?.kind === 'goal-checkin')
    expect(calls.map(([, o]) => o)).toEqual(
      [1, 2, 3, 4].map((turns) => ({
        kind: 'goal-checkin',
        resume: 'goal',
        requestId: `goal:${goal.id}:checkin:${turns}`
      }))
    )
    expect(calls[0]![0]).toMatch(/waited="31m"/)
    expect((await goalOf(session))!.turns).toBeGreaterThanOrEqual(4)
  })

  it('GV-32 检查到点时会话忙 → 按同样的间隔重起、不写；被中断 → 什么都不做、不重起', async () => {
    const { session, hold } = await setup({ checkinFirstMs: 40 })
    await seedGoal(session)
    mocks.running.set(SID, { bash: 1 })
    await endRun(session)
    const held = hold()
    t.kit.queue(callTool('hold'), answer('ok'))
    const sending = session.submitUser('busy')
    await held.running
    const notify = vi.spyOn(session, 'notify')
    await sleep(70)
    await drain()
    expect(notify).not.toHaveBeenCalled()
    expect(checkinsOf().get(SID)?.delayMs).toBe(40)
    held.release()
    await withTimeout(sending, 5000, 'round')

    vi.spyOn(session, 'isInterrupted').mockReturnValue(true)
    await sleep(70)
    await drain()
    expect(notify).not.toHaveBeenCalled()
    expect(checkinsOf().has(SID)).toBe(false)
  })

  it('GV-33 后台工作已经没了、会话却空闲（完成通知只写没起轮）：检查到点时就地判定', async () => {
    const { session } = await setup({ checkinFirstMs: 30 })
    await seedGoal(session)
    mocks.running.set(SID, { 'sub-session': 1 })
    await endRun(session)
    mocks.running.clear()
    verdictOnce({ verdict: 'met', reason: 'sub-session finished it' })
    await waitFor(() => mocks.decide.mock.calls.length === 1, 3000, 'judged at check-in')
    await drain()
    expect((await goalOf(session))!.status).toBe('met')
  })

  it('GV-34 检查时撞护栏：轮数满 → paused turns；超支 → paused budget；都弹系统通知、不写检查通知', async () => {
    const { session } = await setup({ checkinFirstMs: 30 })
    await seedGoal(session, { turns: 50 })
    mocks.running.set(SID, { bash: 1 })
    await endRun(session)
    await waitFor(async () => (await goalOf(session))?.status === 'paused', 3000, 'turns pause')
    await drain()
    expect(await goalOf(session)).toMatchObject({ pauseReason: 'turns' })
    expect(mocks.notifyGoalEnded).toHaveBeenLastCalledWith(SID, 'goal.pause.turns')

    const stamp = stampUsage(t.kit)
    stamp.queue({ input: 1, cost: 6 })
    t.kit.queue(answer('spent'))
    await session.submitUser('spend')
    await seedGoal(session, { id: 'g_b' })
    await endRun(session)
    await waitFor(async () => (await goalOf(session))?.status === 'paused', 3000, 'budget pause')
    await drain()
    expect(await goalOf(session)).toMatchObject({ pauseReason: 'budget' })
    expect(mocks.notifyGoalEnded).toHaveBeenLastCalledWith(SID, 'goal.pause.budget')
    expect(await notices(session, 'goal-checkin')).toEqual([])
  })

  it('GV-35 预算计时器：进行中的目标在根运行开始时起一个（再开始不重起）、结束时停；不是进行中的不起', async () => {
    const { session } = await setup()
    const timers = (service as unknown as { budgetTimers: Map<string, unknown> }).budgetTimers
    service.onRootRunStarted(SID)
    expect(timers.has(SID)).toBe(false)
    await seedGoal(session)
    service.onRootRunStarted(SID)
    const first = timers.get(SID)
    expect(first).toBeDefined()
    service.onRootRunStarted(SID)
    expect(timers.get(SID)).toBe(first)
    service.onRootRunEnded(SID, 'aborted')
    expect(timers.has(SID)).toBe(false)
    await drain()
    service.onRootRunStarted(SID)
    expect(timers.has(SID)).toBe(false)
  })

  it('GV-36 运行中越线：暂停 budget、<goal-budget> steer 进那一轮（不起新轮）、弹系统通知、不中止那一轮；结束时不再做什么', async () => {
    const { session, hold } = await setup({ budgetCheckMs: 15 })
    await seedGoal(session, { limits: { costUsd: 1, maxTurns: 50, stallTurns: 3 } })
    const stamp = stampUsage(t.kit)
    stamp.queue({ input: 1, cost: 2 })
    const held = hold()
    t.kit.queue(callTool('hold'), answer('wrapping up'), answer('spare'))
    const sending = session.submitUser('expensive work')
    await held.running
    service.onRootRunStarted(SID)
    await waitFor(async () => (await goalOf(session))?.status === 'paused', 3000, 'budget pause')
    await drain()
    expect(await goalOf(session)).toMatchObject({ pauseReason: 'budget' })
    expect(mocks.notifyGoalEnded).toHaveBeenCalledWith(SID, 'goal.pause.budget')
    expect(session.isBusy()).toBe(true)
    held.release()
    expect(await withTimeout(sending, 5000, 'round')).toEqual({})
    expect((await lineOf(session, 'goal-budget')).startsWith('pi.user:')).toBe(true)
    expect(await notices(session, 'goal-budget')).toHaveLength(1)
    await endRun(session)
    expect(mocks.decide).not.toHaveBeenCalled()
  })

  it('GV-37 同一个目标第二次越线（调高上限、恢复、又越线）：第二条 <goal-budget> 照样送到（B-6 修复）', async () => {
    const { session, hold } = await setup({ budgetCheckMs: 15 })
    await seedGoal(session, { limits: { costUsd: 1, maxTurns: 50, stallTurns: 3 } })
    const stamp = stampUsage(t.kit)
    for (const round of [1, 2]) {
      stamp.queue({ input: 1, cost: 2 })
      const held = hold()
      t.kit.queue(callTool('hold'), answer(`round ${round}`), answer('spare'))
      const sending = session.submitUser(`work ${round}`)
      await held.running
      service.onRootRunStarted(SID)
      await waitFor(
        async () => (await goalOf(session))?.status === 'paused',
        3000,
        `budget pause ${round}`
      )
      await drain()
      held.release()
      await withTimeout(sending, 5000, 'round')
      await waitFor(
        async () => (await notices(session, 'goal-budget')).length === round,
        5000,
        `budget notice ${round}`
      )
      await endRun(session)
      if (round === 1) {
        offset += 1000
        expect(await act({ type: 'edit', limits: { costUsd: 3 } })).toEqual({ ok: true })
        expect(await act({ type: 'resume' })).toEqual({ ok: true })
        await waitFor(() => !session.isBusy(), 5000)
      }
    }
    expect(await notices(session, 'goal-budget')).toHaveLength(2)
  })

  it('GV-38 目标的花费 = 会话增量（减基线）+ 目标期间新建的子会话；早于设定的子会话不算；读失败记一笔跳过；价格未知 = 0', async () => {
    const { session } = await setup()
    const stamp = stampUsage(t.kit)
    stamp.queue({ input: 1, cost: 10 })
    t.kit.queue(answer('spent'))
    await session.submitUser('spend')
    const goal = await seedGoal(session, { baselineCostUsd: 4 })
    // 子会话：一个早于设定、一个之后、一个读不出
    const early = await t.open('goal-c')
    const late = await t.open('goal-d')
    for (const [child, cost] of [
      [early, 1],
      [late, 0.5]
    ] as const) {
      await primeRoot(child)
      stamp.queue({ input: 1, cost })
      t.kit.queue(answer('child'))
      await child.submitUser('child work')
    }
    mocks.children.set(SID, [
      { id: 'goal-c', createdAt: goal.setAt - 1 },
      { id: 'goal-d', createdAt: goal.setAt },
      { id: 'goal-e', createdAt: goal.setAt + 1 }
    ])
    mocks.peekError.add('goal-e')
    const view = (await service.get(SID))!
    expect(view.costUsd).toBeCloseTo(6 + 0.5, 9)
    expect(mocks.warn.mock.calls.some(([message]) => message.includes('goal-e'))).toBe(true)

    // 价格未知（faux 估算的花费恒为 0）：会话花费不涨，预算不会越线
    t.kit.queue(answer('free'))
    await session.submitUser('free work')
    expect((await service.get(SID))!.costUsd).toBeCloseTo(6.5, 9)
  })
})

// ─────────────────────────── 14e 启动、fork、删除、状态表 ───────────────────────────

describe('14e · restart, fork, delete, status table', () => {
  it('GV-39 / GV-40 启动扫描：空闲的进行中 → paused restart（写通知、不弹系统通知）；被中断的不动；暂停中的不动；存储不在 / 存储里是终态 → 从表里删；表说暂停、存储说进行中 → 按存储暂停；一条失败不挡别的', async () => {
    // 进程 1：B 留下被中断的一轮
    const first = await makeHost({ noticeCoalesceMs: 20 })
    const b = await first.open('goal-b')
    await primeRoot(b)
    await seedGoalOn(b, { id: 'g_b' })
    const stall = stalled()
    first.kit.queue(stall.step)
    void b.submitUser('hello')
    await stall.reached
    for (const [id, over] of [
      ['goal-a', { id: 'g_a' }],
      [
        'goal-c',
        {
          id: 'g_c',
          status: 'paused' as const,
          pauseReason: 'user' as const,
          activeSince: undefined
        }
      ],
      ['goal-e', { id: 'g_e', status: 'met' as const, endedAt: 1 }],
      ['goal-s2', { id: 'g_s2' }]
    ] as const) {
      const session = await first.open(id)
      await seedGoalOn(session, over)
    }
    t = await first.restart({ noticeCoalesceMs: 20 })
    mocks.host.current = t.host
    service = new GoalService({ now })
    mocks.settings.set(
      GOAL_SESSIONS_SETTING,
      JSON.stringify({
        'goal-a': 'active',
        'goal-b': 'active',
        'goal-c': 'paused',
        'goal-d': 'active',
        'goal-e': 'active',
        'goal-s2': 'paused',
        'goal-child': 'active'
      })
    )
    mocks.peekError.add('goal-child')
    await service.sweepOnStartup()

    const a = (await t.host.peek('goal-a'))!
    expect(await goalOf(a)).toMatchObject({ status: 'paused', pauseReason: 'restart' })
    expect((await notices(a, 'goal-status'))[0]).toContain('reason="restart"')
    const bAfter = (await t.host.peek('goal-b'))!
    expect(bAfter.isInterrupted()).toBe(true)
    expect(await goalOf(bAfter)).toMatchObject({ status: 'active' })
    expect(await goalOf((await t.host.peek('goal-c'))!)).toMatchObject({
      status: 'paused',
      pauseReason: 'user'
    })
    // 表落后于存储（GV-40）：存储里是进行中 → 按存储暂停
    expect(await goalOf((await t.host.peek('goal-s2'))!)).toMatchObject({
      status: 'paused',
      pauseReason: 'restart'
    })
    expect(service.statuses()).toEqual({
      'goal-a': 'paused',
      'goal-b': 'active',
      'goal-c': 'paused',
      'goal-s2': 'paused',
      'goal-child': 'active'
    })
    expect(mocks.notifyGoalEnded).not.toHaveBeenCalled()
    expect(mocks.warn.mock.calls.some(([message]) => message.includes('goal-child'))).toBe(true)
  })

  it('GV-39（已知未修 A-7，钉现状）启动扫描暂停时把崩溃到重启之间的停机时间算进 activeMs', async () => {
    const { session } = await setup()
    const crashedAt = now() - 10 * 60_000
    await seedGoal(session, { activeMs: 0, activeSince: crashedAt - 60_000 })
    service = new GoalService({ now })
    await service.sweepOnStartup()
    const goal = (await goalOf(session))!
    expect(goal).toMatchObject({ status: 'paused', pauseReason: 'restart' })
    // 11 分钟（含 10 分钟停机），不是崩溃前的 1 分钟
    expect(goal.activeMs).toBeGreaterThanOrEqual(11 * 60_000 - 1000)
  })

  it('GV-41 判定途中退出：dispose 中止判定；存储里仍是进行中 → 下次启动暂停 restart', async () => {
    const { session } = await setup()
    await setAndRun(session)
    let signal: AbortSignal | undefined
    const pending = deferred<unknown>()
    mocks.decide.mockImplementationOnce(
      async (_id: string, _payload: unknown, opts: { signal: AbortSignal }) => {
        signal = opts.signal
        return pending.promise
      }
    )
    service.onRootRunEnded(SID, 'ok')
    await waitFor(() => signal !== undefined, 3000, 'judging')
    service.dispose()
    expect(signal!.aborted).toBe(true)
    pending.resolve({ result: { verdict: 'met', reason: 'late' }, hook: 'goal-check' })
    await drain()
    expect((await goalOf(session))!.status).toBe('active')
    service = new GoalService({ now })
    await service.sweepOnStartup()
    expect(await goalOf(session)).toMatchObject({ status: 'paused', pauseReason: 'restart' })
  })

  it('GV-42 fork：源会话有进行中 / 暂停中的目标 → fork 在表里记 paused；源会话没有（或已结束）→ 不记', async () => {
    await setup()
    mocks.settings.set(
      GOAL_SESSIONS_SETTING,
      JSON.stringify({ 'src-active': 'active', 'src-paused': 'paused' })
    )
    service.noteForked('src-active', 'fork-1')
    service.noteForked('src-paused', 'fork-2')
    service.noteForked('src-none', 'fork-3')
    expect(service.statuses()).toEqual({
      'src-active': 'active',
      'src-paused': 'paused',
      'fork-1': 'paused',
      'fork-2': 'paused'
    })
  })

  // GV-43 fork 之后在 fork 里恢复，花费按拷过来的用量与基线算（3 + 1，不归零、不为负）：要真 fork 存储 + 计价 faux，未写
  it.todo('GV-43 fork 里恢复之后的目标花费 = 拷过来的用量 − 基线 + fork 自己的花费')
  // GV-45 回退 / 销毁运行时对目标的影响等裁决（A-4）：回退在跑时 → aborted → paused stopped；空闲时回退会设「喊停」；
  // agent:destroy 途中可能没有 agent_end → 目标留在进行中。裁决之前不钉
  it.todo('GV-45 回退 / 销毁运行时与进行中的目标（等 A-4 裁决）')

  it('GV-44 删除：表里删掉、在途判定中止、检查与预算计时器停掉（之后再没有回调）', async () => {
    const { session } = await setup({ checkinFirstMs: 30, budgetCheckMs: 15 })
    await seedGoal(session)
    mocks.running.set(SID, { bash: 1 })
    await endRun(session)
    service.onRootRunStarted(SID)
    let signal: AbortSignal | undefined
    mocks.decide.mockImplementationOnce(
      async (_id: string, _payload: unknown, opts: { signal: AbortSignal }) => {
        signal = opts.signal
        return new Promise(() => {})
      }
    )
    mocks.running.clear()
    // 检查到点时没有后台工作 → 就地判定（挂起）
    await waitFor(() => signal !== undefined, 3000, 'judging from the check-in')
    const internals = service as unknown as {
      checkins: Map<string, unknown>
      budgetTimers: Map<string, unknown>
      judging: Map<string, unknown>
    }
    service.forget(SID)
    expect(signal!.aborted).toBe(true)
    expect(internals.checkins.has(SID)).toBe(false)
    expect(internals.budgetTimers.has(SID)).toBe(false)
    expect(internals.judging.has(SID)).toBe(false)
    expect(service.statuses()).toEqual({})
    const notify = vi.spyOn(session, 'notify')
    await sleep(80)
    expect(notify).not.toHaveBeenCalled()
  })

  it('GV-46 状态表：只记 active / paused；坏 JSON → {}；认不出的值丢掉；isActive 只对 active；只在真变了时写一次', async () => {
    const { session } = await setup()
    mocks.settings.set(GOAL_SESSIONS_SETTING, '{not json')
    expect(service.statuses()).toEqual({})
    service = new GoalService({ now })
    mocks.settings.set(GOAL_SESSIONS_SETTING, JSON.stringify({ x: 'met', y: 'paused', z: 7 }))
    expect(service.statuses()).toEqual({ y: 'paused' })
    expect(service.isActive('y')).toBe(false)

    service = new GoalService({ now })
    mocks.settings.clear()
    mocks.settingsSet.mockClear()
    await setAndRun(session)
    expect(service.isActive(SID)).toBe(true)
    const writes = (): string[] => mocks.settingsSet.mock.calls.map(([, value]) => value)
    expect(writes()).toEqual([JSON.stringify({ [SID]: 'active' })])
    await act({ type: 'edit', limits: { costUsd: 9 } })
    expect(writes()).toHaveLength(1)
    await act({ type: 'pause' })
    expect(writes().at(-1)).toBe(JSON.stringify({ [SID]: 'paused' }))
    expect(service.isActive(SID)).toBe(false)
    await act({ type: 'clear' })
    expect(writes().at(-1)).toBe(JSON.stringify({}))
    expect(writes()).toHaveLength(3)
  })
})

/** 不经 setup 的会话上直接写目标（启动扫描的用例：上个进程写下的） */
async function seedGoalOn(session: DurableSession, over: Partial<GoalRecord> = {}): Promise<void> {
  const base: GoalRecord = {
    id: 'g_seed',
    objective: 'Seeded goal',
    status: 'active',
    setAt: now(),
    limits: { costUsd: 5, maxTurns: 50, stallTurns: 3 },
    baselineCostUsd: 0,
    turns: 0,
    stalls: 0,
    activeMs: 0,
    activeSince: now()
  }
  const goal = { ...base, ...over }
  for (const key of Object.keys(goal) as Array<keyof GoalRecord>) {
    if (goal[key] === undefined) delete goal[key]
  }
  await updateGoal(session.harness, () => goal)
}
