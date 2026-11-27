/**
 * 定时运行里的询问（docs/unattended-run-design.md；根 CLAUDE.md「Tool execution flow」、手册 bot-md）：触发器开出来的
 * 那一轮是无人值守的 —— 本来要交给人的询问不挂起，当场以工具结果告诉模型，运行接着跑完。运行仍然可以很长
 * （`agent.prompt` 不交回），那时同一条绑定后面的触发照旧被跳过；有人接手（「我在这儿」/ 发来一条消息）之后，询问又
 * 照常等人。
 *
 *   BT-17 prompt 跨三次触发还没交回：一条 started（没有 finish）、两条 skipped（sessionId ''）、只建一条会话、不记
 *         lastFired；交回之后 completed，lastFired 是第一次触发的 firedAt（不是第三次的）；第四次的围栏带上它
 *   BT-18 prompt 交回 {error, code:'closed'}（运行途中会话被关了）：failed，lastFired 不动，在跑标记释放，下一次照跑
 *   BTL-13 prompt 交回 {cutShort}（aborted / reset / stale）：stopped 且没有 error，lastFired 停在上一次跑成的时刻，下一次
 *         的围栏带上它，在跑标记释放；{error, cutShort} 算 failed
 *   BT-INT-1′ 真宿主 + 真 AgentSession + 真 ask 工具：触发之后询问从不挂起，模型被调两次，第二次请求里是「没人在场」
 *         那句（不是 `Aborted`、不是 `User selected`），ask 的结果不是错误；completed，lastFired 记下
 *   BT-INT-1b 紧接着的下一次触发照跑（不是 skipped），围栏带上一次的 lastFiredAt
 *   BT-INT-1c 要批准的一步（真 executeDecision，ask 档）：当场被拒，结果是错误行，文案是「没人能批」那句；completed
 *   BT-INT-1d 运行结束后运行时的标记还在（自动续跑的那一轮沿用它）；`unattended:true` 只广播过一次
 *   BT-INT-2′ 停在一个慢工具里时 host.close：failed，lastFired 不动，在跑标记释放
 *   BT-INT-3′ 停在慢工具里时 AgentSession.abort：stopped，lastFired 不动，下一次触发的围栏没有 lastFiredAt
 *   BT-INT-4′ 同样的布置，rollbackTo：同样是 stopped
 *   BT-INT-5 停在慢工具里时 attend()：之后的 ask 照常挂起（期间的触发 skipped），答了才 completed
 *   BT-INT-6 停在慢工具里时人插了一句话：之后要批准的一步出卡片，允许后工具照跑
 *   BT-INT-7 运行结束后后台通知自动续跑：那一轮沿用无人值守，ask 当场落定，没有卡片
 *
 * botTriggerService.test.ts 另有 mock 面相同的那一大组（BTL / BTS / BST）。这里的 mock 面：botService、projectService、
 * sessionService（create / ensureAgentSession）、settingsService（内存表）、dailyNotes、trackingNotes、triggerLogService；
 * BT-INT 再加 AgentSession 的外围（hook 埋点、日历、记录），宿主与门面是真的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { obj } from '@earendil-works/pi-schema'
import { MemoryStorage, defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import {
  createAskTool,
  executeDecision,
  type BotBinding,
  type SessionHost
} from '@shuvix/agent-runtime'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import {
  UNATTENDED_QUESTION_TEXT,
  isUnattendedResult,
  unattendedApprovalText
} from '@shuvix/chat-protocol/unattended'
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
  allEntries,
  answer,
  callTool,
  fauxKit,
  makeRealHost,
  requestTexts,
  toolsToolHost,
  waitFor,
  withTimeout,
  type FauxKit,
  type RecordingSink
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
  const prompt =
    vi.fn<(...args: unknown[]) => Promise<{ error?: string; code?: string; cutShort?: string }>>()
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

  it.each(['aborted', 'reset', 'stale'])(
    'BTL-13 prompt 交回 {cutShort:%s}：stopped 且没有 error、lastFired 停在上一次跑成的时刻、下一次的围栏带上它、在跑标记释放',
    async (cutShort) => {
      prompt.mockResolvedValueOnce({})
      prompt.mockResolvedValueOnce({ cutShort })
      prompt.mockResolvedValue({})

      const ran = minute(0)
      svc.fire('timer.fired', ran)
      await settle()
      expect(lastFired()).toStrictEqual({ [KEY]: ran.firedAt })

      svc.fire('timer.fired', minute(1))
      await settle()
      expect(mocks.finish.mock.calls).toEqual([
        ['log-1', 'completed'],
        ['log-2', 'stopped']
      ])
      expect(lastFired()).toStrictEqual({ [KEY]: ran.firedAt })
      expect(svc.isRunning(KEY)).toBe(false)

      svc.fire('timer.fired', minute(2))
      await settle()
      expect(outcomes()).toEqual(['started', 'started', 'started'])
      expect(prompt).toHaveBeenCalledTimes(3)
      expect(prompt.mock.calls[2]![0]).toContain(`lastFiredAt: ${localIso(new Date(ran.firedAt))}`)
    }
  )

  it('BTL-13 {error, cutShort} 算 failed（error 优先）：lastFired 不动', async () => {
    prompt.mockResolvedValueOnce({ error: 'model refused', cutShort: 'aborted' })
    svc.fire('timer.fired', minute(0))
    await settle()
    expect(mocks.finish.mock.calls).toEqual([['log-1', 'failed', 'model refused']])
    expect(lastFired()).toBeUndefined()
    expect(svc.isRunning(KEY)).toBe(false)
  })
})

describe('BT-INT 真宿主 + 真 AgentSession + 真 ask（无人值守的运行）', () => {
  const ASK_ARGS = {
    question: 'Which one?',
    options: [
      { label: 'A', description: 'first' },
      { label: 'B', description: 'second' }
    ]
  }
  const APPROVAL_COMMAND = 'Read(/outside/secret.txt)'
  let host: SessionHost
  let kit: FauxKit
  let sink: RecordingSink
  /** `gate` 工具停在这里，用例放行（「停在询问上」的替身：运行还在跑，却不是在等人） */
  let releaseGate: () => void
  let gateReached: boolean
  /** `needs_approval` 真的执行了几次（被拒 = 0） */
  let approvedRuns: number
  /** 运行途中见过的挂起询问数的最大值 */
  let maxPending: number
  let sampler: ReturnType<typeof setInterval> | undefined

  const gateTool = (): ToolRegistration =>
    defineTool({
      name: 'gate',
      description: 'gate: a slow step',
      parameters: obj({}),
      replay: 'unsafe',
      execute: async (_args, _api, context) => {
        gateReached = true
        await new Promise<void>((resolve) => {
          releaseGate = resolve
          context.abortSignal?.addEventListener('abort', () => resolve())
        })
        return { output: [{ type: 'text', text: 'gate passed' }] }
      }
    })

  /** 一步要用户批准的操作：真的 executeDecision（ask 档、没有审查员），询问通道是这条会话自己的 */
  const approvalTool = (sessionId: string): ToolRegistration =>
    defineTool({
      name: 'needs_approval',
      description: 'needs_approval: an operation a policy asks about',
      parameters: obj({}),
      replay: 'unsafe',
      execute: async (_args, api) => {
        await executeDecision({
          provider: {
            host: 'desktop',
            pathSep: '/',
            getVars: () => ({}),
            requestUserInput: (request) => host.get(sessionId)!.requestUserInput(request)
          },
          request: {
            subject: { kind: 'agent', sessionId, agentKind: 'root' },
            action: 'read',
            object: { type: 'path', path: '/outside/secret.txt' },
            environment: { host: 'desktop' }
          },
          decision: {
            effect: 'ask',
            matched: ['a1'],
            winning: 'a1',
            ask: { command: APPROVAL_COMMAND, rememberEntry: APPROVAL_COMMAND }
          },
          opts: { toolCallId: api.callId, toolName: 'needs_approval' },
          evaluateMs: 0
        })
        approvedRuns++
        return { output: [{ type: 'text', text: 'approved step ran' }] }
      }
    })

  beforeEach(() => {
    kit = fauxKit()
    gateReached = false
    approvedRuns = 0
    maxPending = 0
    releaseGate = () => undefined
    const storages = new Map<string, MemoryStorage>()
    ;({ host, sink } = makeRealHost({
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
        }),
        gateTool(),
        approvalTool(sessionId)
      ])
    }))
    mocks.ensure.mockImplementation(async (id) => AgentSession.of(await host.open(id)))
    sampler = setInterval(() => {
      maxPending = Math.max(maxPending, host.get('s-1')?.pendingInputCount ?? 0)
    }, 1)
  })

  afterEach(async () => {
    clearInterval(sampler)
    releaseGate()
    await withTimeout(host.closeAll(), 10000, 'closeAll')
  })

  const unattendedEvents = (sessionId: string): boolean[] =>
    sink.events
      .filter(
        (event): event is Extract<ChatEvent, { type: 'unattended' }> =>
          event.type === 'unattended' && event.sessionId === sessionId
      )
      .map((event) => event.unattended)

  /** 触发一次并等这一轮落定 */
  async function fireAndFinish(payload = minute(0), finished = 1): Promise<void> {
    svc.fire('timer.fired', payload)
    await waitFor(() => mocks.finish.mock.calls.length === finished, 5000, 'the run finished')
  }

  /** 触发一次，等运行停进 `gate` 工具 */
  async function fireUntilGated(): Promise<AgentSession> {
    svc.fire('timer.fired', minute(0))
    await waitFor(() => gateReached, 5000, 'the run is parked in the gate tool')
    return AgentSession.of(host.get('s-1')!)
  }

  it('BT-INT-1′ ask 从不挂起：模型被调两次，第二次请求里是「没人在场」那句，结果不是错误；completed，lastFired 记下', async () => {
    kit.queue(callTool('ask', ASK_ARGS, 'c-ask'), answer('run finished'))
    await fireAndFinish()

    expect(maxPending).toBe(0)
    expect(host.get('s-1')!.pendingInputCount).toBe(0)
    expect(kit.callCount).toBe(2)
    const second = requestTexts(kit, 1).join('\n')
    expect(second).toContain(UNATTENDED_QUESTION_TEXT)
    expect(second).not.toContain('Aborted')
    expect(second).not.toContain('User selected')
    const results = kit.requests[1]!.messages.filter((message) => message.role === 'toolResult')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolCallId: 'c-ask', isError: false })
    expect(mocks.finish.mock.calls).toEqual([['log-1', 'completed']])
    expect(lastFired()).toStrictEqual({ [KEY]: minute(0).firedAt })
    expect(svc.isRunning(KEY)).toBe(false)
  }, 20000)

  it('BT-INT-1b 紧接着的下一次触发照跑（不是 skipped）：第二条会话，围栏带上一次的 lastFiredAt', async () => {
    kit.queue(callTool('ask', ASK_ARGS, 'c-ask'), answer('run finished'), answer('second run'))
    const first = minute(0)
    await fireAndFinish(first)
    await fireAndFinish(minute(1), 2)

    expect(outcomes()).toEqual(['started', 'started'])
    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(mocks.finish.mock.calls).toEqual([
      ['log-1', 'completed'],
      ['log-2', 'completed']
    ])
    const fence = requestTexts(kit, 2).join('\n')
    expect(fence).toContain('<trigger_event')
    expect(fence).toContain(`lastFiredAt: ${localIso(new Date(first.firedAt))}`)
  }, 20000)

  it('BT-INT-1c 要批准的一步当场被拒：错误行、文案是「没人能批」那句、工具没执行；completed，lastFired 记下', async () => {
    kit.queue(callTool('needs_approval', {}, 'c-appr'), answer('skipped it'))
    await fireAndFinish()

    expect(maxPending).toBe(0)
    expect(approvedRuns).toBe(0)
    expect(kit.callCount).toBe(2)
    const refusal = unattendedApprovalText(APPROVAL_COMMAND)
    expect(isUnattendedResult(refusal)).toBe(true)
    expect(requestTexts(kit, 1).join('\n')).toContain(refusal)
    const results = kit.requests[1]!.messages.filter((message) => message.role === 'toolResult')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolCallId: 'c-appr', isError: true })
    expect(mocks.finish.mock.calls).toEqual([['log-1', 'completed']])
    expect(lastFired()).toStrictEqual({ [KEY]: minute(0).firedAt })
  }, 20000)

  it('BT-INT-1d 运行结束后运行时的标记还在；unattended:true 只广播过一次', async () => {
    kit.queue(callTool('ask', ASK_ARGS, 'c-ask'), answer('run finished'))
    await fireAndFinish()

    expect(host.get('s-1')!.unattended).toBe(true)
    expect(AgentSession.of(host.get('s-1')!).unattended).toBe(true)
    expect(unattendedEvents('s-1')).toEqual([true])
  }, 20000)

  it('BT-INT-2′ 停在慢工具里时 host.close：failed，lastFired 不动，在跑标记释放', async () => {
    kit.queue(callTool('gate', {}, 'c-gate'), answer('never'))
    await fireUntilGated()
    await withTimeout(host.close('s-1'), 10000, 'close')
    await waitFor(() => mocks.finish.mock.calls.length === 1, 5000, 'the run settled')
    expect(mocks.finish.mock.calls[0]!.slice(0, 2)).toEqual(['log-1', 'failed'])
    expect(lastFired()).toBeUndefined()
    await waitFor(() => !svc.isRunning(KEY), 2000, 'in-flight cleared')
    expect(kit.callCount).toBe(1)
    // 关掉的会话没有哪一轮在跑：界面上的标记跟着收掉
    expect(unattendedEvents('s-1')).toEqual([true, false])
  }, 20000)

  /** 这一轮被截断之后：stopped、lastFired 不动、在跑标记释放，下一次触发开一条新运行，围栏没有 lastFiredAt */
  async function expectStoppedThenNextRunIsFresh(): Promise<void> {
    await waitFor(() => mocks.finish.mock.calls.length === 1, 5000, 'the run settled')
    expect(mocks.finish.mock.calls).toEqual([['log-1', 'stopped']])
    expect(lastFired()).toBeUndefined()
    await waitFor(() => !svc.isRunning(KEY), 2000, 'in-flight cleared')
    expect(kit.callCount).toBe(1)

    const next = minute(5)
    svc.fire('timer.fired', next)
    await waitFor(() => mocks.finish.mock.calls.length === 2, 5000, 'the next run settled')
    expect(outcomes()).toEqual(['started', 'started'])
    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(kit.callCount).toBe(2)
    const fence = requestTexts(kit, 1).join('\n')
    expect(fence).toContain('<trigger_event')
    expect(fence).not.toContain('lastFiredAt')
    expect(mocks.finish.mock.calls[1]).toEqual(['log-2', 'completed'])
    expect(lastFired()).toStrictEqual({ [KEY]: next.firedAt })
  }

  it('BT-INT-3′ 停在慢工具里时 AgentSession.abort：stopped，lastFired 不动，下一次的围栏没有 lastFiredAt', async () => {
    kit.queue(callTool('gate', {}, 'c-gate'), answer('next run'))
    const agent = await fireUntilGated()
    await withTimeout(agent.abort(), 5000, 'abort')
    expect(host.get('s-1')!.pendingInputCount).toBe(0)
    await expectStoppedThenNextRunIsFresh()
  }, 20000)

  it('BT-INT-4′ 停在慢工具里时 rollbackTo：stopped，lastFired 不动，下一次的围栏没有 lastFiredAt', async () => {
    kit.queue(callTool('gate', {}, 'c-gate'), answer('next run'))
    await fireUntilGated()
    const session = host.get('s-1')!
    const entries = await allEntries(await session.currentConversation())
    const userEntry = entries.find((entry) => entry.kind === 'pi.user')!
    const rolled = await withTimeout(session.rollbackTo(userEntry.id), 5000, 'rollbackTo')
    expect(rolled.ok).toBe(true)
    expect(session.pendingInputCount).toBe(0)
    await expectStoppedThenNextRunIsFresh()
  }, 20000)

  it('BT-INT-5 attend() 之后的 ask 照常挂起：期间的触发 skipped，答了才 completed', async () => {
    kit.queue(
      callTool('gate', {}, 'c-gate'),
      callTool('ask', ASK_ARGS, 'c-ask'),
      answer('run finished')
    )
    const agent = await fireUntilGated()
    expect(agent.unattended).toBe(true)
    agent.attend()
    expect(agent.unattended).toBe(false)
    releaseGate()
    await waitFor(() => agent.pendingInputCount === 1, 5000, 'the ask is pending')
    await sleep(100)
    expect(agent.pendingInputCount).toBe(1)
    expect(kit.callCount).toBe(2)
    expect(mocks.finish).not.toHaveBeenCalled()

    svc.fire('timer.fired', minute(1))
    await settle()
    expect(outcomes()).toEqual(['started', 'skipped'])
    expect(mocks.create).toHaveBeenCalledTimes(1)

    expect(agent.respondToInput('c-ask', { kind: 'choice', selections: ['A'] })).toBe(true)
    await waitFor(() => mocks.finish.mock.calls.length === 1, 5000, 'the run finished')
    expect(mocks.finish.mock.calls).toEqual([['log-1', 'completed']])
    const third = requestTexts(kit, 2).join('\n')
    expect(third).toContain('User selected: A')
    expect(third).not.toContain(UNATTENDED_QUESTION_TEXT)
    expect(unattendedEvents('s-1')).toEqual([true, false])
  }, 20000)

  it('BT-INT-6 人插了一句话之后，要批准的一步出卡片；允许后工具照跑，运行跑完', async () => {
    kit.queue(
      callTool('gate', {}, 'c-gate'),
      callTool('needs_approval', {}, 'c-appr'),
      answer('run finished')
    )
    const agent = await fireUntilGated()
    const admitted = await agent.admitSteer('I am here now', { source: { kind: 'local' } })
    expect(admitted.error).toBeUndefined()
    expect(agent.unattended).toBe(false)
    releaseGate()
    await waitFor(() => agent.pendingInputCount === 1, 5000, 'the approval card is pending')
    expect(approvedRuns).toBe(0)
    const [card] = agent.pendingInputs()
    expect(card).toMatchObject({ id: 'c-appr', kind: 'ask', command: APPROVAL_COMMAND })

    expect(agent.respondToInput('c-appr', { kind: 'ask', allowed: true })).toBe(true)
    await waitFor(() => mocks.finish.mock.calls.length === 1, 5000, 'the run finished')
    expect(approvedRuns).toBe(1)
    expect(mocks.finish.mock.calls).toEqual([['log-1', 'completed']])
    const texts = kit.requests.map((_request, index) => requestTexts(kit, index).join('\n'))
    expect(texts.join('\n')).toContain('approved step ran')
    expect(texts.join('\n')).not.toContain(unattendedApprovalText(APPROVAL_COMMAND))
  }, 20000)

  it('BT-INT-7 运行结束后后台通知自动续跑：那一轮沿用无人值守，ask 当场落定，没有卡片', async () => {
    kit.queue(answer('started a task'), callTool('ask', ASK_ARGS, 'c-ask'), answer('carried on'))
    await fireAndFinish()
    expect(kit.callCount).toBe(1)

    await host
      .get('s-1')!
      .notify('<background-task id="t1" status="completed">done</background-task>')
    await waitFor(() => kit.callCount === 3, 5000, 'the resumed turn ran to its answer')
    await waitFor(() => !host.get('s-1')!.isBusy(), 5000, 'the resumed turn settled')

    expect(maxPending).toBe(0)
    expect(host.get('s-1')!.pendingInputCount).toBe(0)
    expect(requestTexts(kit, 2).join('\n')).toContain(UNATTENDED_QUESTION_TEXT)
    expect(host.get('s-1')!.unattended).toBe(true)
    expect(unattendedEvents('s-1')).toEqual([true])
  }, 20000)
})
