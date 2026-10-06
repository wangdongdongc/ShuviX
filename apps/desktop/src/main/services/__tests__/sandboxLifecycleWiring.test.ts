/**
 * 命令沙箱的生命周期接线（HG-2）—— sandbox 模块整个替身，只看「谁在什么时候调了它」。
 *
 * 契约（pi-durable 之后）：
 *   - 命令沙箱的钉子记在锁记录里（随解锁一起没了），sandbox 模块不再按会话登记，销毁 agent / 删会话
 *     都没有要解的钉；
 *   - 删会话（sessionService.delete）才清它的临时目录（cleanupSession）；销毁 agent（agent 芯片的 X /
 *     钉档案 → `AgentSession.invalidate` → 运行时的 destroyAgent）不清 —— 会话还在，它的 TMPDIR 里可能
 *     正放着后台命令的中间文件。子会话各自清自己的那份。
 *
 * 两层：
 *   A. AgentSession 门面直接构造（假 DurableSession / 假 SessionHost），用可控的 destroyAgent / delete
 *      闸门证明收尾的时机；
 *   B. sessionService 走真实门面（会话运行时是假宿主），证明 delete / invalidateAgent 这两条入口真的接到
 *      上面那两个方法与 cleanupSession 上。
 * 所有调用记进同一本流水账 —— 顺序只有它能证明。
 *
 * 同一条收尾链上还挂着**询问点自动审查的会话内状态**（agent-runtime reviewState：连续 / 累计拒绝计数、
 * 卡片反馈、放行标记）—— 它与决策日志同寿：
 *   - RV-L1 删会话（destroy）在关停**之后**按本会话 id 清它，恰一次（还在收尾的旧 run 可能正要
 *           落下一次审查结论，先清后落，清理就白做了）；
 *   - RV-L2 invalidate() 不清（会话还在：拒绝计数与卡片反馈要带进重建后的 agent），别的会话 destroy
 *           也不清本会话；
 *   - RV-L3 黑盒：真安全门 + 审查接缝替身连拒 3 次让本会话暂停审查，destroy 之后解除；
 *   - SS-DEL-RV sessionService.delete 清（决策日志、卡片反馈、审查计数）—— 会话开没开过都一样。
 * `clearReviewState` 经 agent-runtime 的部分 mock 换成「记进流水账 + 穿透到真件」：流水账证明谁在什么
 * 时候清的，真状态证明确实清掉了。reviewState 与决策日志都是进程级 Map —— 每条用例一个新会话 id，
 * afterEach 把用过的 id 清干净。
 */
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import {
  clearReviewState,
  clearSessionDecisions,
  createSecurityContext,
  getSessionDecisions,
  humanFeedbackOf,
  reviewSuspended,
  type EnforceOutcome,
  type PermissionReviewAnswer,
  type SecurityContext
} from '@shuvix/agent-runtime'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'
import type { PermissionDecision } from '@shuvix/chat-protocol/types/permissionReview'
import {
  fakeHost,
  gate,
  lockRecord,
  resetFakeHost,
  type FakeDurableSession,
  type FakeSessionHost,
  type Gate
} from './support/fakeSessionHost'

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  // sandbox 模块（本文件的主角）
  cleanupSession: vi.fn<(sessionId: string) => void>(),
  // agent-runtime 的审查状态清理（记一笔，真件照清 —— 见下面的部分 mock）
  clearReviewState: vi.fn<(sessionId: string) => void>(),
  // AgentSession 的依赖
  getProfile: vi.fn<(name: string) => unknown>(),
  isSessionProfile: vi.fn<(profile: unknown) => boolean>(),
  clearFileTimeSession: vi.fn<(sessionId: string) => void>(),
  abortSessionRuns: vi.fn<(sessionId: string) => void>(),
  // sessionService 的依赖
  daoPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  daoUpdateSettings: vi.fn<(id: string, patch: Record<string, unknown>) => void>(),
  daoFindChildren: vi.fn<(id: string) => Array<{ id: string }>>(),
  daoDeleteById: vi.fn(),
  readSessionRunConfig: vi.fn(),
  filterAvailableTools: vi.fn<(tools: string[]) => string[]>(),
  closeSession: vi.fn<(sessionId: string) => Promise<void>>(),
  killBySession: vi.fn<(sessionId: string) => void>()
}))

