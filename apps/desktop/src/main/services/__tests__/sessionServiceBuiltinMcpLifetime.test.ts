/**
 * sessionService —— 内置能力服务器（inproc MCP）实例的**寿命绑谁**。
 *
 * 契约一句话：**绑会话，不绑运行时**。
 *   - `invalidateAgent`（回退重建 / 钉档案）只换运行时，实例留着 —— ssh 的 control socket、
 *     browser 的 tab 不该被一次重建白白掐断；
 *   - `delete`（删会话）才释放，且顺序是**先关停运行时、再释放实例**：还在跑的 run 可能正调着
 *     它的工具；
 *   - 子会话随父会话一起删，于是每一条都要各自释放自己那份。
 *
 * 为什么单独钉：释放曾经挂在 agent 的 dispose 钩子上，而那个钩子在「运行时已先被 invalidate 掉」
 * 时**根本不跑**（SessionManager.remove 没有实例就提前返回）—— 于是一条先切过档案、再被删掉的
 * 会话会留下一份谁也关不掉的 inproc 连接。这种泄漏在 UI 上完全看不见，只有这一层能拦。
 *
 * mock 面沿用 sessionServiceEnabledTools.test.ts（import 图全换假件、真 SessionManager、
 * `AgentSession.create` 可捕获），另加一本流水账：destroy / invalidate / closeSession 共用它，
 * 「先关停再释放」这条只有顺序能证明。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  daoPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  daoUpdateSettings: vi.fn<(id: string, patch: Record<string, unknown>) => void>(),
  daoFindChildren: vi.fn<(id: string) => Array<{ id: string }>>(),
  daoDeleteById: vi.fn(),
  readSessionRunConfig: vi.fn(),
  filterAvailableTools: vi.fn<(tools: string[]) => string[]>(),
  agentCreate: vi.fn<(params: { sessionId: string }) => Promise<unknown>>(),
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
  getToolResultsBase: () => '/nonexistent/shuvix-unit/tool-results'
}))
// 本文件的主角：内置能力服务器的释放口
vi.mock('../mcpService', () => ({ mcpService: { closeSession: mocks.closeSession } }))
vi.mock('../toolAggregator', () => ({ filterAvailableTools: mocks.filterAvailableTools }))
vi.mock('../../utils/toolUtils/allowList', () => ({ buildAllowEntry: vi.fn() }))
vi.mock('../agentService', () => ({
  agentService: { getProfile: mocks.getProfile, isSessionProfile: mocks.isSessionProfile }
}))
vi.mock('../agentSession', () => ({ AgentSession: { create: mocks.agentCreate } }))
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

interface FakeAgent {
  invalidate: () => Promise<void>
  destroy: () => Promise<void>
}

const agents = new Map<string, FakeAgent>()

/** 假 AgentSession：SessionManager 的 dispose 只碰 invalidate / destroy，两者都记流水账 */
function makeAgent(sessionId: string): FakeAgent {
  const agent: FakeAgent = {
    invalidate: vi.fn(async () => void mocks.calls.push(`invalidate:${sessionId}`)),
    destroy: vi.fn(async () => void mocks.calls.push(`destroy:${sessionId}`))
  }
  agents.set(sessionId, agent)
  return agent
}

/** 某条会话此刻的假 Agent（create 造出来的那一份） */
const agentOf = (sessionId: string): FakeAgent => {
  const agent = agents.get(sessionId)
  if (!agent) throw new Error(`no agent was created for "${sessionId}"`)
  return agent
}

const closedSessions = (): string[] => mocks.closeSession.mock.calls.map((c) => c[0])

let seq = 0
let SID = ''

beforeEach(() => {
  seq += 1
  // 每条用例一个新 id：sessionService 是模块单例，前面用例建出的运行时不回收
  SID = `mcplife-${seq}`
  sessions.clear()
  agents.clear()
  mocks.calls.length = 0
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
  mocks.agentCreate.mockImplementation(async (params) => makeAgent(params.sessionId))
  mocks.closeSession.mockImplementation(async (sessionId) => {
    mocks.calls.push(`closeSession:${sessionId}`)
  })
})

// ─── 用例 ────────────────────────────────────────────────────────────────

describe('内置能力服务器实例的寿命绑会话，不绑运行时', () => {
  it('BMCPL-U-98: invalidateAgent 只换运行时，实例留着', async () => {
    seedSession(SID)
    await sessionService.ensureAgentSession(SID)

    await sessionService.invalidateAgent(SID)

    expect(agentOf(SID).invalidate).toHaveBeenCalledTimes(1)
    // 回退重建是家常便饭（改配置、钉档案）—— 每次都掐断 ssh 的 control socket 没有道理
    expect(mocks.closeSession).not.toHaveBeenCalled()
  })

  it('BMCPL-U-99 / 100: delete 先关停运行时（destroy）再释放实例，且只释放一次', async () => {
    seedSession(SID)
    await sessionService.ensureAgentSession(SID)

    await sessionService.delete(SID)

    expect(agentOf(SID).destroy).toHaveBeenCalledTimes(1)
    expect(closedSessions()).toEqual([SID])
    // 顺序是实打实的：还在跑的 run 可能正调着这台服务器的工具
    expect(mocks.calls).toEqual([`destroy:${SID}`, `closeSession:${SID}`])
  })

  it('BMCPL-U-101: 先 invalidate 再 delete —— 实例照样被释放', async () => {
    seedSession(SID)
    await sessionService.ensureAgentSession(SID)
    await sessionService.invalidateAgent(SID)

    await sessionService.delete(SID)

    // 曾经的洞：释放挂在 agent 的 dispose 钩子上，而此刻已经没有实例可 dispose 了
    // （SessionManager.remove 提前返回），于是这条会话的 inproc 连接永远没人关
    expect(closedSessions()).toEqual([SID])
    expect(mocks.calls).toEqual([`invalidate:${SID}`, `closeSession:${SID}`])
  })

  it('BMCPL-U-102: 从没建过运行时的会话，delete 不抛且照样释放', async () => {
    seedSession(SID)

    await expect(sessionService.delete(SID)).resolves.toBeUndefined()

    // 「有没有建过 Agent」与「有没有 inproc 连接」是两件事：工具装配失败、
    // 窗口刷新过，都会留下一条有连接没运行时的会话
    expect(mocks.agentCreate).not.toHaveBeenCalled()
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
    expect(agentOf(SID).invalidate).toHaveBeenCalledTimes(1)
    // 钉档案发生在子会话刚建好、还没说第一句话的时候：它与「这条会话结束了」无关
    expect(mocks.closeSession).not.toHaveBeenCalled()
  })
})
