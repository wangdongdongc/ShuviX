/**
 * sessionService —— 子会话的两处数据层语义（设计：docs/sub-session-design.md）。
 *
 *  1. **create({ parentId })**：projectId 恒随**父会话**，调用方传的 projectId 被忽略 ——
 *     工作目录是会话的地基，一条跨项目的子会话没有可用语义（它会在另一个目录里干活，
 *     而父级以为它在自己这边）。
 *  2. **delete 先递归删子**：父级没了，子会话多半也没有单独存在的意义；留下一批无主
 *     会话比删掉更糟。代价是删掉了用户能看见的对话，补偿在确认框的数量提示
 *     （useSessionDelete），不在这一层。
 *
 * mock 面沿用 sessionServiceListChanged.test.ts（import 图全换假件）。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  daoInsert: vi.fn(),
  daoDeleteById: vi.fn(),
  daoPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  daoFindChildren: vi.fn<(id: string) => Array<{ id: string }>>(),
  messageClear: vi.fn(),
  killBySession: vi.fn(),
  agentRemove: vi.fn(async () => {})
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    insert: mocks.daoInsert,
    deleteById: mocks.daoDeleteById,
    pick: mocks.daoPick,
    findChildren: mocks.daoFindChildren,
    updateProjectId: vi.fn(),
    updateTitle: vi.fn(),
    updateSettings: vi.fn()
  }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: vi.fn() } }))
vi.mock('../../dao/providerDao', () => ({ providerDao: {} }))
vi.mock('../../dao/projectDao', () => ({ projectDao: {} }))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: {} }))
vi.mock('../messageService', () => ({ messageService: { clear: mocks.messageClear } }))
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
vi.mock('../bgTaskService', () => ({
  killBySession: mocks.killBySession,
  setBgTaskNotifier: vi.fn()
}))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: vi.fn() }))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: vi.fn(),
  broadcastSessionListChanged: vi.fn(),
  broadcastSessionTitleChanged: vi.fn()
}))

let sessionService: typeof import('../sessionService').sessionService

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.daoFindChildren.mockReturnValue([])
  mocks.daoPick.mockReturnValue(undefined)
})

const inserted = (): Record<string, unknown> =>
  mocks.daoInsert.mock.calls[0][0] as Record<string, unknown>

describe('create —— 子会话的 parentId 与项目继承', () => {
  it('不传 parentId ⇒ 顶层会话（parentId 落 null，不是 undefined —— 那是一列）', () => {
    sessionService.create({ projectId: 'p1' })
    expect(inserted()).toMatchObject({ parentId: null, projectId: 'p1' })
  })

  it('传 parentId ⇒ projectId 恒随父会话（调用方传的被忽略）', () => {
    mocks.daoPick.mockReturnValue({ projectId: 'parent-project' })
    sessionService.create({ parentId: 'P', projectId: 'somewhere-else' })
    expect(inserted()).toMatchObject({ parentId: 'P', projectId: 'parent-project' })
  })

  it('父会话是临时会话（无项目）⇒ 子会话也无项目', () => {
    mocks.daoPick.mockReturnValue({ projectId: null })
    sessionService.create({ parentId: 'P', projectId: 'p9' })
    expect(inserted()).toMatchObject({ parentId: 'P', projectId: null })
  })

  it('父会话行已不存在 ⇒ 退回调用方给的 projectId（不因为一个坏指针拒绝建会话）', () => {
    mocks.daoPick.mockReturnValue(undefined)
    sessionService.create({ parentId: 'gone', projectId: 'p1' })
    expect(inserted()).toMatchObject({ parentId: 'gone', projectId: 'p1' })
  })
})

describe('delete —— 递归删子会话', () => {
  it('先删子后删父：子会话的资源清理（bg 任务 / 转写）一样跑完整条链', async () => {
    mocks.daoFindChildren.mockImplementation((id: string) =>
      id === 'P' ? [{ id: 'c1' }, { id: 'c2' }] : []
    )
    await sessionService.delete('P')

    const deleted = mocks.daoDeleteById.mock.calls.map((c) => c[0])
    expect(deleted).toEqual(['c1', 'c2', 'P'])
    // 子会话不是「顺手删一行」：它们各自走了完整的清理链
    expect(mocks.killBySession.mock.calls.map((c) => c[0])).toEqual(['c1', 'c2', 'P'])
    expect(mocks.messageClear.mock.calls.map((c) => c[0])).toEqual(['c1', 'c2', 'P'])
  })

  it('删子会话本身不牵连父级（只往下走，不往上走）', async () => {
    mocks.daoFindChildren.mockReturnValue([])
    await sessionService.delete('c1')
    expect(mocks.daoDeleteById.mock.calls.map((c) => c[0])).toEqual(['c1'])
  })
})