vi.mock('../sandbox', () => ({
  cleanupSession: mocks.cleanupSession
}))

// agent-runtime 只换 clearReviewState：先记进流水账，再穿透到真件（RV-L3 / SS-DEL-RV 看的是真状态）
vi.mock('@shuvix/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shuvix/agent-runtime')>()
  return {
    ...actual,
    clearReviewState: (sessionId: string): void => {
      mocks.clearReviewState(sessionId)
      actual.clearReviewState(sessionId)
    }
  }
})

// ─── AgentSession 的 import 图 ───────────────────────────────────────────
vi.mock('../settingsService', () => ({ settingsService: { get: () => undefined } }))
vi.mock('../hookService', () => ({
  hookTriggers: { fire: vi.fn() },
  hookService: { abortSessionRuns: mocks.abortSessionRuns }
}))
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: vi.fn(async () => null),
  isDefaultTitle: vi.fn()
}))
vi.mock('../sessionDayPromptService', () => ({ recordUserEntry: vi.fn() }))
vi.mock('../../utils/toolUtils/fileTime', () => ({
  clearSession: mocks.clearFileTimeSession,
  recordRead: vi.fn()
}))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: vi.fn() }))
vi.mock('../agentService', () => ({
  agentService: { getProfile: mocks.getProfile, isSessionProfile: mocks.isSessionProfile }
}))
// 会话运行时是假宿主（门面与 sessionService 都是真的）
vi.mock('../sessionHost', async () =>
  (await import('./support/fakeSessionHost')).sessionHostModuleMock()
)

// ─── sessionService 的 import 图（同 sessionServiceBuiltinMcpLifetime.test） ─────────
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    pick: mocks.daoPick,
    pickSettings: vi.fn(),
    updateSettings: mocks.daoUpdateSettings,
    insert: vi.fn(),
    findById: vi.fn(),
    deleteById: mocks.daoDeleteById,
    findChildren: mocks.daoFindChildren,
    updateProjectId: vi.fn(),
    updateTitle: vi.fn()
  }
}))
vi.mock('../../dao/sessionDayPromptDao', () => ({
  sessionDayPromptDao: { deleteBySessionId: vi.fn() }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: vi.fn() } }))
vi.mock('../../dao/providerDao', () => ({
  providerDao: { findModelsByProvider: vi.fn(() => []) }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: vi.fn() } }))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: vi.fn() } }))
