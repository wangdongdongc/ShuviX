/**
 * 定时运行里的询问（2026-11-02，根 CLAUDE.md「Tool execution flow」、手册 bot-md）：询问一直等人，所以一次运行可以
 * 停在询问上很久 —— `agent.prompt` 不交回，同一条绑定后面的触发都被跳过，等有人回来答了才算跑成。
 *
 *   BT-17 prompt 跨三次触发还没交回：一条 started（没有 finish）、两条 skipped（sessionId ''）、只建一条会话、不记
 *         lastFired；交回之后 completed，lastFired 是第一次触发的 firedAt（不是第三次的）；第四次的围栏带上它
 *   BT-18 prompt 交回 {error, code:'closed'}（等询问时会话被关了）：failed，lastFired 不动，在跑标记释放，下一次照跑
 *   BT-INT-1 真宿主 + 真 AgentSession + 真 ask 工具：触发之后询问挂着，模型恰被调一次（旧的结局是当场 `Aborted`，紧接着
 *         第二次调用）；下一次触发记 skipped；答了之后第二次调用里没有 `Aborted`，completed，lastFired 记下
 *   BT-INT-2 同样的布置，等询问时 host.close：failed，lastFired 不动，在跑标记释放
 *
 * botTriggerService.test.ts 另有 mock 面相同的那一大组（BTL / BTS / BST）。这里的 mock 面：botService、projectService、
 * sessionService（create / ensureAgentSession）、settingsService（内存表）、dailyNotes、trackingNotes、triggerLogService；
 * BT-INT 再加 AgentSession 的外围（hook 埋点、日历、记录），宿主与门面是真的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { createAskTool, type BotBinding, type SessionHost } from '@shuvix/agent-runtime'
import type { BotEntry } from '../botService'

const mocks = vi.hoisted(() => ({
  listAll: vi.fn<() => unknown[]>(),
  create: vi.fn<(input: Record<string, unknown>) => { id: string }>(),
  ensure: vi.fn<(id: string) => Promise<unknown>>(),
  commit: vi.fn<(message: string) => Promise<void>>(),
  record: vi.fn<(input: Record<string, unknown>) => string | null>(),
  finish: vi.fn<(id: string | null, outcome: string, error?: string) => void>(),
  settings: new Map<string, string>()
}))

vi.mock('../botService', () => ({ botService: { listAll: mocks.listAll } }))
vi.mock('../projectService', () => ({ projectService: { projectsNamed: () => [] } }))
vi.mock('../sessionService', () => ({
  sessionService: {
    create: mocks.create,
    ensureAgentSession: mocks.ensure,
    resolveRunConfig: async () => undefined,
    resolveAgentProfileName: () => 'bot'
  }
}))
vi.mock('../settingsService', () => ({
  settingsService: {
    get: (key: string) => mocks.settings.get(key),
    set: (key: string, value: string) => void mocks.settings.set(key, value)
  }
}))
vi.mock('../dailyNotes', () => ({ ensureDailyDir: () => undefined }))
vi.mock('../trackingNotes', () => ({
  commitTrackingChanges: mocks.commit,
  ensureTrackingDir: () => undefined
}))
vi.mock('../triggerLogService', () => ({
  triggerLogService: { record: mocks.record, finish: mocks.finish }
}))
// 真 AgentSession 的外围（与 agentSessionFacade.test 同一组）
vi.mock('../sessionHost', async () =>
  (await import('./support/fakeSessionHost')).sessionHostModuleMock()
)
vi.mock('../hookService', () => ({
  hookTriggers: { fire: () => undefined },
  hookService: { abortSessionRuns: () => undefined }
}))
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: async () => null,
  isDefaultTitle: () => false
}))
vi.mock('../sessionDayPromptService', () => ({ recordUserEntry: () => undefined }))
vi.mock('../sessionRecords', () => ({
  sessionRecords: { pick: () => ({ title: 'Asker' }), drivingSourceOf: () => undefined }
}))
vi.mock('../../utils/toolUtils/fileTime', () => ({ clearSession: () => undefined }))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: () => undefined }
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { AgentSession } from '../agentSession'
import { BotTriggerService, LAST_FIRED_KEY, bindingKey, localIso } from '../botTriggerService'
import { timerPayloadAt } from '../triggerTimer'
import {
  answer,
  callTool,
  fauxKit,
  makeRealHost,
  requestTexts,
  toolsToolHost,
  waitFor,
  withTimeout,
  type FauxKit
} from './support/realHost'

const BINDING: BotBinding = { trigger: 'timer.fired', message: 'Asker check-in.' }
const ENTRY: BotEntry = {
  file: {
    name: 'asker',
    objectId: 'bot:asker',
    displayName: 'Asker',
    description: '',
    body: '',
    bindings: [BINDING]
  },
  basePath: '/bots/asker.md'
}
const KEY = bindingKey(ENTRY, 0, 'timer.fired')

const minute = (m: number): ReturnType<typeof timerPayloadAt> =>
  timerPayloadAt(new Date(2026, 10, 2, 18, m))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** 等派发里的 await 链走完 */
