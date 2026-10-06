/**
 * sessionService —— 内置能力服务器（inproc MCP）实例的**寿命绑谁**。
 *
 * 契约一句话：**绑会话，不绑运行时**。
 *   - `invalidateAgent`（agent 芯片的 X / 钉档案）只销毁 agent（运行时的 destroyAgent），实例留着 ——
 *     ssh 的 control socket、browser 的 tab 不该被一次重建白白掐断；
 *   - `delete`（删会话）才释放，且顺序是**先关停运行时（SessionHost.delete）、再释放实例**：还在跑的
 *     run 可能正调着它的工具；
 *   - 子会话随父会话一起删，于是每一条都要各自释放自己那份。
 *
 * 为什么单独钉：释放曾经挂在 agent 的 dispose 钩子上，而那个钩子在「运行时已先被 invalidate 掉」
 * 时**根本不跑**（旧的运行时簿记在没有实例时提前返回）—— 于是一条先切过档案、再被删掉的
 * 会话会留下一份谁也关不掉的 inproc 连接。这种泄漏在 UI 上完全看不见，只有这一层能拦。
 *
 * mock 面沿用 sessionServiceEnabledTools.test.ts（import 图全换假件、会话运行时换成假宿主），
 * 另加一本流水账：destroyAgent / 宿主 delete / closeSession 共用它，「先关停再释放」这条只有顺序能证明。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { fakeHost, resetFakeHost, type FakeDurableSession } from './support/fakeSessionHost'

const mocks = vi.hoisted(() => ({
  daoPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  daoUpdateSettings: vi.fn<(id: string, patch: Record<string, unknown>) => void>(),
  daoFindChildren: vi.fn<(id: string) => Array<{ id: string }>>(),
  daoDeleteById: vi.fn(),
  readSessionRunConfig: vi.fn(),
  filterAvailableTools: vi.fn<(tools: string[]) => string[]>(),
  closeSession: vi.fn<(sessionId: string) => Promise<void>>(),
  getProfile: vi.fn<(name: string) => unknown>(),
  isSessionProfile: vi.fn<(profile: unknown) => boolean>(),
  calls: [] as string[]
}))

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
  isDurableSession: () => true,
  readSessionRunConfig: mocks.readSessionRunConfig,
  recordSessionModel: vi.fn()
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: (sid: string) => `/nonexistent/shuvix-unit/tmp/${sid}`,
  getToolResultsBase: () => '/nonexistent/shuvix-unit/tool-results',
  // 会话 Artifacts 的删除级联也在 sessionService.delete 里（目录不存在时 no-op）
  getSessionArtifactsDir: (sid: string) => `/nonexistent/shuvix-unit/artifacts/${sid}`,
  isSafeSessionId: (id: string) =>
    !!id && !/[/\\]/.test(id) && id !== '.' && id !== '..' && !id.includes('..')
}))
// 本文件的主角：内置能力服务器的释放口
vi.mock('../mcpService', () => ({ mcpService: { closeSession: mocks.closeSession } }))
vi.mock('../toolAggregator', () => ({ filterAvailableTools: mocks.filterAvailableTools }))
vi.mock('../../utils/toolUtils/allowList', () => ({ buildAllowEntry: vi.fn() }))
vi.mock('../agentService', () => ({
  agentService: { getProfile: mocks.getProfile, isSessionProfile: mocks.isSessionProfile }
}))
// 会话运行时换成假宿主 / 假门面（真模块的依赖图带模型注册表、事件适配器）
vi.mock('../sessionHost', async () =>
  (await import('./support/fakeSessionHost')).sessionHostModuleMock()
)
vi.mock('../agentSession', async () =>
  (await import('./support/fakeSessionHost')).agentSessionModuleMock()
)
vi.mock('../bgTaskService', () => ({ killBySession: vi.fn(), setBgTaskNotifier: vi.fn() }))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: vi.fn() }))
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
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

let sessionService: (typeof import('../sessionService'))['sessionService']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
})

// ─── 内存行表 ───────────────────────────────────────────────────────────

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

/** 某条会话打开过的那个假 DurableSession */
const durableOf = (sessionId: string): FakeDurableSession => {
  const session = fakeHost.instances.get(sessionId)?.at(-1)
  if (!session) throw new Error(`session "${sessionId}" was never opened`)
  return session
}

const closedSessions = (): string[] => mocks.closeSession.mock.calls.map((c) => c[0])

let seq = 0
let SID = ''

