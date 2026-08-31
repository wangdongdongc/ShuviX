/**
 * sessionService —— 'session.listChanged' 广播口径。
 *
 * 契约：会话列表**成员**变化（create / delete / updateProjectId）落库后必须广播一次
 * 信号事件（broadcastSessionListChanged），且广播在 dao 写入**之后** —— 订阅端收到
 * 事件即重拉 session.list，先广播后落库会拉到旧列表。标题更新不在此列（它有专属的
 * titleChanged 事件，且用户改名刻意不广播 —— 见 sessionServiceTitle.test.ts）。
 *
 * mock 面沿用 sessionServiceTitle.test.ts 的做法：import 图全换假件，
 * 只留 chat-protocol / agent-runtime 真件。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  daoInsert: vi.fn(),
  daoDeleteById: vi.fn(),
  daoUpdateProjectId: vi.fn(),
  daoUpdateTitle: vi.fn(),
  daoUpdateSettings: vi.fn(),
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
    updateSettings: mocks.daoUpdateSettings
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
    forgetNotesSession: vi.fn(),
    seedGreetings: vi.fn(async () => {}),
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
  mocks.daoInsert.mockImplementation(() => mocks.calls.push('insert'))
  mocks.daoDeleteById.mockImplementation(() => mocks.calls.push('deleteById'))
  mocks.daoUpdateProjectId.mockImplementation(() => mocks.calls.push('updateProjectId'))
  mocks.broadcastListChanged.mockImplementation(() => mocks.calls.push('broadcast'))
})

describe('session.listChanged 广播', () => {
  it('create：落库后广播一次（含 notebookPath 变体 —— wiki/memory 开会话同走此口）', () => {
    sessionService.create()
    expect(mocks.calls).toEqual(['insert', 'broadcast'])

    mocks.calls.length = 0
    sessionService.create({ projectId: 'p1', notebookPath: 'notes/a.md' })
    expect(mocks.calls).toEqual(['insert', 'broadcast'])
  })

  it('delete：deleteById 之后广播一次', async () => {
    await sessionService.delete('s1')
    expect(mocks.broadcastListChanged).toHaveBeenCalledTimes(1)
    expect(mocks.calls.indexOf('deleteById')).toBeLessThan(mocks.calls.indexOf('broadcast'))
  })

  it('updateProjectId：移动项目也是列表分组变化 → 广播', () => {
    sessionService.updateProjectId('s1', 'p2')
    expect(mocks.calls).toEqual(['updateProjectId', 'broadcast'])
  })

  it('updateTitle 不触发 listChanged（标题有专属事件，且用户改名刻意不广播）', () => {
    sessionService.updateTitle('s1', '新标题', 'user')
    sessionService.updateTitle('s1', '自动标题', 'auto')
    expect(mocks.broadcastListChanged).not.toHaveBeenCalled()
  })
})