const settle = (): Promise<void> => sleep(0)

const lastFired = (): Record<string, string> | undefined => {
  const raw = mocks.settings.get(LAST_FIRED_KEY)
  return raw === undefined ? undefined : (JSON.parse(raw) as Record<string, string>)
}
const outcomes = (): string[] =>
  mocks.record.mock.calls.map(([input]) => String((input as { outcome: string }).outcome))

let svc: BotTriggerService

beforeEach(() => {
  mocks.settings.clear()
  for (const m of [
    mocks.listAll,
    mocks.create,
    mocks.ensure,
    mocks.commit,
    mocks.record,
    mocks.finish
  ]) {
    m.mockReset()
  }
  let logSeq = 0
  let sessionSeq = 0
  mocks.listAll.mockReturnValue([ENTRY])
  mocks.record.mockImplementation(() => `log-${++logSeq}`)
  mocks.create.mockImplementation(() => ({ id: `s-${++sessionSeq}` }))
  mocks.commit.mockResolvedValue(undefined)
  svc = new BotTriggerService()
})

describe('运行停在询问上（prompt 是桩）', () => {
  const prompt = vi.fn<(...args: unknown[]) => Promise<{ error?: string; code?: string }>>()
  const maskTexts = async (texts: readonly string[]): Promise<string[]> => [...texts]

  beforeEach(() => {
    prompt.mockReset()
    mocks.ensure.mockImplementation(async () => ({ prompt, maskTexts }))
  })

  it('BT-17 跨三次触发：一条 started、两条 skipped、一条会话、不记 lastFired；交回后记第一次的 firedAt，第四次的围栏带上它', async () => {
    let finishRun!: (result: { error?: string }) => void
    prompt.mockImplementationOnce(
      () => new Promise<{ error?: string }>((resolve) => (finishRun = resolve))
    )
    prompt.mockResolvedValue({})

    const first = minute(0)
    svc.fire('timer.fired', first)
    await settle()
    svc.fire('timer.fired', minute(1))
    await settle()
    const third = minute(2)
    svc.fire('timer.fired', third)
    await settle()

    expect(outcomes()).toEqual(['started', 'skipped', 'skipped'])
    expect(mocks.record.mock.calls[0]![0]).toMatchObject({ outcome: 'started', sessionId: 's-1' })
    for (const call of mocks.record.mock.calls.slice(1)) {
      expect(call[0]).toMatchObject({ outcome: 'skipped', sessionId: '', error: '' })
    }
    expect(mocks.finish).not.toHaveBeenCalled()
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(lastFired()).toBeUndefined()
    expect(svc.isRunning(KEY)).toBe(true)

    finishRun({})
    await settle()
    expect(mocks.finish.mock.calls).toEqual([['log-1', 'completed']])
    expect(lastFired()).toStrictEqual({ [KEY]: first.firedAt })
    expect(lastFired()![KEY]).not.toBe(third.firedAt)
    expect(svc.isRunning(KEY)).toBe(false)

    svc.fire('timer.fired', minute(3))
    await settle()
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(prompt.mock.calls[1]![0]).toContain(`lastFiredAt: ${localIso(new Date(first.firedAt))}`)
    expect(outcomes()).toEqual(['started', 'skipped', 'skipped', 'started'])
  })

  it("BT-18 prompt 交回 {error, code:'closed'}：failed、lastFired 不动、在跑标记释放，下一次照跑", async () => {
    prompt.mockResolvedValueOnce({ error: 'Session s-1 is closed', code: 'closed' })
    prompt.mockResolvedValue({})

    svc.fire('timer.fired', minute(0))
    await settle()
    expect(mocks.finish.mock.calls).toEqual([['log-1', 'failed', 'Session s-1 is closed']])
    expect(lastFired()).toBeUndefined()
    expect(svc.isRunning(KEY)).toBe(false)

    const next = minute(1)
    svc.fire('timer.fired', next)
    await settle()
    expect(outcomes()).toEqual(['started', 'started'])
    expect(prompt).toHaveBeenCalledTimes(2)
    // 上一次没跑成：这一次的围栏没有 lastFiredAt
    expect(prompt.mock.calls[1]![0]).not.toContain('lastFiredAt')
    expect(lastFired()).toStrictEqual({ [KEY]: next.firedAt })
  })
})

