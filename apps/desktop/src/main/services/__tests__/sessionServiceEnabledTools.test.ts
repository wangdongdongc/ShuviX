/**
 * sessionService —— 会话的扩展能力勾选（`settings.enabledTools`，只收 mcp:/skill:）。
 *
 * 契约：
 *   - `create` **恒写键**（空数组也写）：项目会话继承项目**保存过**的勾选，项目没保存过 /
 *     无项目 / 项目已删为空；子会话抄父会话。继承只做 mcp:/skill: 净化与去重，**不按可用性过滤**
 *     （MCP 的可用 = 此刻已连接，过滤后落库就是永久丢项）；
 *   - 缺键的旧行在首次解析时按同一条规则补一次并落库（子会话抄父会话、不替父会话落库），
 *     之后是快照，不随项目配置漂移；
 *   - 勾选**只在创建根 Agent 时读一次**，此刻才按可用性过滤；`agent.init().enabledTools` 回原值；
 *   - 唯一写入口 `updateEnabledTools` 在 `tracked`（运行时存在 / 创建中 / 关停中）期间拒绝、零写入，
 *     `initAgent().created` 与它同一口径；
 *   - 运行时出生广播 `agent_created`，关停广播 `agent_closing` true → false（前端的只读区间）。
 *
 * mock 面沿用 sessionServiceProfileResolution.test.ts（import 图全换假件、真 SessionManager、
 * `AgentSession.create` 可捕获），只把 sessionDao / projectDao 换成一张**内存行表**：补键用例
 * 要能读回自己刚写的值，`pick(id, cols)` 按列返回。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  daoPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  daoPickSettings: vi.fn<(id: string, keys: string[]) => unknown>(),
  daoUpdateSettings: vi.fn<(id: string, patch: Record<string, unknown>) => void>(),
  daoInsert: vi.fn<(session: { id: string; settings: Record<string, unknown> }) => void>(),
  daoFindById: vi.fn<(id: string) => unknown>(),
  projectPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  readSessionRunConfig: vi.fn(),
  findModelsByProvider: vi.fn(() => []),
  findByKey: vi.fn<(key: string) => string | undefined>(),
  filterAvailableTools: vi.fn<(tools: string[], projectPath?: string) => string[]>(),
  agentCreate: vi.fn<(params: { sessionId: string; enabledTools: string[] }) => Promise<unknown>>(),
  broadcast: vi.fn<(event: Record<string, unknown>) => void>(),
  broadcastSessionConfigChanged: vi.fn<(sessionId: string) => void>(),
  daoTouchActive: vi.fn<(id: string) => void>()
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    pick: mocks.daoPick,
    pickSettings: mocks.daoPickSettings,
    updateSettings: mocks.daoUpdateSettings,
    insert: mocks.daoInsert,
    findById: mocks.daoFindById,
    deleteById: vi.fn(),
    findChildren: vi.fn(() => []),
    updateProjectId: vi.fn(),
    updateTitle: vi.fn(),
    touchActive: mocks.daoTouchActive
  }
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
vi.mock('../agentService', () => ({ agentService: { getProfile: vi.fn() } }))
vi.mock('../agentSession', () => ({ AgentSession: { create: mocks.agentCreate } }))
vi.mock('../bgTaskService', () => ({ killBySession: vi.fn(), setBgTaskNotifier: vi.fn() }))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: vi.fn() }))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: mocks.broadcastSessionConfigChanged,
  broadcastSessionListChanged: vi.fn(),
  broadcastSessionTitleChanged: vi.fn()
}))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: mocks.broadcast }
}))
vi.mock('../userInputBroker', () => ({ registerUserInputParticipant: vi.fn() }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

let sessionService: (typeof import('../sessionService'))['sessionService']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
})

// ─── 内存行表（sessionDao / projectDao 的替身） ─────────────────────────────

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

interface MemProject {
  id: string
  path: string
  settings: Record<string, unknown>
}

const sessions = new Map<string, MemSession>()
const projects = new Map<string, MemProject>()

/** `pick(id, cols)`：行不存在回 undefined，否则只回请求的列（深拷贝 —— 调用方改不到表） */
function pickCols(row: object | undefined, cols: readonly string[]): unknown {
  if (!row) return undefined
  const source = row as Record<string, unknown>
  return Object.fromEntries(cols.map((c) => [c, structuredClone(source[c])]))
}

