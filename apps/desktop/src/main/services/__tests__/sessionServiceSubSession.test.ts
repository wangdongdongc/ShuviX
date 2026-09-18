/**
 * sessionService —— 子会话的两处数据层语义（设计：docs/sub-session-design.md）。
 *
 *  1. **create({ parentId })**：projectId 恒随**父会话**，调用方传的 projectId 被忽略 ——
 *     工作目录是会话的地基，一条跨项目的子会话没有可用语义（它会在另一个目录里干活，
 *     而父级以为它在自己这边）。
 *  2. **delete 先递归删子**：父级没了，子会话多半也没有单独存在的意义；留下一批无主
 *     会话比删掉更糟。代价是删掉了用户能看见的对话，补偿在确认框的数量提示
 *     （useSessionDelete），不在这一层。
 *  3. **会话 Artifacts 的目录级联**：产物归这场对话（`~/.shuvix/artifacts/<sessionId>/`），
 *     会话没了它们也没有意义。目录跟着**产出它的那场会话**走、不上溯根会话，所以父子各有
 *     自己的目录 —— 删子会话不该动到父会话那一份（反向保护：哪天改回「一律写根会话目录」，
 *     那条用例会立刻红）。这里的 artifacts 根指到临时目录，别再让它落在真实 home 上。
 *
 * mock 面沿用 sessionServiceListChanged.test.ts（import 图全换假件）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  daoInsert: vi.fn(),
  daoDeleteById: vi.fn(),
  daoPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  daoFindChildren: vi.fn<(id: string) => Array<{ id: string }>>(),
  findByKey: vi.fn(),
  getProfile: vi.fn(),
  messageClear: vi.fn(),
  killBySession: vi.fn(),
  agentRemove: vi.fn(async () => {}),
  /** 会话 Artifacts 根（临时目录）—— 桩在 utils/paths 上，每场会话一个子目录 */
  artifactsRoot: ''
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
// create 为项目会话读项目的扩展能力（继承进 settings.enabledTools）
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: vi.fn() } }))
// 「默认项目/聊天智能体」设置项已删：create 不再读任何设置（末条用例钉着零调用）
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: mocks.findByKey } }))
vi.mock('../messageService', () => ({ messageService: { clear: mocks.messageClear } }))
vi.mock('../sessionStorage', () => ({
  readSessionRunConfig: vi.fn(),
  addSessionTreePin: vi.fn(),
  appendModelChange: vi.fn()
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: vi.fn(() => '/nonexistent/e2e-tmp'),
  getToolResultsBase: vi.fn(() => '/nonexistent/e2e-results'),
  // 会话 Artifacts 的删除级联也在 sessionService.delete 里（目录不存在时 no-op）。
  // 指到临时目录而不是 /nonexistent：级联那几条用例要看目录**真的**没了
  getSessionArtifactsDir: (sid: string) => `${mocks.artifactsRoot}/${sid}`
}))
vi.mock('../mcpService', () => ({ mcpService: { closeSession: vi.fn() } }))
vi.mock('../toolAggregator', () => ({
  filterAvailableTools: vi.fn((tools: string[]) => tools)
}))
vi.mock('../../utils/toolUtils/allowList', () => ({ buildAllowEntry: vi.fn() }))
vi.mock('../agentService', () => ({ agentService: { getProfile: mocks.getProfile } }))
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

/**
 * 真实 home 的 artifacts 根 —— 哨兵盯的就是它（不存在记 null）。`getSessionArtifactsDir`
 * 的桩漏一条的表现是**往真实 home 写盘**，这比「断言路径以 tmp 开头」更抓得住。
 */
const HOME_ARTIFACTS = join(homedir(), '.shuvix', 'artifacts')
const homeSnapshot = (): string[] | null => {
  try {
    return readdirSync(HOME_ARTIFACTS).sort()
  } catch {
    return null
  }
}
let homeBefore: string[] | null = null

/** 给某场会话种一件 artifact，返回它的目录 */
const seedArtifacts = (sessionId: string): string => {
  const dir = join(mocks.artifactsRoot, sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'chart.svg'), '<svg/>', 'utf-8')
  return dir
}