describe('BT-INT 真宿主 + 真 AgentSession + 真 ask', () => {
  const ASK_ARGS = {
    question: 'Which one?',
    options: [
      { label: 'A', description: 'first' },
      { label: 'B', description: 'second' }
    ]
  }
  let host: SessionHost
  let kit: FauxKit

  beforeEach(() => {
    kit = fauxKit()
    kit.queue(callTool('ask', ASK_ARGS, 'c-ask'), answer('run finished'))
    const storages = new Map<string, MemoryStorage>()
    ;({ host } = makeRealHost({
      kit,
      isEphemeral: () => true,
      storage: {
        openStorage: async (sessionId) => {
          let storage = storages.get(sessionId)
          if (storage === undefined) {
            storage = new MemoryStorage()
            storages.set(sessionId, storage)
          }
          return storage
        },
        storageExists: (sessionId) => storages.has(sessionId),
        deleteStorage: async (sessionId) => void storages.delete(sessionId)
      },
      toolHost: toolsToolHost((sessionId) => [
        createAskTool({
          requestUserInput: (request) => host.get(sessionId)!.requestUserInput(request)
        })
      ])
    }))
    mocks.ensure.mockImplementation(async (id) => AgentSession.of(await host.open(id)))
  })

  afterEach(async () => {
    await withTimeout(host.closeAll(), 10000, 'closeAll')
  })

  /** 触发一次，等询问挂上 */
  async function fireUntilAsked(): Promise<AgentSession> {
    svc.fire('timer.fired', minute(0))
    await waitFor(() => host.get('s-1')?.pendingInputCount === 1, 5000, 'the ask is pending')
    return AgentSession.of(host.get('s-1')!)
  }

  it('BT-INT-1 询问挂着、模型只调了一次；下一次触发 skipped；答了之后第二次调用没有 Aborted，completed，lastFired 记下', async () => {
    const agent = await fireUntilAsked()
    await sleep(200)
    expect(agent.pendingInputCount).toBe(1)
    expect(kit.callCount).toBe(1)
    expect(mocks.finish).not.toHaveBeenCalled()
    expect(lastFired()).toBeUndefined()

    svc.fire('timer.fired', minute(1))
    await settle()
    expect(outcomes()).toEqual(['started', 'skipped'])
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(kit.callCount).toBe(1)

    expect(agent.respondToInput('c-ask', { kind: 'choice', selections: ['A'] })).toBe(true)
    await waitFor(() => mocks.finish.mock.calls.length === 1, 5000, 'the run finished')
    expect(mocks.finish.mock.calls).toEqual([['log-1', 'completed']])
    expect(kit.callCount).toBe(2)
    const second = requestTexts(kit, 1).join('\n')
    expect(second).toContain('User selected: A')
    expect(second).not.toContain('Aborted')
    expect(lastFired()).toStrictEqual({ [KEY]: minute(0).firedAt })
    expect(svc.isRunning(KEY)).toBe(false)
  }, 20000)

  it('BT-INT-2 等询问时 host.close：failed，lastFired 不动，在跑标记释放', async () => {
    await fireUntilAsked()
    await withTimeout(host.close('s-1'), 10000, 'close')
    await waitFor(() => mocks.finish.mock.calls.length === 1, 5000, 'the run settled')
    expect(mocks.finish.mock.calls[0]!.slice(0, 2)).toEqual(['log-1', 'failed'])
    expect(lastFired()).toBeUndefined()
    await waitFor(() => !svc.isRunning(KEY), 2000, 'in-flight cleared')
    expect(kit.callCount).toBe(1)
  }, 20000)
})