function seedSession(row: {
  id: string
  projectId?: string | null
  parentId?: string | null
  settings?: Record<string, unknown>
}): void {
  sessions.set(row.id, {
    id: row.id,
    title: row.id,
    projectId: row.projectId ?? null,
    parentId: row.parentId ?? null,
    settings: row.settings ?? {},
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: 0
  })
}

function seedProject(id: string, settings: Record<string, unknown> = {}): void {
  projects.set(id, { id, path: `/nonexistent/shuvix-unit/projects/${id}`, settings })
}

/** 最近一次 `create` 落库的 settings（insert 收到的那一份） */
const insertedSettings = (): Record<string, unknown> =>
  mocks.daoInsert.mock.calls.at(-1)![0].settings

/** 对某一行的 updateSettings 调用 */
const writesTo = (id: string): unknown[][] =>
  mocks.daoUpdateSettings.mock.calls.filter((c) => c[0] === id)

/** 手动控制落定时机的 Promise —— 模拟「创建 / 关停在途」 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

interface FakeAgent {
  sessionId: string
  invalidate: () => Promise<void>
  destroy: () => Promise<void>
}

/** 假 AgentSession：SessionManager 的 dispose 只碰 invalidate / destroy */
function makeAgent(sessionId: string, invalidate: () => Promise<void> = async () => {}): FakeAgent {
  return { sessionId, invalidate: vi.fn(invalidate), destroy: vi.fn(async () => {}) }
}

let seq = 0
let SID = ''

beforeEach(() => {
  seq += 1
  // 每条用例一个新 id：sessionService 是模块单例，前面用例建出的运行时不回收
  SID = `ext-${seq}`
  sessions.clear()
  projects.clear()
  for (const m of Object.values(mocks)) m.mockReset()

  mocks.daoPick.mockImplementation((id, cols) => pickCols(sessions.get(id), cols))
  mocks.daoPickSettings.mockImplementation((id, keys) => pickCols(sessions.get(id)?.settings, keys))
  // 与真 DAO 同语义：json_set 按键合并进 settings
  mocks.daoUpdateSettings.mockImplementation((id, patch) => {
    const row = sessions.get(id)
    if (row) row.settings = { ...row.settings, ...structuredClone(patch) }
  })
  mocks.daoInsert.mockImplementation((session) => {
    sessions.set(session.id, structuredClone(session) as MemSession)
  })
  mocks.daoFindById.mockImplementation((id) => structuredClone(sessions.get(id)))
  mocks.projectPick.mockImplementation((id, cols) => pickCols(projects.get(id), cols))
  mocks.readSessionRunConfig.mockResolvedValue({})
  mocks.findModelsByProvider.mockReturnValue([])
  mocks.findByKey.mockReturnValue(undefined)
  mocks.filterAvailableTools.mockImplementation((tools) => tools)
  mocks.agentCreate.mockImplementation(async (params) => makeAgent(params.sessionId))
})

// ─── create：恒写键 + 继承 ──────────────────────────────────────────────────

