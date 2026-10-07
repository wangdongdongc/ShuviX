/**
 * sessionService —— 会话的扩展能力勾选（`settings.enabledTools`，只收 mcp:/skill:）。
 *
 * 契约：
 *   - `create` **恒写键**（空数组也写）：项目会话继承项目**保存过**的勾选，项目没保存过 /
 *     无项目 / 项目已删为空；子会话抄父会话。继承只做 mcp:/skill: 净化与去重，**不按可用性过滤**
 *     （MCP 的可用 = 此刻已连接，过滤后落库就是永久丢项）；
 *   - 缺键的旧行在首次解析时按同一条规则补一次并落库（子会话抄父会话、不替父会话落库），
 *     之后是快照，不随项目配置漂移；
 *   - 勾选**只在创建根 Agent 时读一次**（运行时创建 agent 时调 `resolveAgentConfig`），此刻才按可用性
 *     过滤；`agent.init().enabledTools` 回原值；
 *   - 唯一写入口 `updateEnabledTools` 在锁住期间（会话开着看运行时的锁，没开着看锁镜像
 *     `settings.agentLocked`；销毁在途锁还在）拒绝、零写入，`initAgent().created` 与它同一口径；
 *     创建在途的窗口里照样接受（PIN-12）；
 *   - agent_created / agent_closing 归运行时的锁广播，sessionService 不发（见 sessionHostWiring 的 D10-39）。
 *
 * mock 面沿用 sessionServiceProfileResolution.test.ts（import 图全换假件、会话运行时换成假宿主），
 * 只把 sessionDao / projectDao 换成一张**内存行表**：补键用例要能读回自己刚写的值，
 * `pick(id, cols)` 按列返回。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { fakeHost, gate, lockRecord, resetFakeHost } from './support/fakeSessionHost'

const mocks = vi.hoisted(() => ({
  daoPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  daoPickSettings: vi.fn<(id: string, keys: string[]) => unknown>(),
  daoUpdateSettings: vi.fn<(id: string, patch: Record<string, unknown>) => void>(),
  daoInsert: vi.fn<(session: { id: string; settings: Record<string, unknown> }) => void>(),
  daoFindById: vi.fn<(id: string) => unknown>(),
  projectPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  readSessionRunConfig: vi.fn(),
  findModelsByProvider: vi.fn<(provider: string) => unknown[]>(() => []),
  listProviders: vi.fn<() => unknown[]>(() => []),
  findByKey: vi.fn<(key: string) => string | undefined>(),
  filterAvailableTools: vi.fn<(tools: string[], projectPath?: string) => string[]>(),
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
// provider 行（锁里的 pi provider id 译回行 id 用，LA-D）
vi.mock('../models', () => ({
  providerCredentialPort: { listProviders: mocks.listProviders }
}))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: mocks.findByKey } }))
vi.mock('../messageService', () => ({ messageService: { clear: vi.fn() } }))
vi.mock('../sessionStorage', () => ({
  isDurableSession: () => true,
  readSessionRunConfig: mocks.readSessionRunConfig,
  recordSessionModel: vi.fn()
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: (sid: string) => `/nonexistent/shuvix-unit/tmp/${sid}`,
  getToolResultsBase: () => '/nonexistent/shuvix-unit/tool-results'
}))
vi.mock('../mcpService', () => ({ mcpService: { closeSession: vi.fn() } }))
vi.mock('../toolAggregator', () => ({ filterAvailableTools: mocks.filterAvailableTools }))
vi.mock('../../utils/toolUtils/allowList', () => ({ buildAllowEntry: vi.fn() }))
vi.mock('../agentService', () => ({
  agentService: {
    getProfile: vi.fn((name: string) => ({
      name,
      tools: [],
      instructionFiles: [],
      projectAwareness: false
    }))
  }
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
  mocks.listProviders.mockReturnValue([])
  mocks.findByKey.mockReturnValue(undefined)
  mocks.filterAvailableTools.mockImplementation((tools) => tools)
  resetFakeHost()
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

  it('EXT-U-11 首次解析走 resolveAgentConfig（创建 agent 时）同样补键，toolOverlay 就是补上的值', async () => {
    seedProject('p1', { enabledTools: ['skill:x'] })
    seedSession({ id: SID, projectId: 'p1', settings: {} })

    const config = await sessionService.resolveAgentConfig(SID)
    expect(writesTo(SID)).toEqual([[SID, { enabledTools: ['skill:x'] }]])
    expect(config.toolOverlay).toEqual(['skill:x'])
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
  it('EXT-U-12 init 回原值、创建 agent 时读到过滤后的；不写库；每次创建现读', async () => {
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

    expect((await sessionService.resolveAgentConfig(SID)).toolOverlay).toEqual(['skill:ok'])
    // 过滤只作用于这一次创建：设置里的原值不动（服务器下次连上、重建 agent 就又回来了）
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
    expect(sessions.get(SID)!.settings.enabledTools).toEqual(['skill:ok', 'mcp:offline'])

    // 只打开会话不读配置（创建 agent 才读，锁住之后运行时不再读 —— 见运行时的 LS-03）
    await sessionService.ensureAgentSession(SID)
    expect(fakeHost.callsOf('open')).toEqual([SID])
    // 下一次创建现读：库里改了就是改了的那份
    sessions.get(SID)!.settings.enabledTools = ['skill:changed']
    expect((await sessionService.resolveAgentConfig(SID)).toolOverlay).toEqual(['skill:changed'])
  })

  it('EXT-U-12c 勾选里的 mcp:chrome 不作数：过滤与创建都见不到它；init 回原值；不写库', async () => {
    // 内置 `chrome`（用户真实的 Chrome）不是会话可勾选的扩展能力 —— 只由 Chrome 标签页会话的
    // 基座 `tab` 声明。桌面会话的勾选里就算有它（手改的库、旧数据），也不能借此碰到用户的 Chrome
    seedProject('p1')
    seedSession({
      id: SID,
      projectId: 'p1',
      settings: { enabledTools: ['mcp:chrome', 'mcp:ssh', 'skill:x'] }
    })

    expect((await sessionService.initAgent(SID)).enabledTools).toEqual([
      'mcp:chrome',
      'mcp:ssh',
      'skill:x'
    ])
    const config = await sessionService.resolveAgentConfig(SID)
    const filtered = mocks.filterAvailableTools.mock.calls.map(([tools]) => tools)
    expect(filtered.length).toBeGreaterThan(0)
    for (const tools of filtered) expect(tools).toEqual(['mcp:ssh', 'skill:x'])
    expect(config.toolOverlay).toEqual(['mcp:ssh', 'skill:x'])
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
    expect(sessions.get(SID)!.settings.enabledTools).toEqual(['mcp:chrome', 'mcp:ssh', 'skill:x'])
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
    expect(mocks.daoTouchActive).not.toHaveBeenCalled()

    // 整份替换：空数组就是清空，不是「没意见」
    expect(sessionService.updateEnabledTools(SID, [])).toBe(true)
    expect(writesTo(SID)[1]).toEqual([SID, { enabledTools: [] }])
    expect(sessions.get(SID)!.settings.enabledTools).toEqual([])
    expect(mocks.broadcastSessionConfigChanged.mock.calls).toEqual([[SID], [SID]])
  })

  it('EXT-U-14 锁着（开着看运行时的锁 / 没开看锁镜像）/ 销毁在途都拒绝且零副作用，解锁才放行；initAgent().created 同一口径', async () => {
    seedSession({ id: SID, settings: { enabledTools: [] } })

    // ① 没开着、锁镜像说有 agent（上一次进程里建的）：拒绝
    sessions.get(SID)!.settings.agentLocked = true
    expect(sessionService.updateEnabledTools(SID, ['skill:a'])).toBe(false)
    expect((await sessionService.initAgent(SID)).created).toBe(true)

    // ② 开着、锁着：以运行时的锁为准
    const session = fakeHost.put(SID, { lock: lockRecord() })
    expect(sessionService.updateEnabledTools(SID, ['skill:a'])).toBe(false)
    expect((await sessionService.initAgent(SID)).created).toBe(true)

    // ③ 销毁在途：锁还在 → 仍拒绝
    const release = gate()
    session.destroyGate = release
    const r = sessionService.invalidateAgent(SID)
    expect(sessionService.updateEnabledTools(SID, ['skill:a'])).toBe(false)
    // 销毁可能卡很久：窗口刷新时事件早已错过，前端的只读态只能靠 created 这一位打底
    expect((await sessionService.initAgent(SID)).created).toBe(true)
    // 拒绝零写入（锁镜像那一格是种子数据，不算写入口的写入）
    expect(writesTo(SID)).toEqual([])
    expect(mocks.broadcastSessionConfigChanged).not.toHaveBeenCalled()
    expect(mocks.daoTouchActive).not.toHaveBeenCalled()

    // ④ 解锁：重新可改（下一次创建时读）—— 开着的会话以运行时的锁为准，不看过时的镜像
    release.release()
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

  it('EXT-U-15 (b) 创建被拒之后不会锁死：没有锁，写入照常放行', async () => {
    seedSession({ id: SID, settings: { enabledTools: [] } })
    // 打开着、第一次发送的创建被拒（模型被拒）—— 运行时什么都不写，锁始终没有
    const session = fakeHost.put(SID)
    session.submitResults = [{ error: 'no model', code: 'no_model' }]
    await session.submitUser('hi')
    expect(session.lock).toBeUndefined()

    expect(sessionService.updateEnabledTools(SID, ['skill:a'])).toBe(true)
    expect(writesTo(SID)).toEqual([[SID, { enabledTools: ['skill:a'] }]])
  })
})

// ─── hasAgentRuntime：模型锁与扩展能力锁同一口径 ──────────────────────────────

describe('ML-U-1 hasAgentRuntime 与 initAgent().created / updateEnabledTools 同一口径', () => {
  /**
   * 三个面此刻说的是不是同一件事：hasAgentRuntime（agent.setModel 的拒绝条件）、
   * initAgent().created（前端只读态的打底）、updateEnabledTools 能否写入（扩展能力的拒绝条件）。
   * 写入探针用的是会话现有的那份勾选 —— 放行时只是原样重写一遍，不改变后续时刻的状态。
   */
  async function snapshot(): Promise<{ runtime: boolean; created: boolean; writable: boolean }> {
    const runtime = sessionService.hasAgentRuntime(SID)
    const created = (await sessionService.initAgent(SID)).created
    const writable = sessionService.updateEnabledTools(SID, ['skill:a'])
    return { runtime, created, writable }
  }
  const LOCKED = { runtime: true, created: true, writable: false }
  const FREE = { runtime: false, created: false, writable: true }

  it('ML-U-1 没开 / 开着没锁 / 锁着 / 销毁中 / 销毁完 / 没开但镜像为真（initAgent peek 打开它读真正的锁，option A）：每个时刻三面一致', async () => {
    seedSession({ id: SID, settings: { enabledTools: ['skill:a'] } })

    // ① 没开、没有镜像：三面都说可改
    expect(await snapshot()).toEqual(FREE)

    // ② 打开但还没创建 agent（创建在途的窗口同样可改，PIN-12）
    await sessionService.ensureAgentSession(SID)
    const session = fakeHost.get(SID)!
    expect(await snapshot()).toEqual(FREE)

    // ③ 锁着：模型与勾选都只读
    session.lock = lockRecord()
    expect(await snapshot()).toEqual(LOCKED)

    // ④ 销毁在途（锁还在）：仍只读
    const release = gate()
    session.destroyGate = release
    const r = sessionService.invalidateAgent(SID)
    expect(sessionService.hasAgentRuntime(SID)).toBe(true)
    expect(await snapshot()).toEqual(LOCKED)

    // ⑤ 销毁完：解锁
    release.release()
    await r
    expect(await snapshot()).toEqual(FREE)

    // ⑥ 会话没开着、镜像为真：initAgent 先 peek 打开它、按真正的锁回答（option A）——
    //   打开时锁保留了（同一进程里 LRU 关掉的 / 上个进程留下、有可续的工作）→ 只读
    await fakeHost.close(SID)
    sessions.get(SID)!.settings.agentLocked = true
    fakeHost.configure = (reopened) => {
      reopened.lock = lockRecord()
    }
    expect(await snapshot()).toEqual(LOCKED)
    expect(fakeHost.callsOf('peek')).toEqual([SID])
    //   上个进程留下、空闲：打开时锁清掉了 → initAgent 之后三面都说可改（镜像过时，运行时为准）
    await fakeHost.close(SID)
    fakeHost.configure = undefined
    expect(sessionService.hasAgentRuntime(SID)).toBe(true)
    expect((await sessionService.initAgent(SID)).created).toBe(false)
    expect(fakeHost.callsOf('peek')).toEqual([SID, SID])
    expect(await snapshot()).toEqual(FREE)
    //   镜像为假：不 peek，可改
    await fakeHost.close(SID)
    sessions.get(SID)!.settings.agentLocked = false
    expect(await snapshot()).toEqual(FREE)
    expect(fakeHost.callsOf('peek')).toEqual([SID, SID])
  })

  it('ML-U-1 开着但没锁、镜像过时说有 → 以运行时为准：可改', async () => {
    seedSession({ id: SID, settings: { enabledTools: ['skill:a'], agentLocked: true } })
    fakeHost.put(SID)
    expect(await snapshot()).toEqual(FREE)
  })

  it('ML-U-1 会话不存在 → hasAgentRuntime false（不抛）', () => {
    expect(sessionService.hasAgentRuntime('no-such-session')).toBe(false)
  })
})

