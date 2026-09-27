/**
 * 命令沙箱的生命周期接线（HG-2）—— sandbox 模块整个替身，只看「谁在什么时候调了它」。
 *
 * 契约：
 *   - 「本会话套不套沙箱」按运行时固定（pinSession）。运行时**失效**（回退重建 / 钉档案）或**销毁**
 *     时必须 unpinSession —— 否则下一个运行时沿用旧决定：设置里刚关掉的沙箱照样套着，或者刚打开的
 *     照样不套，而新工具的参数与说明却按新开关生成，两边对不上；
 *   - 解钉排在关停**之后**：还在收尾的旧 run 的工具说明写的是「受限」，关停完之前不该改口；
 *     关停失败（abort 抛错）也照样解钉 —— abortQuietly 只记日志，清理链路的其余步骤要走完；
 *   - 删会话（sessionService.delete）才清它的临时目录（cleanupSession）；回退重建不清 —— 会话还在，
 *     它的 TMPDIR 里可能正放着后台命令的中间文件。子会话各自清自己的那份。
 *
 * 两层：
 *   A. AgentSession 直接构造（agentFactory.createAgent 替身，同 agentSessionBot.test），用一个可控
 *      的 abort 证明「先关停、再解钉」；
 *   B. sessionService 走真实 AgentSession（mock 面沿用 sessionServiceBuiltinMcpLifetime.test），
 *      证明 delete / invalidateAgent 这两条入口真的接到了上面那两个方法与 cleanupSession 上。
 * 所有调用记进同一本流水账 —— 顺序只有它能证明。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  // sandbox 模块（本文件的主角）
  unpinSession: vi.fn<(sessionId: string) => void>(),
  cleanupSession: vi.fn<(sessionId: string) => void>(),
  // AgentSession 的依赖
  createAgent: vi.fn<(params: { sessionId: string }) => Promise<unknown>>(),
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
  unpinSession: mocks.unpinSession,
  cleanupSession: mocks.cleanupSession
}))

// ─── AgentSession 的 import 图 ───────────────────────────────────────────
vi.mock('../settingsService', () => ({ settingsService: { get: () => undefined } }))
vi.mock('../botService', () => ({ botService: { forSession: () => null } }))
vi.mock('../hookService', () => ({
  hookTriggers: { fire: vi.fn() },
  hookService: { abortSessionRuns: mocks.abortSessionRuns }
}))
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: vi.fn(),
  isDefaultTitle: vi.fn()
}))
vi.mock('../../utils/toolUtils/fileTime', () => ({
  clearSession: mocks.clearFileTimeSession,
  recordRead: vi.fn()
}))
vi.mock('../../agents/agentHost', () => ({
  agentFactory: { createAgent: mocks.createAgent },
  resolveProfileModelSpec: vi.fn()
}))
vi.mock('../agentService', () => ({
  agentService: { getProfile: mocks.getProfile, isSessionProfile: mocks.isSessionProfile }
}))

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
vi.mock('../messageService', () => ({ messageService: { clear: vi.fn() } }))
vi.mock('../sessionStorage', () => ({
  readSessionRunConfig: mocks.readSessionRunConfig,
  addSessionTreePin: vi.fn(),
  appendModelChange: vi.fn()
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
let AgentSession: AgentSessionMod['AgentSession']
let sessionService: (typeof import('../sessionService'))['sessionService']

beforeAll(async () => {
  ;({ AgentSession } = await import('../agentSession'))
  ;({ sessionService } = await import('../sessionService'))
})

// ─── 假运行时：abort 可控（挂起 / 抛错），每一步都记流水账 ───────────────────────

type AbortMode = 'ok' | 'throw' | 'hold'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

let abortMode: AbortMode = 'ok'
/** abortMode === 'hold' 时，abort 等它放行 */
let abortGate: Deferred = deferred()