describe('EXT-U-6 / 7 / 8 create 恒写键，项目会话继承项目保存过的勾选', () => {
  it.each([
    ['不属于任何项目', (): unknown => sessionService.create({})],
    [
      '项目从没保存过扩展能力（settings 为空）',
      (): unknown => {
        seedProject('p-empty', {})
        return sessionService.create({ projectId: 'p-empty' })
      }
    ],
    [
      '项目保存过空勾选',
      (): unknown => {
        seedProject('p-none', { enabledTools: [] })
        return sessionService.create({ projectId: 'p-none' })
      }
    ],
    [
      '给了 projectId 但项目行不存在',
      (): unknown => sessionService.create({ projectId: 'p-ghost' })
    ]
  ])('EXT-U-6 %s → 落库 settings 里有 enabledTools 键且为 []', (_label, create) => {
    // 缺键专指改制前的旧会话（首次解析时会被补键）：新会话哪怕是空也必须写键，
    // 否则它会被当成旧会话、按项目「后来」的配置补进去
    create()
    expect(mocks.daoInsert).toHaveBeenCalledTimes(1)
    const settings = insertedSettings()
    expect('enabledTools' in settings).toBe(true)
    expect(settings.enabledTools).toEqual([])
  })

  it.each([
    ['普通会话', {}],
    ['bot 会话', { bot: 'scout' }],
    ['笔记本会话', { notebookPath: 'n.md' }]
  ])('EXT-U-7 %s：继承项目保存过的勾选', (_label, extra) => {
    seedProject('p1', { enabledTools: ['mcp:a', 'skill:b'] })
    sessionService.create({ projectId: 'p1', ...extra })
    expect(insertedSettings().enabledTools).toEqual(['mcp:a', 'skill:b'])
  })

  it('EXT-U-8 继承只留 mcp:/skill:（大小写敏感、去重保序），且不按此刻可用性过滤', () => {
    seedProject('p1', { enabledTools: ['bash', 'skill:b', 'MCP:Up', 'mcp:a', 'skill:b'] })
    sessionService.create({ projectId: 'p1' })
    expect(insertedSettings().enabledTools).toEqual(['skill:b', 'mcp:a'])

    // MCP 的「可用」= 此刻已连接：刚启动还没连上的服务器若在这里被滤掉，落库就是永久丢项
    mocks.filterAvailableTools.mockImplementation((tools) => tools.filter((n) => n !== 'mcp:a'))
    sessionService.create({ projectId: 'p1' })
    expect(insertedSettings().enabledTools).toEqual(['skill:b', 'mcp:a'])
  })
})

describe('EXT-U-9 / 10 子会话抄父会话的勾选', () => {
  const PARENT = 'parent-row'

  it('EXT-U-9 (a) 抄的是父会话的勾选（净化 + 去重），不是项目那份', () => {
    seedProject('p1', { enabledTools: ['mcp:proj'] })
    seedSession({
      id: PARENT,
      projectId: 'p1',
      settings: { enabledTools: ['skill:p', 'read', 'skill:p'] }
    })
    sessionService.create({ parentId: PARENT })
    expect(insertedSettings().enabledTools).toEqual(['skill:p'])
  })

  it('EXT-U-9 (b) 父会话勾的是空 → 子会话也是空，不回落项目那份', () => {
    // 空勾选也是用户的一个选择（「这条对话一个扩展都不要」），子会话照抄
    seedProject('p1', { enabledTools: ['mcp:proj'] })
    seedSession({ id: PARENT, projectId: 'p1', settings: { enabledTools: [] } })
    sessionService.create({ parentId: PARENT })
    expect(insertedSettings().enabledTools).toEqual([])
  })

  it('EXT-U-10 父会话是缺键旧行 → 按父会话的项目继承；create 不替父会话落库', () => {
    seedProject('p1', { enabledTools: ['skill:x'] })
    seedSession({ id: PARENT, projectId: 'p1', settings: {} })
    sessionService.create({ parentId: PARENT })
    expect(insertedSettings().enabledTools).toEqual(['skill:x'])
    // 父会话的补键归它自己的首次解析；create 顺手替它写，会绕开「只补一次」的那条路
    expect(writesTo(PARENT)).toEqual([])
    expect('enabledTools' in sessions.get(PARENT)!.settings).toBe(false)
  })
})

// ─── 旧会话补键 ─────────────────────────────────────────────────────────────

