/**
 * sessionService —— Chrome 标签页会话（`settings.chromeTab`）的创建与列表。
 *
 * 契约：
 *   - `create({chromeTab})` 建的是一条**无项目、无父会话、不是笔记本也不是 bot** 的普通会话：
 *     projectId / parentId 恒 null，调用方传的 projectId / parentId / notebookPath / bot /
 *     memorySlug 一概不认，什么也不继承（扩展能力勾选恒 []，免询问开关不抄），也不去读父会话 /
 *     项目；settings 里只落 `{chromeTab: <三个键>, enabledTools: []}`；
 *   - chromeTab 不合法（字段不全、tabId 不是非负整数）= 没给：照普通会话建、照常继承，
 *     settings 里没有 chromeTab 键；
 *   - `list()`（侧栏）不含绑定合法的标签页会话，其余按原顺序保留（绑定不合法的旧行照列）。
 *
 * mock 面沿用 sessionServiceEnabledTools.test.ts（内存行表 + 真 SessionManager），外加 findAll。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  daoPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  daoPickSettings: vi.fn<(id: string, keys: string[]) => unknown>(),
  daoUpdateSettings: vi.fn<(id: string, patch: Record<string, unknown>) => void>(),
  daoInsert: vi.fn<(session: { id: string; settings: Record<string, unknown> }) => void>(),
  daoFindById: vi.fn<(id: string) => unknown>(),
  daoFindAll: vi.fn<() => unknown[]>(),
  projectPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  readSessionRunConfig: vi.fn(),
  findModelsByProvider: vi.fn(() => []),
  findByKey: vi.fn<(key: string) => string | undefined>(),
  filterAvailableTools: vi.fn<(tools: string[], projectPath?: string) => string[]>(),
  agentCreate: vi.fn(),
  getProfile: vi.fn()
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    pick: mocks.daoPick,
    pickSettings: mocks.daoPickSettings,
    updateSettings: mocks.daoUpdateSettings,
    insert: mocks.daoInsert,
    findById: mocks.daoFindById,
    findAll: mocks.daoFindAll,
    deleteById: vi.fn(),
    findChildren: vi.fn(() => []),
    updateProjectId: vi.fn(),
    updateTitle: vi.fn(),
    touchActive: vi.fn()
  }
}))
vi.mock('../../dao/sessionDayPromptDao', () => ({
  sessionDayPromptDao: { deleteBySessionId: vi.fn() }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: vi.fn() } }))
vi.mock('../../dao/providerDao', () => ({
  providerDao: {
    findModelsByProvider: mocks.findModelsByProvider,
    findEnabled: vi.fn(() => []),
    findEnabledModels: vi.fn(() => [])
  }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: mocks.projectPick } }))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: mocks.findByKey } }))
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
vi.mock('../mcpService', () => ({ mcpService: { closeSession: vi.fn() } }))
vi.mock('../toolAggregator', () => ({ filterAvailableTools: mocks.filterAvailableTools }))
vi.mock('../../utils/toolUtils/allowList', () => ({ buildAllowEntry: vi.fn() }))
vi.mock('../agentService', () => ({ agentService: { getProfile: mocks.getProfile } }))
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

// ─── 内存行表 ───────────────────────────────────────────────────────────────

interface MemSession {
  id: string
  title: string
  projectId: string | null
  parentId: string | null
  settings: Record<string, unknown>
  createdAt: number
  updatedAt: number
  lastActiveAt: number
}

const sessions = new Map<string, MemSession>()
const projects = new Map<string, { id: string; path: string; settings: Record<string, unknown> }>()

function pickCols(row: object | undefined, cols: readonly string[]): unknown {
  if (!row) return undefined
  const source = row as Record<string, unknown>
  return Object.fromEntries(cols.map((c) => [c, structuredClone(source[c])]))
}

function seedSession(row: Partial<MemSession> & { id: string }): void {
  sessions.set(row.id, {
    title: row.id,
    projectId: null,
    parentId: null,
    settings: {},
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: 0,
    ...row
  })
}

/** 最近一次 `create` 落库的整行 */
const insertedRow = (): MemSession => mocks.daoInsert.mock.calls.at(-1)![0] as unknown as MemSession

const BINDING = { installId: 'i1', runId: 'r1', tabId: 5 }

beforeEach(() => {
  sessions.clear()
  projects.clear()
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.daoPick.mockImplementation((id, cols) => pickCols(sessions.get(id), cols))
  mocks.daoPickSettings.mockImplementation((id, keys) => pickCols(sessions.get(id)?.settings, keys))
  mocks.daoInsert.mockImplementation((session) => {
    sessions.set(session.id, structuredClone(session) as MemSession)
  })
  mocks.daoFindById.mockImplementation((id) => structuredClone(sessions.get(id)))
  mocks.daoFindAll.mockImplementation(() => [...sessions.values()].map((r) => structuredClone(r)))
  mocks.projectPick.mockImplementation((id, cols) => pickCols(projects.get(id), cols))
  mocks.readSessionRunConfig.mockResolvedValue({})
  mocks.findModelsByProvider.mockReturnValue([])
  mocks.filterAvailableTools.mockImplementation((tools) => tools)

  // 一个有扩展能力勾选的项目，一条开着免询问、勾了扩展的父会话 —— 标签页会话一样都不该继承
  projects.set('p1', { id: 'p1', path: '/work/p1', settings: { enabledTools: ['mcp:proj'] } })
  seedSession({
    id: 'parent',
    projectId: 'p1',
    settings: { enabledTools: ['skill:from-parent'], autoAllow: true }
  })
})

