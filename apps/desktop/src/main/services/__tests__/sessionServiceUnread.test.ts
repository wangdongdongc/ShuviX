/**
 * sessionService —— 聊天会话未读账本（A4）：noteUnreadBotReply / markRead。
 *
 * 契约：bot 回复落树即未读 +1（经 updateSettings —— dao 顺带 touch updatedAt，
 * 上浮与未读是同一笔账），随后广播 listChanged；markRead 清零，且**幂等短路**：
 * 已为 0 不写库不广播（正在看的会话每来一条回复都跑一轮「+1→清零」，第二次清零
 * 不能空转一圈广播）。幂等断言必须是「零调用」——只断返回值分不出「没写」与「白写」。
 *
 * mock 面照抄 sessionServiceListChanged.test.ts，另补 sessionDao.pickSettings ——
 * 没有它两个被测方法开头就 TypeError，而那个 TypeError 会伪装成「会话已删」分支。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  daoInsert: vi.fn(),
  daoDeleteById: vi.fn(),
  daoUpdateProjectId: vi.fn(),
  daoUpdateTitle: vi.fn(),
  daoUpdateSettings: vi.fn(),
  daoPickSettings: vi.fn(),
  broadcastListChanged: vi.fn(),
  broadcastTitleChanged: vi.fn(),
  calls: [] as string[]
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    insert: mocks.daoInsert,
    deleteById: mocks.daoDeleteById,
    updateProjectId: mocks.daoUpdateProjectId,
    updateTitle: mocks.daoUpdateTitle,
    updateSettings: mocks.daoUpdateSettings,
    pickSettings: mocks.daoPickSettings
  }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: vi.fn() } }))
vi.mock('../../dao/providerDao', () => ({ providerDao: {} }))
vi.mock('../../dao/projectDao', () => ({ projectDao: {} }))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: {} }))
vi.mock('../messageService', () => ({ messageService: { clear: vi.fn() } }))
vi.mock('../sessionStorage', () => ({
  readSessionRunConfig: vi.fn(),
  addSessionTreePin: vi.fn(),
  appendModelChange: vi.fn(),
  appendActiveToolsChange: vi.fn()
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: vi.fn(() => '/nonexistent/e2e-tmp'),
  getToolResultsBase: vi.fn(() => '/nonexistent/e2e-results')
}))
vi.mock('../toolAggregator', () => ({
  getDefaultEnabledTools: vi.fn(() => []),
  filterAvailableTools: vi.fn((tools: string[]) => tools)
}))
vi.mock('../../utils/toolUtils/allowList', () => ({ buildAllowEntry: vi.fn() }))
vi.mock('../botService', () => ({
  botService: {
    abortSession: vi.fn(async () => {}),
    isActive: vi.fn(() => false)
  }
}))
vi.mock('../agentService', () => ({ agentService: { getProfile: vi.fn() } }))
vi.mock('../agentSession', () => ({ AgentSession: class {} }))
vi.mock('../bgTaskService', () => ({ killBySession: vi.fn(), setBgTaskNotifier: vi.fn() }))
vi.mock('../../agents/agentHost', () => ({
  resolveProfileModelSpec: vi.fn()
}))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: vi.fn(),
  broadcastSessionListChanged: mocks.broadcastListChanged,
  broadcastSessionTitleChanged: mocks.broadcastTitleChanged
}))

let sessionService: typeof import('../sessionService').sessionService

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.calls.length = 0
  // 顺序断言：dao 写入与广播共用一本流水账
  mocks.daoUpdateSettings.mockImplementation(() => mocks.calls.push('updateSettings'))
  mocks.broadcastListChanged.mockImplementation(() => mocks.calls.push('broadcast'))
})

describe('noteUnreadBotReply —— 未读 +1', () => {
  it.each([
    ['unreadCount 为 null', { unreadCount: null }],
    ['键缺失', {}]
  ])('首笔（%s）：写 { unreadCount: 1 }', (_n, picked) => {
    mocks.daoPickSettings.mockReturnValue(picked)

    sessionService.noteUnreadBotReply('s1')
    expect(mocks.daoUpdateSettings).toHaveBeenCalledTimes(1)
    expect(mocks.daoUpdateSettings).toHaveBeenCalledWith('s1', { unreadCount: 1 })
  })

  it('累加：当前 2 → 写 3', () => {
    mocks.daoPickSettings.mockReturnValue({ unreadCount: 2 })

    sessionService.noteUnreadBotReply('s1')
    expect(mocks.daoUpdateSettings).toHaveBeenCalledWith('s1', { unreadCount: 3 })
  })

  it('写库在广播之前（订阅端收到事件即重拉，先广播后落库会拉到旧计数）', () => {
    mocks.daoPickSettings.mockReturnValue({ unreadCount: 0 })

    sessionService.noteUnreadBotReply('s1')
    expect(mocks.calls).toEqual(['updateSettings', 'broadcast'])
  })

  it('会话已删中飞（pickSettings 回 undefined —— 与 {unreadCount:null} 是两种形状）：不抛', () => {
    // 落树与删除可以并发：记账晚于删除到达时按「从零起算」处理，绝不能把落树链路炸掉
    mocks.daoPickSettings.mockReturnValue(undefined)

    expect(() => sessionService.noteUnreadBotReply('gone')).not.toThrow()
  })
})

describe('markRead —— 清零与幂等', () => {
  it('有账可清（cur=3）：写 0、广播恰一次、写前广播后、返回 success', () => {
    mocks.daoPickSettings.mockReturnValue({ unreadCount: 3 })

    expect(sessionService.markRead('s1')).toEqual({ success: true })
    expect(mocks.daoUpdateSettings).toHaveBeenCalledTimes(1)
    expect(mocks.daoUpdateSettings).toHaveBeenCalledWith('s1', { unreadCount: 0 })
    expect(mocks.broadcastListChanged).toHaveBeenCalledTimes(1)
    expect(mocks.calls).toEqual(['updateSettings', 'broadcast'])
  })

  it.each([
    ['cur 为 0', { unreadCount: 0 }],
    ['cur 为 null', { unreadCount: null }],
    ['会话行缺失', undefined]
  ])('幂等（%s）：不调 updateSettings、不广播、仍 success', (_n, picked) => {
    // 「零调用」是唯一能分出「没写」与「白写一遍 0」的断言 —— updateSettings 顺带
    // touch updatedAt，白写会让已读会话在列表里凭空上浮
    mocks.daoPickSettings.mockReturnValue(picked)

    expect(sessionService.markRead('s1')).toEqual({ success: true })
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
    expect(mocks.broadcastListChanged).not.toHaveBeenCalled()
  })
})