describe('EXT-U-11 缺键的旧根会话：首次解析按同一条规则补一次并落库', () => {
  it('EXT-U-11 首次 initAgent 补项目那份并恰好写一次；之后项目改了也不漂移', async () => {
    seedProject('p1', { enabledTools: ['skill:x'] })
    seedSession({ id: SID, projectId: 'p1', parentId: null, settings: {} })

    const first = await sessionService.initAgent(SID)
    expect(writesTo(SID)).toEqual([[SID, { enabledTools: ['skill:x'] }]])
    expect(first.enabledTools).toEqual(['skill:x'])
    // 补键 bump updatedAt（DAO updateSettings），不算用户动手
    expect(mocks.daoTouchActive).not.toHaveBeenCalled()

    // 补上之后就是一份快照：项目配置的后续修改不再波及这条会话
    projects.get('p1')!.settings = { enabledTools: ['mcp:y'] }
    const second = await sessionService.initAgent(SID)
    expect(writesTo(SID)).toHaveLength(1)
    expect(second.enabledTools).toEqual(['skill:x'])
  })

  it('EXT-U-11 无项目的旧会话补的是 []，键确实被写入', async () => {
    seedSession({ id: SID, projectId: null, settings: {} })
    expect((await sessionService.initAgent(SID)).enabledTools).toEqual([])
    expect(writesTo(SID)).toEqual([[SID, { enabledTools: [] }]])
    expect(sessions.get(SID)!.settings.enabledTools).toEqual([])
  })

  it('EXT-U-11 首次解析走 ensureAgentSession 同样补键，AgentSession.create 收到补上的值', async () => {
    seedProject('p1', { enabledTools: ['skill:x'] })
    seedSession({ id: SID, projectId: 'p1', settings: {} })

    await sessionService.ensureAgentSession(SID)
    expect(writesTo(SID)).toEqual([[SID, { enabledTools: ['skill:x'] }]])
    expect(mocks.agentCreate).toHaveBeenCalledTimes(1)
    expect(mocks.agentCreate.mock.calls[0][0].enabledTools).toEqual(['skill:x'])
  })

  it('EXT-U-11 补键同样不按可用性过滤：此刻离线的 MCP 照样补进去', async () => {
    seedProject('p1', { enabledTools: ['skill:x', 'mcp:offline'] })
    seedSession({ id: SID, projectId: 'p1', settings: {} })
    mocks.filterAvailableTools.mockImplementation((tools) =>
      tools.filter((n) => n !== 'mcp:offline')
    )

    const init = await sessionService.initAgent(SID)
    expect(writesTo(SID)).toEqual([[SID, { enabledTools: ['skill:x', 'mcp:offline'] }]])
    expect(init.enabledTools).toEqual(['skill:x', 'mcp:offline'])
  })
})

describe('EXT-U-11b 缺键的旧子会话：补键抄父会话，不替父会话落库', () => {
  it('EXT-U-11b 父会话有勾选 → 子会话补父会话那份；父行 0 写入', async () => {
    seedProject('p1', { enabledTools: ['mcp:proj'] })
    seedSession({ id: 'P', projectId: 'p1', settings: { enabledTools: ['skill:p'] } })
    seedSession({ id: SID, projectId: 'p1', parentId: 'P', settings: {} })

    const init = await sessionService.initAgent(SID)
    expect(writesTo(SID)).toEqual([[SID, { enabledTools: ['skill:p'] }]])
    expect(init.enabledTools).toEqual(['skill:p'])
    expect(writesTo('P')).toEqual([])
  })

  it('EXT-U-11b 父会话也缺键 → 按父会话自己的项目算；父行仍 0 写入', async () => {
    // 子行的 projectId 故意与父行不同（正常数据里二者恒相同）：钉的是「按父会话的项目」——
    // 与父会话下次自己解析出来的是同一份 —— 而不是碰巧落在同一个项目上
    seedProject('p1', { enabledTools: ['mcp:proj'] })
    seedProject('p-child', { enabledTools: ['skill:child-proj'] })
    seedSession({ id: 'P', projectId: 'p1', settings: {} })
    seedSession({ id: SID, projectId: 'p-child', parentId: 'P', settings: {} })

    const init = await sessionService.initAgent(SID)
    expect(writesTo(SID)).toEqual([[SID, { enabledTools: ['mcp:proj'] }]])
    expect(init.enabledTools).toEqual(['mcp:proj'])
    expect(writesTo('P')).toEqual([])
    expect('enabledTools' in sessions.get('P')!.settings).toBe(false)
  })
})

