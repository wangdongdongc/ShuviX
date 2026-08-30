/**
 * sessionService —— 笔记本会话根 Agent 的档案钉死语义。
 *
 * 契约：settings.notebookPath 非空的会话恒解析为 'notebook' 基座档案（忽略 agentProfile），
 * updateAgentProfile 对它拒绝一切切换（含 'default'），且拒绝先于 getProfile / 落库 /
 * 种子写入 / invalidateAgent —— 零副作用。聊天会话侧：'notebook' 是基座档案而非切换目标；
 * 正常切换则走 落库 → invalidateAgent → 工具种子 → 广播 的完整链。
 *
 * mock 面沿用 sessionServiceTitle.test.ts 的做法（import 图全换假件，只留
 * chat-protocol / agent-runtime 真件），在其上补 sessionDao.pickSettings。
 * invalidateAgent 用实例级 spy：updateAgentProfile 经 this. 动态派发可拦截，
 * 保留穿透（底层 SessionManager.remove 对无运行时的会话直接 resolve，真件安全）。
 */
import { describe, it, expect, beforeAll, beforeEach, vi, type MockInstance } from 'vitest'

const mocks = vi.hoisted(() => ({
  daoPickSettings: vi.fn(),
  daoUpdateSettings: vi.fn(),
  getProfile: vi.fn(),
  appendModelChange: vi.fn(),
  appendActiveToolsChange: vi.fn(),
  broadcastSessionConfigChanged: vi.fn()
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { pickSettings: mocks.daoPickSettings, updateSettings: mocks.daoUpdateSettings }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: {} }))
vi.mock('../../dao/providerDao', () => ({ providerDao: {} }))
vi.mock('../../dao/projectDao', () => ({ projectDao: {} }))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: {} }))
vi.mock('../messageService', () => ({ messageService: {} }))
vi.mock('../sessionStorage', () => ({
  readSessionRunConfig: vi.fn(),
  addSessionTreePin: vi.fn(),
  appendModelChange: mocks.appendModelChange,
  appendActiveToolsChange: mocks.appendActiveToolsChange
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({ getTempWorkspace: vi.fn(), getToolResultsBase: vi.fn() }))
vi.mock('../toolAggregator', () => ({
  getDefaultEnabledTools: vi.fn(() => []),
  filterAvailableTools: vi.fn((tools: string[]) => tools)
}))
vi.mock('../../utils/toolUtils/allowList', () => ({ buildAllowEntry: vi.fn() }))
vi.mock('../botService', () => ({
  botService: {
    abortSession: vi.fn(async () => {}),
    seedGreetings: vi.fn(async () => {}),
    isActive: vi.fn(() => false)
  }
}))
vi.mock('../agentService', () => ({ agentService: { getProfile: mocks.getProfile } }))
vi.mock('../agentSession', () => ({ AgentSession: class {} }))
vi.mock('../bgTaskService', () => ({ killBySession: vi.fn(), setBgTaskNotifier: vi.fn() }))
vi.mock('../../agents/agentHost', () => ({
  resolveProfileModelSpec: vi.fn()
}))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: mocks.broadcastSessionConfigChanged,
  broadcastSessionListChanged: vi.fn(),
  broadcastSessionTitleChanged: vi.fn()
}))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: vi.fn() }
}))
vi.mock('../userInputBroker', () => ({ registerUserInputResolver: vi.fn() }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

let sessionService: (typeof import('../sessionService'))['sessionService']
let invalidateSpy: MockInstance<(sessionId: string) => Promise<void>>

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
  invalidateSpy = vi.spyOn(sessionService, 'invalidateAgent')
})
beforeEach(() => {
  mocks.daoPickSettings.mockReset()
  mocks.daoUpdateSettings.mockReset()
  mocks.getProfile.mockReset()
  mocks.appendModelChange.mockReset()
  mocks.appendActiveToolsChange.mockReset()
  mocks.broadcastSessionConfigChanged.mockReset()
  invalidateSpy.mockClear()
})