describe('LA-D initAgent reports the locked agent, not the session settings (option A)', () => {
  const ROWS = [
    { id: 'row-anthropic', name: 'Anthropic', isBuiltin: true, isEnabled: true },
    { id: 'custom-row', name: 'My proxy', isBuiltin: false, isEnabled: true }
  ]
  const SETTINGS_RUN = { provider: 'custom-row', model: 'settings-model', thinkingLevel: 'low' }

  beforeEach(() => {
    mocks.readSessionRunConfig.mockResolvedValue(SETTINGS_RUN)
    mocks.listProviders.mockReturnValue(ROWS)
    mocks.findModelsByProvider.mockImplementation((provider) =>
      provider === 'row-anthropic'
        ? [{ modelId: 'claude-x', capabilities: JSON.stringify({ reasoning: true, vision: true }) }]
        : [
            { modelId: 'settings-model', capabilities: JSON.stringify({ reasoning: false }) },
            { modelId: 'proxy-model', capabilities: JSON.stringify({ vision: true }) }
          ]
    )
  })

  it('LA-D1 open and locked: the locked model (pi id → provider row id) with its capabilities, the live thinking level and the selection the lock was created from — none of it from the settings', async () => {
    seedSession({ id: SID, settings: { enabledTools: ['mcp:settings-only', 'skill:a'] } })
    fakeHost.put(SID, {
      lock: lockRecord({
        model: { provider: 'anthropic', modelId: 'claude-x' },
        thinkingLevel: 'medium',
        mcp: { ssh: [] },
        skills: ['pdf', 'builtin:drawing'],
        // 连不上的 tavily 也在创建时的勾选里（界面照旧画成「已勾 + 离线」）
        selection: ['skill:pdf', 'mcp:ssh', 'mcp:tavily']
      }),
      thinkingLevel: 'high'
    })
    const result = await sessionService.initAgent(SID)
    expect(result).toEqual({
      success: true,
      created: true,
      provider: 'row-anthropic',
      model: 'claude-x',
      capabilities: { reasoning: true, vision: true },
      modelMetadata: { thinkingLevel: 'high' },
      workingDirectory: expect.any(String),
      enabledTools: ['skill:pdf', 'mcp:ssh', 'mcp:tavily']
    })
    // 会话开着：不 peek
    expect(fakeHost.callsOf('peek')).toEqual([])
    // 会话设置一个字都没动
    expect(sessions.get(SID)!.settings.enabledTools).toEqual(['mcp:settings-only', 'skill:a'])
  })

  it('LA-D2 a custom provider keeps its row id; a provider row that is gone leaves the pi id as it is (no capabilities)', async () => {
    seedSession({ id: SID, settings: { enabledTools: [] } })
    const session = fakeHost.put(SID, {
      lock: lockRecord({ model: { provider: 'custom-row', modelId: 'proxy-model' } })
    })
    expect(await sessionService.initAgent(SID)).toMatchObject({
      created: true,
      provider: 'custom-row',
      model: 'proxy-model',
      capabilities: { vision: true },
      modelMetadata: { thinkingLevel: 'off' },
      enabledTools: []
    })
    session.lock = lockRecord({ model: { provider: 'gone', modelId: 'old-model' } })
    expect(await sessionService.initAgent(SID)).toMatchObject({
      created: true,
      provider: 'gone',
      model: 'old-model',
      capabilities: {}
    })
  })

  it('LA-D5 a lock from before the selection was recorded: the tool selection falls back to the settings (frozen while locked); the model still comes from the lock', async () => {
    seedSession({ id: SID, settings: { enabledTools: ['mcp:settings-only'] } })
    fakeHost.put(SID, {
      lock: lockRecord({ model: { provider: 'anthropic', modelId: 'claude-x' } })
    })
    expect(await sessionService.initAgent(SID)).toMatchObject({
      created: true,
      provider: 'row-anthropic',
      model: 'claude-x',
      enabledTools: ['mcp:settings-only']
    })
  })

  it('LA-D3 not locked: the session settings, as before', async () => {
    seedSession({ id: SID, settings: { enabledTools: ['mcp:settings-only'] } })
    fakeHost.put(SID)
    expect(await sessionService.initAgent(SID)).toEqual({
      success: true,
      created: false,
      provider: 'custom-row',
      model: 'settings-model',
      capabilities: { reasoning: false },
      modelMetadata: { thinkingLevel: 'low' },
      workingDirectory: expect.any(String),
      enabledTools: ['mcp:settings-only']
    })
  })

  it('LA-D4 closed while the mirror says locked: initAgent peeks it open — a kept lock reports the lock; a lock cleared at that open (idle, earlier process) reports the settings with created false', async () => {
    seedSession({ id: SID, settings: { enabledTools: ['mcp:settings-only'], agentLocked: true } })
    fakeHost.storages.add(SID)
    fakeHost.configure = (reopened) => {
      reopened.lock = lockRecord({ model: { provider: 'anthropic', modelId: 'claude-x' } })
    }
    expect(await sessionService.initAgent(SID)).toMatchObject({
      created: true,
      provider: 'row-anthropic',
      model: 'claude-x'
    })
    expect(fakeHost.callsOf('peek')).toEqual([SID])
    expect(fakeHost.callsOf('open')).toEqual([])

    await fakeHost.close(SID)
    fakeHost.configure = undefined
    expect(await sessionService.initAgent(SID)).toMatchObject({
      created: false,
      provider: 'custom-row',
      model: 'settings-model',
      enabledTools: ['mcp:settings-only']
    })
    expect(fakeHost.callsOf('peek')).toEqual([SID, SID])
  })
})