// ─── 只在创建 Agent 时读一次 ────────────────────────────────────────────────

describe('EXT-U-12 勾选只在创建根 Agent 时读一次，此刻才按可用性过滤', () => {
  it('EXT-U-12 init 回原值、AgentSession.create 收到过滤后的；不写库；运行期改库不会被读到', async () => {
    seedProject('p1')
    seedSession({
      id: SID,
      projectId: 'p1',
      settings: { enabledTools: ['skill:ok', 'mcp:offline'] }
    })
    mocks.filterAvailableTools.mockImplementation((tools) =>
      tools.filter((n) => n !== 'mcp:offline')
    )

    // UI 要的是原值：离线的 MCP 显示为已勾，整份替换写入时才不会被抹掉
    expect((await sessionService.initAgent(SID)).enabledTools).toEqual(['skill:ok', 'mcp:offline'])

    const agent = await sessionService.ensureAgentSession(SID)
    expect(mocks.agentCreate).toHaveBeenCalledTimes(1)
    expect(mocks.agentCreate.mock.calls[0][0].enabledTools).toEqual(['skill:ok'])
    // 过滤只作用于这一次创建：设置里的原值不动（服务器下次连上、重建运行时就又回来了）
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
    expect(sessions.get(SID)!.settings.enabledTools).toEqual(['skill:ok', 'mcp:offline'])

    // 运行时活着时绕过写入口直接改库：运行时不重读，也不因此重建
    sessions.get(SID)!.settings.enabledTools = ['skill:changed']
    expect(await sessionService.ensureAgentSession(SID)).toBe(agent)
    expect(mocks.agentCreate).toHaveBeenCalledTimes(1)
  })
})

// ─── 写入口 ────────────────────────────────────────────────────────────────