describe('SCT-1 create({chromeTab}) —— 无项目、无父会话、什么也不继承', () => {
  it('SCT-1 落库：projectId / parentId 为 null，settings 恰为 {chromeTab: 三个键, enabledTools: []}', () => {
    const session = sessionService.create({
      title: 'Chrome · Inbox',
      projectId: 'p1',
      parentId: 'parent',
      notebookPath: 'notes/a.md',
      chromeTab: { ...BINDING, extra: 1 } as unknown as typeof BINDING
    })
    const row = insertedRow()
    expect(row.projectId).toBeNull()
    expect(row.parentId).toBeNull()
    expect(row.title).toBe('Chrome · Inbox')
    expect(row.settings).toStrictEqual({ chromeTab: BINDING, enabledTools: [] })
    expect(session.id).toBe(row.id)
    expect(sessions.get(row.id)!.settings.chromeTab).toStrictEqual(BINDING)
  })

  it('SCT-1 不读父会话、不读项目（它们对标签页会话没有意义）', () => {
    sessionService.create({
      title: 'Chrome',
      projectId: 'p1',
      parentId: 'parent',
      chromeTab: BINDING
    })
    expect(mocks.daoPick).not.toHaveBeenCalled()
    expect(mocks.projectPick).not.toHaveBeenCalled()
  })
})

describe('SCT-2 chromeTab 不合法 = 没给', () => {
  it.each([
    ['tabId 是字符串', { ...BINDING, tabId: '5' }],
    ['tabId 是 -1', { ...BINDING, tabId: -1 }],
    ['缺 runId', { installId: 'i1', tabId: 5 }],
    ['installId 为空串', { ...BINDING, installId: '' }],
    ['不是对象', 'i1:r1:5']
  ])('SCT-2 %s → 普通会话：没有 chromeTab 键，照常继承项目', (_label, chromeTab) => {
    sessionService.create({
      projectId: 'p1',
      notebookPath: 'notes/a.md',
      chromeTab: chromeTab as unknown as typeof BINDING
    })
    const row = insertedRow()
    expect('chromeTab' in row.settings).toBe(false)
    expect(row.projectId).toBe('p1')
    expect(row.settings.enabledTools).toEqual(['mcp:proj'])
    expect(row.settings.notebookPath).toBe('notes/a.md')
  })

  it('SCT-2 子会话同理：照常抄父会话（项目、勾选、免询问）', () => {
    sessionService.create({
      parentId: 'parent',
      chromeTab: { ...BINDING, tabId: 1.5 }
    })
    const row = insertedRow()
    expect(row.parentId).toBe('parent')
    expect(row.projectId).toBe('p1')
    expect(row.settings).toMatchObject({ enabledTools: ['skill:from-parent'], autoAllow: true })
    expect('chromeTab' in row.settings).toBe(false)
  })
})

describe('SCT-3 list() 不列标签页会话', () => {
  it('SCT-3 合法绑定的标签页会话被滤掉，其余按原顺序（含绑定不合法的旧行、笔记本、bot）', () => {
    sessions.clear()
    seedSession({ id: 'ordinary', settings: { enabledTools: [] } })
    seedSession({ id: 'tab', settings: { chromeTab: BINDING, enabledTools: [] } })
    seedSession({ id: 'broken-tab', settings: { chromeTab: { ...BINDING, tabId: '5' } } })
    seedSession({ id: 'notebook', projectId: 'p1', settings: { notebookPath: 'n.md' } })
    seedSession({ id: 'tab-2', settings: { chromeTab: { ...BINDING, tabId: 0 } } })
    seedSession({ id: 'bot', settings: { bot: 'scout' } })
    expect(sessionService.list().map((s) => s.id)).toEqual([
      'ordinary',
      'broken-tab',
      'notebook',
      'bot'
    ])
  })
})

describe('SCT-4 标签页会话不能同时是 bot 会话 / 项目记忆笔记本', () => {
  it('SCT-4 create({chromeTab, bot, memorySlug}) → 只有 chromeTab，没有 bot 与 memorySlug', () => {
    sessionService.create({ title: 'Chrome', chromeTab: BINDING, bot: 'scout', memorySlug: 'm' })
    const settings = insertedRow().settings
    expect(settings.chromeTab).toStrictEqual(BINDING)
    expect('bot' in settings).toBe(false)
    expect('memorySlug' in settings).toBe(false)
    expect(settings).toStrictEqual({ chromeTab: BINDING, enabledTools: [] })
  })

  it('SCT-4 建出来的会话按形态解析为 tab 基座（不是 bot）', () => {
    const { id } = sessionService.create({ title: 'Chrome', chromeTab: BINDING, bot: 'scout' })
    expect(sessionService.resolveAgentProfileName(id)).toBe('tab')
    expect(sessionService.isBotSession(id)).toBe(false)
  })
})

describe('SCT-5 标签页会话跑起来：tab 基座、临时工作区、没有会话勾选', () => {
  it('SCT-5 AgentSession.create 收到 profileName tab、临时目录、enabledTools []', async () => {
    const { id } = sessionService.create({ title: 'Chrome', chromeTab: BINDING })
    mocks.agentCreate.mockResolvedValue({ invalidate: vi.fn(), destroy: vi.fn() })
    await sessionService.ensureAgentSession(id)
    expect(mocks.agentCreate).toHaveBeenCalledTimes(1)
    expect(mocks.agentCreate.mock.calls[0][0]).toMatchObject({
      sessionId: id,
      profileName: 'tab',
      workingDirectory: `/nonexistent/shuvix-unit/tmp/${id}`,
      enabledTools: []
    })
    expect(mocks.getProfile).not.toHaveBeenCalled()
  })
})