describe('resolveAgentProfileName — 笔记本会话钉死 notebook 基座', () => {
  it("notebookPath 非空 → 恒 'notebook'，忽略 agentProfile 且不查档案", () => {
    mocks.daoPickSettings.mockReturnValue({ notebookPath: 'notes/a.md', agentProfile: 'coding' })
    expect(sessionService.resolveAgentProfileName('s1')).toBe('notebook')
    expect(mocks.getProfile).not.toHaveBeenCalled()
  })

  it('notebookPath 为空串 = 非笔记本 → 走 agentProfile 解析', () => {
    mocks.daoPickSettings.mockReturnValue({ notebookPath: '', agentProfile: 'coding' })
    mocks.getProfile.mockReturnValue({ tools: [], dispatchOnly: false })
    expect(sessionService.resolveAgentProfileName('s1')).toBe('coding')
  })

  it("回落链：无 settings / 无 agentProfile / 档案已不存在 → 都是 'default'", () => {
    mocks.daoPickSettings.mockReturnValue(undefined)
    expect(sessionService.resolveAgentProfileName('s1')).toBe('default')

    mocks.daoPickSettings.mockReturnValue({})
    expect(sessionService.resolveAgentProfileName('s1')).toBe('default')

    mocks.daoPickSettings.mockReturnValue({ agentProfile: 'ghost' })
    mocks.getProfile.mockReturnValue(undefined)
    expect(sessionService.resolveAgentProfileName('s1')).toBe('default')
  })
})

describe('updateAgentProfile — 笔记本钉死与正常切换链', () => {
  it('笔记本会话：coding / default / 未知名一律 pinned 拒绝，零副作用（拒绝先于 getProfile）', async () => {
    mocks.daoPickSettings.mockReturnValue({ notebookPath: 'notes/a.md' })
    for (const name of ['coding', 'default', 'nope-not-there']) {
      const res = await sessionService.updateAgentProfile('s1', name)
      expect(res.success).toBe(false)
      expect(res.error).toMatch(/pinned/)
    }
    expect(mocks.getProfile).not.toHaveBeenCalled()
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
    expect(mocks.appendModelChange).not.toHaveBeenCalled()
    expect(mocks.appendActiveToolsChange).not.toHaveBeenCalled()
    expect(mocks.broadcastSessionConfigChanged).not.toHaveBeenCalled()
    expect(invalidateSpy).not.toHaveBeenCalled()
  })

  it("聊天会话切 'notebook'：基座档案拒绝（错误含 base profile），不落库", async () => {
    mocks.daoPickSettings.mockReturnValue({})
    mocks.getProfile.mockReturnValue({ tools: ['read'], dispatchOnly: false })
    const res = await sessionService.updateAgentProfile('s1', 'notebook')
    expect(res.success).toBe(false)
    expect(res.error).toContain('base profile')
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
  })

  it('正控制组：普通档案切换走完整链（落库 → invalidate → 工具种子 → 广播）', async () => {
    mocks.daoPickSettings.mockReturnValue({})
    mocks.getProfile.mockReturnValue({ tools: ['read', 'skill:x', 'mcp:y'], dispatchOnly: false })
    const res = await sessionService.updateAgentProfile('s1', 'myprof')
    expect(res).toEqual({
      success: true,
      applied: { model: undefined, tools: ['skill:x', 'mcp:y'] }
    })
    expect(mocks.daoUpdateSettings).toHaveBeenCalledWith('s1', { agentProfile: 'myprof' })
    expect(invalidateSpy).toHaveBeenCalledTimes(1)
    expect(mocks.appendActiveToolsChange).toHaveBeenCalledWith('s1', ['skill:x', 'mcp:y'])
    expect(mocks.broadcastSessionConfigChanged).toHaveBeenCalled()
  })
})