describe('EXT-U-13 / 14 / 15 写入口 updateEnabledTools', () => {
  it('EXT-U-13 没有运行时：整份替换、只收 mcp:/skill:（去重保序、大小写敏感），不按可用性过滤；每次广播一次', () => {
    seedSession({ id: SID, settings: { enabledTools: ['skill:old'] } })
    // skill:unknown 此刻不可用 —— 照样落库（可用性只在创建 Agent 时过滤）
    mocks.filterAvailableTools.mockImplementation((tools) =>
      tools.filter((n) => n !== 'skill:unknown')
    )

    expect(
      sessionService.updateEnabledTools(SID, [
        'skill:a',
        'bash',
        'mcp:b',
        'skill:a',
        'MCP:c',
        'skill:unknown'
      ])
    ).toBe(true)
    expect(writesTo(SID)).toEqual([[SID, { enabledTools: ['skill:a', 'mcp:b', 'skill:unknown'] }]])
    expect(mocks.broadcastSessionConfigChanged.mock.calls).toEqual([[SID]])
    expect(mocks.daoTouchActive).toHaveBeenCalledWith(SID)

    // 整份替换：空数组就是清空，不是「没意见」
    expect(sessionService.updateEnabledTools(SID, [])).toBe(true)
    expect(writesTo(SID)[1]).toEqual([SID, { enabledTools: [] }])
    expect(sessions.get(SID)!.settings.enabledTools).toEqual([])
    expect(mocks.broadcastSessionConfigChanged.mock.calls).toEqual([[SID], [SID]])
  })

  it('EXT-U-14 创建在途 / 运行时存在 / 关停在途都拒绝且零副作用，关停完毕才放行；initAgent().created 同一口径', async () => {
    seedSession({ id: SID, settings: { enabledTools: [] } })
    const born = deferred<FakeAgent>()
    const closed = deferred()
    mocks.agentCreate.mockImplementationOnce(() => born.promise)

    // ① 创建在途：ensure 同步登记 —— 在它之后到来的写入一律拒绝，不会出现
    //    「勾选落库了、运行时却是按旧勾选建的」
    const p = sessionService.ensureAgentSession(SID)
    expect(sessionService.updateEnabledTools(SID, ['skill:a'])).toBe(false)
    expect((await sessionService.initAgent(SID)).created).toBe(true)
    await vi.waitFor(() => expect(mocks.agentCreate).toHaveBeenCalledTimes(1))
    expect(sessionService.updateEnabledTools(SID, ['skill:a'])).toBe(false)

    // ② 运行时存在，随后关停在途
    born.resolve(makeAgent(SID, () => closed.promise))
    await p
    expect(sessionService.updateEnabledTools(SID, ['skill:a'])).toBe(false)
    expect((await sessionService.initAgent(SID)).created).toBe(true)
    const r = sessionService.invalidateAgent(SID)
    expect(sessionService.updateEnabledTools(SID, ['skill:a'])).toBe(false)
    // 关停可能卡很久：窗口刷新时事件早已错过，前端的只读态只能靠 created 这一位打底
    expect((await sessionService.initAgent(SID)).created).toBe(true)
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
    expect(mocks.broadcastSessionConfigChanged).not.toHaveBeenCalled()
    expect(mocks.daoTouchActive).not.toHaveBeenCalled()

    // ③ 关停完毕：重新可改（下一个运行时创建时读）
    closed.resolve()
    await r
    expect((await sessionService.initAgent(SID)).created).toBe(false)
    expect(sessionService.updateEnabledTools(SID, ['skill:a'])).toBe(true)
    expect(writesTo(SID)).toEqual([[SID, { enabledTools: ['skill:a'] }]])
    expect(mocks.broadcastSessionConfigChanged).toHaveBeenCalledTimes(1)
  })

  it('EXT-U-15 (a) 会话不存在 → false，零写入零广播', () => {
    expect(sessionService.updateEnabledTools('no-such-session', ['skill:a'])).toBe(false)
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
    expect(mocks.broadcastSessionConfigChanged).not.toHaveBeenCalled()
  })

  it('EXT-U-15 (b) 创建失败之后不会永久锁死：写入照常放行', async () => {
    seedSession({ id: SID, settings: { enabledTools: [] } })
    mocks.agentCreate.mockRejectedValueOnce(new Error('构造炸了'))
    await expect(sessionService.ensureAgentSession(SID)).rejects.toThrow('构造炸了')

    expect(sessionService.updateEnabledTools(SID, ['skill:a'])).toBe(true)
    expect(writesTo(SID)).toEqual([[SID, { enabledTools: ['skill:a'] }]])
  })
})

// ─── 运行时区间事件 ─────────────────────────────────────────────────────────

describe('EXT-U-16 运行时区间事件：agent_created / agent_closing', () => {
  /** broadcast 里属于本会话的运行时生命周期事件（按到达顺序） */
  const lifecycle = (): Array<Record<string, unknown>> =>
    mocks.broadcast.mock.calls
      .map((c) => c[0])
      .filter(
        (e) => e.sessionId === SID && (e.type === 'agent_created' || e.type === 'agent_closing')
      )

  it('EXT-U-16 init 不发；ensure 恰发一次 agent_created；再 ensure 不发；invalidate 依次发 closing true / false', async () => {
    seedSession({ id: SID, settings: { enabledTools: [] } })

    // init 只解析不创建：这里发了 agent_created，前端会把一条根本没有运行时的会话锁成只读
    await sessionService.initAgent(SID)
    expect(lifecycle()).toEqual([])

    await sessionService.ensureAgentSession(SID)
    expect(lifecycle()).toEqual([{ type: 'agent_created', sessionId: SID }])

    await sessionService.ensureAgentSession(SID)
    expect(lifecycle()).toHaveLength(1)

    await sessionService.invalidateAgent(SID)
    expect(lifecycle()).toEqual([
      { type: 'agent_created', sessionId: SID },
      { type: 'agent_closing', sessionId: SID, closing: true },
      { type: 'agent_closing', sessionId: SID, closing: false }
    ])
  })
})