vi.mock('../sessionStorage', () => ({
  isDurableSession: () => true,
  readSessionRunConfig: mocks.readSessionRunConfig,
  recordSessionModel: vi.fn()
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: (sid: string) => `/nonexistent/shuvix-unit/tmp/${sid}`,
  getToolResultsBase: () => '/nonexistent/shuvix-unit/tool-results',
  getSessionArtifactsDir: (sid: string) => `/nonexistent/shuvix-unit/artifacts/${sid}`,
  isSafeSessionId: (id: string) =>
    !!id && !/[/\\]/.test(id) && id !== '.' && id !== '..' && !id.includes('..')
}))
vi.mock('../mcpService', () => ({ mcpService: { closeSession: mocks.closeSession } }))
vi.mock('../toolAggregator', () => ({ filterAvailableTools: mocks.filterAvailableTools }))
vi.mock('../../utils/toolUtils/allowList', () => ({ buildAllowEntry: vi.fn() }))
vi.mock('../bgTaskService', () => ({
  killBySession: mocks.killBySession,
  setBgTaskNotifier: vi.fn()
}))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: vi.fn(),
  broadcastSessionListChanged: vi.fn(),
  broadcastSessionTitleChanged: vi.fn()
}))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: vi.fn() }
}))
vi.mock('../userInputBroker', () => ({ registerUserInputParticipant: vi.fn() }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

type AgentSessionMod = typeof import('../agentSession')
type AgentSessionInstance = import('../agentSession').AgentSession
let AgentSession: AgentSessionMod['AgentSession']
let sessionService: (typeof import('../sessionService'))['sessionService']

beforeAll(async () => {
  ;({ AgentSession } = await import('../agentSession'))
  ;({ sessionService } = await import('../sessionService'))
})

// ─── 假会话运行时：destroyAgent / delete 可控（挂起 / 抛错），每一步都记流水账 ─────────────

type StopMode = 'ok' | 'throw' | 'hold'

let stopMode: StopMode = 'ok'
/** stopMode === 'hold' 时，destroyAgent / delete 等它放行 */
let stopGate: Gate = gate()

/** 一个打开着、锁着的会话（层 A 直接拿它的门面） */
function openSession(sessionId: string): FakeDurableSession {
  return fakeHost.put(sessionId, { lock: lockRecord() })
}

/** 门面（层 A） */
function facadeOf(sessionId: string): AgentSessionInstance {
  return AgentSession.of(fakeHost.get(sessionId) ?? openSession(sessionId))
}

/** 每个新打开的假会话：destroyAgent 记流水账、受 stopMode 控制 */
function instrument(host: FakeSessionHost): void {
  host.configure = (session) => {
    session.destroyAgent = async () => {
      session.calls.push(['destroyAgent'])
      mocks.calls.push(`destroyAgent:start:${session.sessionId}`)
      if (stopMode === 'hold') await stopGate.promise
      if (stopMode === 'throw') {
        mocks.calls.push(`destroyAgent:threw:${session.sessionId}`)
        throw new Error('destroy failed')
      }
      session.lock = undefined
      mocks.calls.push(`destroyAgent:end:${session.sessionId}`)
    }
  }
  const remove = host.delete.bind(host)
  host.delete = async (sessionId) => {
    mocks.calls.push(`delete:start:${sessionId}`)
    if (stopMode === 'hold') await stopGate.promise
    await remove(sessionId)
    if (stopMode === 'throw') {
      mocks.calls.push(`delete:threw:${sessionId}`)
      throw new Error('delete failed')
    }
    mocks.calls.push(`delete:end:${sessionId}`)
  }
}

const profileOf = (name: string): Record<string, unknown> => ({
  name,
  displayName: name,
  description: '',
  tools: [],
  systemPrompt: `${name} prompt`,
  instructionFiles: [],
  projectAwareness: false
})

/** 让已排队的微任务 / 定时器回调跑完（关停挂起时，后面的步骤不该偷跑） */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const idx = (entry: string): number => mocks.calls.indexOf(entry)

// ─── 层 B 的内存行表 ─────────────────────────────────────────────────────

interface MemSession {
  id: string
  projectId: string | null
  parentId: string | null
  settings: Record<string, unknown>
}

const sessions = new Map<string, MemSession>()

function seedSession(id: string, patch: Partial<MemSession> = {}): string {
  sessions.set(id, {
    id,
    projectId: patch.projectId ?? null,
    parentId: patch.parentId ?? null,
    settings: patch.settings ?? { enabledTools: [] }
  })
  return id
}

let seq = 0
let SID = ''

beforeEach(() => {
  seq += 1
  // sessionService 是模块单例：每条用例一个新 id，免得前一条留下的运行时串场
  SID = `sbxlife-${seq}`
  sessions.clear()
  mocks.calls.length = 0
  for (const m of Object.values(mocks)) if (!Array.isArray(m)) m.mockReset()
  stopMode = 'ok'
  stopGate = gate()
  instrument(resetFakeHost())

  mocks.cleanupSession.mockImplementation((id) => void mocks.calls.push(`cleanup:${id}`))
  mocks.clearReviewState.mockImplementation((id) => void mocks.calls.push(`clearReview:${id}`))
  mocks.clearFileTimeSession.mockImplementation(
    (id) => void mocks.calls.push(`clearFileTime:${id}`)
  )
  mocks.killBySession.mockImplementation((id) => void mocks.calls.push(`kill:${id}`))
  mocks.closeSession.mockImplementation(async (id) => void mocks.calls.push(`closeSession:${id}`))
  mocks.getProfile.mockImplementation((name) => profileOf(name))

  mocks.daoPick.mockImplementation((id, cols) => {
    const row = sessions.get(id)
    if (!row) return undefined
    const source = row as unknown as Record<string, unknown>
    return Object.fromEntries(cols.map((c) => [c, structuredClone(source[c])]))
  })
  mocks.daoUpdateSettings.mockImplementation((id, patch) => {
    const row = sessions.get(id)
    if (row) row.settings = { ...row.settings, ...structuredClone(patch) }
  })
  mocks.daoFindChildren.mockImplementation((id) =>
    [...sessions.values()].filter((s) => s.parentId === id).map((s) => ({ id: s.id }))
  )
  mocks.readSessionRunConfig.mockResolvedValue({})
  mocks.filterAvailableTools.mockImplementation((tools) => tools)
})

// ─── 真审查状态的造法（RV-L3 / SS-DEL-RV）─────────────────────────────────

/** 内置策略 md 的构建期内联读取口（真装配链要它；测试进程，不进桌面 bundle） */
const INLINE_POLICY_MD = createInlinePolicyMdReader()

/** 造过真审查状态 / 决策日志的会话 id —— 两者都是进程级 Map，afterEach 逐个清掉 */
const touched = new Set<string>()

afterEach(() => {
  for (const id of touched) {
    clearReviewState(id)
    clearSessionDecisions(id)
  }
  touched.clear()
})

/**
 * 一道真安全门：用户策略把每次工具调用都判 ask（tier ask —— 弹卡之前先交给审查接缝）。审查接缝
 * 按 `answers` 依次作答（答完之后没有意见）；轮到人时，人在卡片上写一句反馈。
 */
function reviewedGate(sessionId: string, answers: PermissionDecision[]): SecurityContext {
  touched.add(sessionId)
  return createSecurityContext(
    { kind: 'agent', sessionId, agentKind: 'root' },
    { host: 'desktop', workspaceDir: '/ws' },
    {
      host: 'desktop',
      pathSep: '/',
      getVars: () => ({
        workspace: '/ws',
        toolResultsBase: '/tool-results',
        skillsDirs: ['/skills'],
        memoryDirs: [],
        knowledgeRoot: '/kb',
        knowledgeSessionDirs: [],
        home: '/home/u',
        systemDirs: []
      }),
      getSessionGrants: () => ({ allowList: [] }),
      readBuiltinPolicyMd: INLINE_POLICY_MD,
      getUserPolicies: () => [
        {
          name: 'gate-every-call',
          displayName: 'gate-every-call',
          description: '',
          rules: [{ effect: 'ask', object: { kind: 'invocation' } }],
          body: ''
        }
      ],
      requestUserInput: async () => ({ kind: 'other', text: 'not like that' }),
      onPermissionRequest: async (): Promise<PermissionReviewAnswer | null> => {
        const decision = answers.shift()
        if (!decision) return null
        return {
          verdict: { decision, risk: 'high', summary: 'probe', reason: `reviewer: ${decision}` },
          source: 'auto-review'
        }
      }
    }
  )
}

/** 过一次这道门（一次工具调用的 L1 门） */
const probeCall = (gate: SecurityContext, i: number): Promise<EnforceOutcome> =>
  gate.enforceInvocation({ toolCallId: `tc-rv-${i}`, toolName: 'probe', onOther: 'return' })

/** 审查员连拒 3 次 → 本会话的询问从此跳过审查（真状态） */
async function suspendReview(sessionId: string): Promise<void> {
  const gate = reviewedGate(sessionId, ['deny', 'deny', 'deny'])
  for (let i = 0; i < 3; i++) {
    await expect(probeCall(gate, i)).rejects.toThrow(/Blocked by the reviewer/)
  }
  expect(reviewSuspended(sessionId)).toBe(true)
}

/**
 * 安全模块的全套会话内存：审查答 ask → 人在卡片上写反馈（卡片反馈 1 条），再连拒 3 次（审查暂停）；
 * 决策日志因此 4 条。
 */
async function seedSecurityMemory(sessionId: string): Promise<void> {
  const gate = reviewedGate(sessionId, ['ask', 'deny', 'deny', 'deny'])
  await expect(probeCall(gate, 0)).resolves.toEqual({ status: 'feedback', text: 'not like that' })
  for (let i = 1; i <= 3; i++) {
    await expect(probeCall(gate, i)).rejects.toThrow(/Blocked by the reviewer/)
  }
  expect(humanFeedbackOf(sessionId)).toHaveLength(1)
  expect(getSessionDecisions(sessionId)).toHaveLength(4)
  expect(reviewSuspended(sessionId)).toBe(true)
}

// ─── 层 A：AgentSession ────────────────────────────────────────────────

describe('HG-2 AgentSession —— 销毁 agent 不清临时目录', () => {
  it('HG-2 invalidate() 不清临时目录：会话还在，它的 TMPDIR 不能随一次销毁 agent 被删', async () => {
    await facadeOf(SID).invalidate()
    expect(mocks.cleanupSession).not.toHaveBeenCalled()
    expect(fakeHost.callsOf('delete')).toEqual([])
  })
})

describe('RV-L AgentSession —— 询问点审查的会话内状态与决策日志同寿', () => {
  it('RV-L1 destroy()：宿主 delete 还挂着时不清；关停之后按本会话 id 清审查状态，恰一次', async () => {
    const session = facadeOf(SID)
    stopMode = 'hold'

    const pending = session.destroy()
    await settle()
    // 旧 run 还没停下：它可能正要落下一次审查结论（计数 +1）—— 先清后落，清理就白做了
    expect(mocks.calls).toContain(`delete:start:${SID}`)
    expect(mocks.clearReviewState).not.toHaveBeenCalled()

    stopGate.release()
    await pending

    expect(mocks.clearReviewState.mock.calls).toEqual([[SID]])
    expect(idx(`delete:end:${SID}`)).toBeGreaterThanOrEqual(0)
    expect(idx(`delete:end:${SID}`)).toBeLessThan(idx(`clearReview:${SID}`))
  })

  it('RV-L1 destroy()：delete 抛错也照样清（关停失败只记日志，收尾链路要走完）', async () => {
    const session = facadeOf(SID)
    stopMode = 'throw'

    await expect(session.destroy()).resolves.toBeUndefined()

    expect(mocks.clearReviewState.mock.calls).toEqual([[SID]])
    expect(idx(`delete:threw:${SID}`)).toBeLessThan(idx(`clearReview:${SID}`))
  })

  it('RV-L2 invalidate() 不清（会话还在：拒绝计数与卡片反馈要带进重建后的 agent）；别的会话 destroy 也不清本会话', async () => {
    const mine = facadeOf(SID)
    const other = facadeOf(`${SID}-other`)
    await suspendReview(SID)

    await mine.invalidate()
    await other.destroy()

    expect(mocks.clearReviewState.mock.calls).toEqual([[`${SID}-other`]])
    // 真状态也还在：连拒 3 次换来的「直接问人」没有因为一次销毁 agent、或别人的删除被悄悄解除
    expect(reviewSuspended(SID)).toBe(true)
  })

  it('RV-L3 黑盒：审查接缝替身经真安全门连拒 3 次 → 本会话暂停审查；destroy 之后 reviewSuspended 回到 false', async () => {
    const session = facadeOf(SID)
    await suspendReview(SID)

    await session.destroy()

    expect(reviewSuspended(SID)).toBe(false)
  })
})

// ─── 层 B：sessionService 的两个入口 ───────────────────────────────────────

describe('HG-2 sessionService —— delete 清临时目录，invalidateAgent 不清', () => {
  it('HG-2 delete(会话开着)：先关停运行时（宿主 delete），再清临时目录；cleanupSession 按本会话 id 恰一次', async () => {
    seedSession(SID)
    await sessionService.ensureAgentSession(SID)
    expect(fakeHost.callsOf('open')).toEqual([SID])

    await sessionService.delete(SID)

    expect(mocks.cleanupSession.mock.calls).toEqual([[SID]])
    // 删目录之前：后台任务已被杀、运行时已停 —— 否则还活着的命令会往一个刚删掉的 TMPDIR 里写
    expect(idx(`kill:${SID}`)).toBeLessThan(idx(`cleanup:${SID}`))
    expect(idx(`delete:end:${SID}`)).toBeLessThan(idx(`cleanup:${SID}`))
  })

  it('HG-2 delete(从没打开过)：照样关停（宿主 delete 删存储）并清临时目录', async () => {
    seedSession(SID)

    await expect(sessionService.delete(SID)).resolves.toBeUndefined()

    // 「有没有运行时」与「有没有临时目录」是两件事：后台命令、窗口刷新都会留下没运行时的会话
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.callsOf('delete')).toEqual([SID])
    expect(mocks.cleanupSession.mock.calls).toEqual([[SID]])
  })

  it('HG-2 delete(先 invalidateAgent 再删)：临时目录照样清', async () => {
    seedSession(SID)
    await sessionService.ensureAgentSession(SID)
    await sessionService.invalidateAgent(SID)

    await sessionService.delete(SID)

    expect(mocks.cleanupSession.mock.calls).toEqual([[SID]])
  })

  it('HG-2 删父会话：每条子会话各清各的，父会话排最后', async () => {
    const parent = seedSession(SID)
    const c1 = seedSession(`${SID}-c1`, { parentId: parent })
    const c2 = seedSession(`${SID}-c2`, { parentId: parent })

    await sessionService.delete(parent)

    expect(mocks.cleanupSession.mock.calls).toEqual([[c1], [c2], [parent]])
  })

  it('HG-2 invalidateAgent：经真实门面的 invalidate（运行时 destroyAgent），不清临时目录', async () => {
    seedSession(SID)
    await sessionService.ensureAgentSession(SID)

    await sessionService.invalidateAgent(SID)

    expect(idx(`destroyAgent:end:${SID}`)).toBeGreaterThanOrEqual(0)
    expect(mocks.cleanupSession).not.toHaveBeenCalled()
  })
})

describe('SS-DEL-RV sessionService.delete —— 安全模块的会话内存随会话一起删', () => {
  it.each([
    ['从没打开过', async (): Promise<void> => {}],
    [
      'agent 已先被销毁',
      async (): Promise<void> => {
        await sessionService.ensureAgentSession(SID)
        await sessionService.invalidateAgent(SID)
      }
    ],
    [
      '会话开着',
      async (): Promise<void> => {
        await sessionService.ensureAgentSession(SID)
      }
    ]
  ] as const)(
    'SS-DEL-RV delete（%s）：决策日志、卡片反馈、审查暂停全部清掉，按本会话 id 恰清一次',
    async (_label, arrange) => {
      seedSession(SID)
      await arrange()
      await seedSecurityMemory(SID)

      await sessionService.delete(SID)

      expect(getSessionDecisions(SID)).toEqual([])
      expect(humanFeedbackOf(SID)).toEqual([])
      expect(reviewSuspended(SID)).toBe(false)
      // 会话开没开过都走同一条收尾（destroySessionRuntime），恰清一次
      expect(mocks.clearReviewState.mock.calls).toEqual([[SID]])
    }
  )
})