function fakeCreated(sessionId: string): Record<string, unknown> {
  return {
    profile: { name: 'work' },
    runtime: {
      abort: vi.fn(async () => {
        mocks.calls.push(`abort:start:${sessionId}`)
        if (abortMode === 'hold') await abortGate.promise
        if (abortMode === 'throw') {
          mocks.calls.push(`abort:threw:${sessionId}`)
          throw new Error('abort failed')
        }
        mocks.calls.push(`abort:end:${sessionId}`)
      })
    },
    dispose: vi.fn(() => void mocks.calls.push(`dispose:${sessionId}`))
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

/** 直接造一个根会话的 AgentSession（层 A） */
async function createSession(
  sessionId: string
): Promise<Awaited<ReturnType<AgentSessionMod['AgentSession']['create']>>> {
  return AgentSession.create({
    sessionId,
    provider: 'p',
    model: 'm',
    capabilities: {},
    workingDirectory: '/proj',
    enabledTools: [],
    profileName: 'work'
  })
}

/** 让已排队的微任务 / 定时器回调跑完（abort 挂起时，后面的步骤不该偷跑） */
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
  abortMode = 'ok'
  abortGate = deferred()

  mocks.unpinSession.mockImplementation((id) => void mocks.calls.push(`unpin:${id}`))
  mocks.cleanupSession.mockImplementation((id) => void mocks.calls.push(`cleanup:${id}`))
  mocks.clearFileTimeSession.mockImplementation(
    (id) => void mocks.calls.push(`clearFileTime:${id}`)
  )
  mocks.killBySession.mockImplementation((id) => void mocks.calls.push(`kill:${id}`))
  mocks.closeSession.mockImplementation(async (id) => void mocks.calls.push(`closeSession:${id}`))
  mocks.createAgent.mockImplementation(async (params) => fakeCreated(params.sessionId))
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

// ─── 层 A：AgentSession ────────────────────────────────────────────────

describe('HG-2 AgentSession —— 失效 / 销毁都解钉，且排在关停之后', () => {
  it.each(['invalidate', 'destroy'] as const)(
    'HG-2 %s()：abort 还挂着时不解钉；放行后恰解钉一次、按本会话 id',
    async (method) => {
      const session = await createSession(SID)
      abortMode = 'hold'

      const pending = session[method]()
      await settle()
      // 旧 run 还没停下：它的工具说明仍写着「受限」，此刻改口就是说明与执行对不上
      expect(mocks.calls).toContain(`abort:start:${SID}`)
      expect(mocks.unpinSession).not.toHaveBeenCalled()

      abortGate.resolve()
      await pending

      expect(mocks.unpinSession.mock.calls).toEqual([[SID]])
      expect(idx(`abort:end:${SID}`)).toBeGreaterThanOrEqual(0)
      expect(idx(`abort:end:${SID}`)).toBeLessThan(idx(`unpin:${SID}`))
      // 运行时的清理（dispose）也在解钉之前走完 —— 解钉是这一串收尾的最后一环之一
      expect(idx(`dispose:${SID}`)).toBeLessThan(idx(`unpin:${SID}`))
    }
  )

  it.each(['invalidate', 'destroy'] as const)(
    'HG-2 %s()：abort 抛错也照样解钉（关停失败只记日志，收尾链路要走完）',
    async (method) => {
      const session = await createSession(SID)
      abortMode = 'throw'

      await expect(session[method]()).resolves.toBeUndefined()

      expect(mocks.unpinSession.mock.calls).toEqual([[SID]])
      expect(idx(`abort:threw:${SID}`)).toBeLessThan(idx(`unpin:${SID}`))
    }
  )

  it('HG-2 invalidate() 只解钉、不清临时目录：会话还在，它的 TMPDIR 不能随一次回退重建被删', async () => {
    const session = await createSession(SID)
    await session.invalidate()
    expect(mocks.unpinSession.mock.calls).toEqual([[SID]])
    expect(mocks.cleanupSession).not.toHaveBeenCalled()
  })

  it('HG-2 只动自己这一条：另一条会话的 invalidate / destroy 不解本会话的钉', async () => {
    const mine = await createSession(SID)
    const other = await createSession(`${SID}-other`)
    await other.invalidate()
    await other.destroy()
    expect(mocks.unpinSession.mock.calls.every(([id]) => id === `${SID}-other`)).toBe(true)
    await mine.destroy()
    expect(mocks.unpinSession.mock.calls.filter(([id]) => id === SID)).toHaveLength(1)
  })
})

// ─── 层 B：sessionService 的两个入口 ───────────────────────────────────────

describe('HG-2 sessionService —— delete 清临时目录，invalidateAgent 只解钉', () => {
  it('HG-2 delete(有运行时)：先关停运行时（解钉），再清临时目录；cleanupSession 按本会话 id 恰一次', async () => {
    seedSession(SID)
    await sessionService.ensureAgentSession(SID)
    expect(mocks.createAgent).toHaveBeenCalledTimes(1)

    await sessionService.delete(SID)

    expect(mocks.cleanupSession.mock.calls).toEqual([[SID]])
    // 销毁路径本身就解钉（AgentSession.destroy）
    expect(mocks.unpinSession.mock.calls).toContainEqual([SID])
    // 删目录之前：后台任务已被杀、运行时已停 —— 否则还活着的命令会往一个刚删掉的 TMPDIR 里写
    expect(idx(`kill:${SID}`)).toBeLessThan(idx(`cleanup:${SID}`))
    expect(idx(`abort:end:${SID}`)).toBeLessThan(idx(`cleanup:${SID}`))
    expect(idx(`unpin:${SID}`)).toBeLessThan(idx(`cleanup:${SID}`))
  })

  it('HG-2 delete(从没建过运行时)：照样清临时目录', async () => {
    seedSession(SID)

    await expect(sessionService.delete(SID)).resolves.toBeUndefined()

    // 「有没有运行时」与「有没有临时目录」是两件事：后台命令、窗口刷新都会留下没运行时的会话
    expect(mocks.createAgent).not.toHaveBeenCalled()
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

  it('HG-2 invalidateAgent：经真实 AgentSession.invalidate 解钉，不清临时目录', async () => {
    seedSession(SID)
    await sessionService.ensureAgentSession(SID)

    await sessionService.invalidateAgent(SID)

    expect(mocks.unpinSession.mock.calls).toEqual([[SID]])
    expect(idx(`abort:end:${SID}`)).toBeLessThan(idx(`unpin:${SID}`))
    expect(mocks.cleanupSession).not.toHaveBeenCalled()
  })
})