beforeEach(() => {
  seq += 1
  // 每条用例一个新 id：sessionService 是模块单例，前面用例建出的运行时不回收
  SID = `mcplife-${seq}`
  sessions.clear()
  mocks.calls.length = 0
  // 假宿主：destroyAgent 与 delete 都记流水账
  const host = resetFakeHost()
  host.configure = (session) => {
    const destroy = session.destroyAgent.bind(session)
    session.destroyAgent = async () => {
      mocks.calls.push(`destroyAgent:${session.sessionId}`)
      await destroy()
    }
  }
  const remove = host.delete.bind(host)
  host.delete = async (sessionId) => {
    mocks.calls.push(`delete:${sessionId}`)
    await remove(sessionId)
  }
  for (const m of Object.values(mocks)) if (!Array.isArray(m)) m.mockReset()

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
  mocks.closeSession.mockImplementation(async (sessionId) => {
    mocks.calls.push(`closeSession:${sessionId}`)
  })
})

// ─── 用例 ────────────────────────────────────────────────────────────────

describe('内置能力服务器实例的寿命绑会话，不绑运行时', () => {
  it('BMCPL-U-98: invalidateAgent 只销毁 agent，实例留着', async () => {
    seedSession(SID)
    await sessionService.ensureAgentSession(SID)

    await sessionService.invalidateAgent(SID)

    expect(durableOf(SID).callsOf('destroyAgent')).toHaveLength(1)
    expect(fakeHost.callsOf('delete')).toEqual([])
    // 回退重建是家常便饭（改配置、钉档案）—— 每次都掐断 ssh 的 control socket 没有道理
    expect(mocks.closeSession).not.toHaveBeenCalled()
  })

  it('BMCPL-U-99 / 100: delete 先关停运行时（宿主 delete）再释放实例，且只释放一次', async () => {
    seedSession(SID)
    await sessionService.ensureAgentSession(SID)

    await sessionService.delete(SID)

    expect(fakeHost.callsOf('delete')).toEqual([SID])
    expect(durableOf(SID).closed).toBe(true)
    expect(closedSessions()).toEqual([SID])
    // 顺序是实打实的：还在跑的 run 可能正调着这台服务器的工具
    expect(mocks.calls).toEqual([`delete:${SID}`, `closeSession:${SID}`])
  })

  it('BMCPL-U-101: 先 invalidate 再 delete —— 实例照样被释放', async () => {
    seedSession(SID)
    await sessionService.ensureAgentSession(SID)
    await sessionService.invalidateAgent(SID)

    await sessionService.delete(SID)

    // 曾经的洞：释放挂在 agent 的 dispose 钩子上，而此刻已经没有 agent 可 dispose 了，
    // 于是这条会话的 inproc 连接永远没人关
    expect(closedSessions()).toEqual([SID])
    expect(mocks.calls).toEqual([`destroyAgent:${SID}`, `delete:${SID}`, `closeSession:${SID}`])
  })

  it('BMCPL-U-102: 从没打开过的会话，delete 不抛且照样释放', async () => {
    seedSession(SID)

    await expect(sessionService.delete(SID)).resolves.toBeUndefined()

    // 「有没有建过 Agent」与「有没有 inproc 连接」是两件事：工具装配失败、
    // 窗口刷新过，都会留下一条有连接没运行时的会话
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.callsOf('delete')).toEqual([SID])
    expect(closedSessions()).toEqual([SID])
  })

  it('BMCPL-U-103: 删父会话时，每条子会话各自释放自己那份', async () => {
    const parent = seedSession(SID)
    const c1 = seedSession(`${SID}-c1`, { parentId: parent })
    const c2 = seedSession(`${SID}-c2`, { parentId: parent })

    await sessionService.delete(parent)

    // 子会话先走一遍同样的清理（嵌套只有一层），所以父会话排在最后
    expect(closedSessions()).toEqual([c1, c2, parent])
  })

  it('BMCPL-U-105: pinAgentProfile 走的是 invalidateAgent —— 不释放实例', async () => {
    const parent = seedSession(`${SID}-parent`)
    seedSession(SID, { parentId: parent })
    mocks.getProfile.mockReturnValue({ name: 'coding', tools: [], model: undefined })
    mocks.isSessionProfile.mockReturnValue(true)
    await sessionService.ensureAgentSession(SID)

    const result = await sessionService.pinAgentProfile(SID, 'coding')

    expect(result.success).toBe(true)
    expect(durableOf(SID).callsOf('destroyAgent')).toHaveLength(1)
    // 钉档案发生在子会话刚建好、还没说第一句话的时候：它与「这条会话结束了」无关
    expect(mocks.closeSession).not.toHaveBeenCalled()
  })
})