beforeAll(async () => {
  homeBefore = homeSnapshot()
  mocks.artifactsRoot = join(mkdtempSync(join(tmpdir(), 'shuvix-session-artifacts-')), 'artifacts')
  ;({ sessionService } = await import('../sessionService'))
})

afterAll(() => {
  expect(homeSnapshot()).toEqual(homeBefore)
  rmSync(join(mocks.artifactsRoot, '..'), { recursive: true, force: true })
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

  it('子会话不落戳，档案随父形态推导（父有项目 work / 父无项目 chat）', () => {
    // 「不落戳 + 随父形态」是 subSessionRunner 不再显式切档案的前提：projectId 恒随父，
    // 于是 resolveAgentProfileName 对父子推导出同一个基座；父级点名档案才由 pinAgentProfile
    // 写戳。谁把「创建时定型」加回来，这里落库的 settings 就会多出一个键
    mocks.daoPick.mockReturnValue({ projectId: 'parent-project', settings: {} })
    sessionService.create({ parentId: 'P' })
    const row = inserted() as { id: string; settings: Record<string, unknown> }
    expect('agentProfile' in row.settings).toBe(false)
    expect(mocks.findByKey).not.toHaveBeenCalled()
    // 把落库行原样喂回读面：推导结果就是父形态的基座，且不查档案
    mocks.daoPick.mockReturnValue(row)
    expect(sessionService.resolveAgentProfileName(row.id)).toBe('work')
    expect(mocks.getProfile).not.toHaveBeenCalled()

    vi.clearAllMocks()
    mocks.daoPick.mockReturnValue({ projectId: null, settings: {} })
    sessionService.create({ parentId: 'P' })
    const scratch = inserted() as { id: string; settings: Record<string, unknown> }
    expect('agentProfile' in scratch.settings).toBe(false)
    mocks.daoPick.mockReturnValue(scratch)
    expect(sessionService.resolveAgentProfileName(scratch.id)).toBe('chat')
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

describe('delete —— 会话 Artifacts 目录的级联', () => {
  it('SA-1 删会话 ⇒ 它的 artifact 目录消失', async () => {
    const dir = seedArtifacts('solo')
    await sessionService.delete('solo')
    expect(existsSync(dir)).toBe(false)
  })

  it('SA-2 删父会话 ⇒ 父与子**各自**的目录都消失（目录跟着产出它的那场会话走）', async () => {
    // `work` 基座把具体活交给 `coding` 子会话，图往往是子代理画的：两份目录都得收
    mocks.daoFindChildren.mockImplementation((id: string) =>
      id === 'P' ? [{ id: 'c1' }, { id: 'c2' }] : []
    )
    const dirs = ['P', 'c1', 'c2'].map(seedArtifacts)
    await sessionService.delete('P')
    expect(dirs.map((d) => existsSync(d))).toEqual([false, false, false])
  })

  it('SA-3 删子会话不碰父会话的目录（反向保护）', async () => {
    // 哪天改回「一律写根会话目录」，这条会立刻红 —— 那时删一条子会话会把父会话的产物一起带走
    const parent = seedArtifacts('P2')
    const child = seedArtifacts('c3')
    await sessionService.delete('c3')
    expect(existsSync(child)).toBe(false)
    expect(existsSync(parent)).toBe(true)
  })

  it('SA-4 目录不存在时全程不抛（多数会话一件 artifact 都没有）', async () => {
    // 图缺省走 ```svg 围栏、根本不落盘，所以这才是常态路径
    mocks.daoFindChildren.mockImplementation((id: string) => (id === 'P3' ? [{ id: 'c4' }] : []))
    await expect(sessionService.delete('P3')).resolves.toBeUndefined()
    expect(existsSync(join(mocks.artifactsRoot, 'P3'))).toBe(false)
    expect(mocks.daoDeleteById.mock.calls.map((c) => c[0])).toEqual(['c4', 'P3'])
  })
})
