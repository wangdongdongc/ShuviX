/**
 * sessionService —— 会话启用哪几个知识库（`settings.knowledgeBases`）。
 *
 * 契约与并排的扩展能力勾选（sessionServiceEnabledTools.test.ts）**刻意相反**，所以这份用例
 * 与它共用同一套夹具：只有把两个写入口放在**同一时刻**对照，「不上锁」才说得清楚。
 *   - 扩展能力烤进 pi 的工具表，运行时存在（含创建中 / 关停中）期间 `updateEnabledTools` 一律拒绝；
 *   - 知识库不进工具表 —— `knowledge` 工具每次调用时由宿主按会话现查，所以
 *     `updateKnowledgeBases` 在**任何时刻**都接受、都落库、都广播，改完下一次调用就作数。
 *   - `create` **恒不写键**：知识库是一条活的回落链（会话 → 父会话 → 项目 → 缺省），
 *     写键就等于把缺省冻成快照，以后新建的库再也进不来。扩展能力则相反（恒写键），
 *     两者在同一次 create 里互为对照。
 *   - 写入是**整份替换**：去首尾空白、去空、去重保序，不按「这个库此刻在不在」过滤 ——
 *     库改了名还留在选择里，用的时候才发现；过滤掉就是永久丢项。
 *
 * mock 面照抄 sessionServiceEnabledTools.test.ts（import 图全换假件、真 SessionManager、
 * `AgentSession.create` 可捕获、sessionDao / projectDao 是一张内存行表）。
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
  broadcastSessionConfigChanged: vi.fn<(sessionId: string) => void>()
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
    updateTitle: vi.fn()
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
}

const sessions = new Map<string, MemSession>()
const projects = new Map<string, { id: string; path: string; settings: Record<string, unknown> }>()

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
    updatedAt: 0
  })
}

function seedProject(id: string, settings: Record<string, unknown> = {}): void {
  projects.set(id, { id, path: `/nonexistent/shuvix-unit/projects/${id}`, settings })
}

/** 最近一次 `create` 落库的 settings（insert 收到的那一份） */
const insertedSettings = (): Record<string, unknown> =>
  mocks.daoInsert.mock.calls.at(-1)![0].settings

/** 对 SID 那一行、带某个键的 updateSettings 写入值（按到达顺序） */
const writesOf = (id: string, key: string): unknown[] =>
  mocks.daoUpdateSettings.mock.calls
    .filter((c) => c[0] === id && key in (c[1] as Record<string, unknown>))
    .map((c) => (c[1] as Record<string, unknown>)[key])

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
  SID = `kb-${seq}`
  sessions.clear()
  projects.clear()
  for (const m of Object.values(mocks)) m.mockReset()

  mocks.daoPick.mockImplementation((id, cols) => pickCols(sessions.get(id), cols))
  mocks.daoPickSettings.mockImplementation((id, keys) => pickCols(sessions.get(id)?.settings, keys))
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

// ─── 写入口不上锁 ───────────────────────────────────────────────────────────

describe('SKB-1 写入口不上锁（与扩展能力同一时刻对照）', () => {
  it('SKB-1 创建在途 / 运行时存在 / 关停在途：知识库都写得进去，扩展能力同一时刻一律被拒', async () => {
    seedSession({ id: SID, settings: { enabledTools: [] } })
    const born = deferred<FakeAgent>()
    const closed = deferred()
    mocks.agentCreate.mockImplementationOnce(() => born.promise)

    /** 在当前这一刻同时打两个写入口：知识库该过，扩展能力该被拒且零写入 */
    const bothAt = (moment: string, base: string): void => {
      expect(sessionService.updateKnowledgeBases(SID, [base]), moment).toBe(true)
      expect(sessions.get(SID)!.settings.knowledgeBases, moment).toEqual([base])
      expect(sessionService.updateEnabledTools(SID, ['skill:a']), moment).toBe(false)
    }

    // ① 创建在途（ensure 同步登记）
    const p = sessionService.ensureAgentSession(SID)
    bothAt('creating', 'm1')
    await vi.waitFor(() => expect(mocks.agentCreate).toHaveBeenCalledTimes(1))

    // ② 运行时存在
    born.resolve(makeAgent(SID, () => closed.promise))
    await p
    expect((await sessionService.initAgent(SID)).created).toBe(true)
    bothAt('alive', 'm2')

    // ③ 关停在途
    const r = sessionService.invalidateAgent(SID)
    bothAt('closing', 'm3')
    closed.resolve()
    await r

    // 三次都落库、各广播一次；扩展能力那三次一个字都没写
    expect(writesOf(SID, 'knowledgeBases')).toEqual([['m1'], ['m2'], ['m3']])
    expect(writesOf(SID, 'enabledTools')).toEqual([])
    expect(mocks.broadcastSessionConfigChanged.mock.calls).toEqual([[SID], [SID], [SID]])
  })
})

// ─── create 恒不写键 ────────────────────────────────────────────────────────

describe('SKB-2 create 不盖快照', () => {
  it.each([
    ['不属于任何项目', (): unknown => sessionService.create({})],
    [
      '项目设过知识库',
      (): unknown => {
        seedProject('p1', { knowledgeBases: ['notes'], enabledTools: ['skill:a'] })
        return sessionService.create({ projectId: 'p1' })
      }
    ],
    [
      '子会话、父会话设过知识库',
      (): unknown => {
        seedSession({
          id: 'parent-row',
          settings: { knowledgeBases: ['notes'], enabledTools: ['skill:p'] }
        })
        return sessionService.create({ parentId: 'parent-row' })
      }
    ]
  ])('SKB-2 %s → 落库 settings 里没有 knowledgeBases 键', (_label, create) => {
    create()

    const settings = insertedSettings()
    // 写了键就等于把「此刻的缺省」冻成快照：以后新建的库再也进不来这条会话
    expect('knowledgeBases' in settings).toBe(false)
    // 对照：同一次 create 里扩展能力恒写键（它是快照，语义正相反）
    expect('enabledTools' in settings).toBe(true)
  })
})

// ─── 整份替换 ───────────────────────────────────────────────────────────────

describe('SKB-3 / 4 / 5 写入口 updateKnowledgeBases', () => {
  it('SKB-3 整份替换：去空白、去空、去重保序；不按「此刻在不在」过滤；广播一次', () => {
    seedSession({ id: SID, settings: { knowledgeBases: ['old'] } })

    expect(
      sessionService.updateKnowledgeBases(SID, ['  notes ', '', 'notes', 'gone', 'project'])
    ).toBe(true)
    // `gone` 此刻磁盘上并不存在 —— 照样落库：库改了名还留在选择里，用的时候才发现，
    // 在这里滤掉就是永久丢项（与扩展能力「不按可用性过滤」同一条理）
    expect(writesOf(SID, 'knowledgeBases')).toEqual([['notes', 'gone', 'project']])
    expect(sessions.get(SID)!.settings.knowledgeBases).toEqual(['notes', 'gone', 'project'])
    expect(mocks.broadcastSessionConfigChanged.mock.calls).toEqual([[SID]])
    expect(mocks.filterAvailableTools).not.toHaveBeenCalled()
  })

  it('SKB-4 空数组照写（与缺键不是一回事）', () => {
    seedSession({ id: SID, settings: { knowledgeBases: ['notes'] } })

    expect(sessionService.updateKnowledgeBases(SID, [])).toBe(true)
    // 缺键 = 还没选过（跟着回落链走）；`[]` = 明确选了「一个库都不用」
    expect(writesOf(SID, 'knowledgeBases')).toEqual([[]])
    expect('knowledgeBases' in sessions.get(SID)!.settings).toBe(true)
    expect(sessions.get(SID)!.settings.knowledgeBases).toEqual([])
  })

  it('SKB-5 会话不存在 → false，零写入零广播', () => {
    expect(sessionService.updateKnowledgeBases('no-such-session', ['notes'])).toBe(false)
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
    expect(mocks.broadcastSessionConfigChanged).not.toHaveBeenCalled()
  })
})
