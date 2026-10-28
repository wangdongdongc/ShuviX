/**
 * sessionService —— 会话启用哪几个知识库（`settings.knowledgeBases`）。
 *
 * 契约与并排的扩展能力勾选（sessionServiceEnabledTools.test.ts）共用同一套夹具，在**同一时刻**对照两个写入口：
 *   - 扩展能力烤进 pi 的工具表：运行时存在期间 `updateEnabledTools` 照样接受（2026-10-26 起），但要把改动交给
 *     那个 agent **重配**（会话开着 → 交给它；没开但锁镜像说锁着 → peek）；
 *   - 知识库不进工具表 —— `knowledge` 工具每次调用时由宿主按会话现查，所以
 *     `updateKnowledgeBases` 在**任何时刻**都接受、都落库、都广播，改完下一次调用就作数，**从不重配**。
 *   - `create` **恒不写键**：知识库是一条活的回落链（会话 → 父会话 → 项目 → 缺省），
 *     写键就等于把缺省冻成快照，以后新建的库再也进不来。扩展能力则相反（恒写键），
 *     两者在同一次 create 里互为对照。
 *   - 写入是**整份替换**：去首尾空白、去空、去重保序，不按「这个库此刻在不在」过滤 ——
 *     库改了名还留在选择里，用的时候才发现；过滤掉就是永久丢项。
 *
 * mock 面照抄 sessionServiceEnabledTools.test.ts（import 图全换假件、会话运行时换成假宿主、
 * sessionDao / projectDao 是一张内存行表）。
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
  findModelsByProvider: vi.fn(() => []),
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
vi.mock('../sessionDayPromptService', () => ({
  recordUserEntry: vi.fn(),
  recordSessionCreated: vi.fn()
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
// 会话权限表（services/acl）不在这组用例里：建会话时的生成、删会话时的清理换成空操作
vi.mock('../acl', () => ({ sessionAcl: { initialize: vi.fn(), deleteSession: vi.fn() } }))
vi.mock('../agentService', () => ({ agentService: { getProfile: vi.fn() } }))
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

/** 对 SID 那一行、带某个键的 updateSettings 写入值（按到达顺序） */
const writesOf = (id: string, key: string): unknown[] =>
  mocks.daoUpdateSettings.mock.calls
    .filter((c) => c[0] === id && key in (c[1] as Record<string, unknown>))
    .map((c) => (c[1] as Record<string, unknown>)[key])

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
  resetFakeHost()
})

// ─── 写入口不上锁 ───────────────────────────────────────────────────────────

describe('SKB-1 写入口不上锁（与扩展能力同一时刻对照）', () => {
  it('SKB-1 锁着（会话开着 / 没开但锁镜像为真）/ 销毁在途：知识库都写得进去且从不重配；扩展能力同一时刻也写得进去，会话开着时交给 agent 重配', async () => {
    seedSession({ id: SID, settings: { enabledTools: [] } })

    /** 在当前这一刻同时打两个写入口：都该过；知识库那一笔不碰运行时 */
    const bothAt = async (moment: string, base: string, tool: string): Promise<void> => {
      const reconfiguresBefore = fakeHost.get(SID)?.callsOf('reconfigureAgent').length ?? 0
      expect(sessionService.updateKnowledgeBases(SID, [base]), moment).toBe(true)
      expect(sessions.get(SID)!.settings.knowledgeBases, moment).toEqual([base])
      expect(
        fakeHost.get(SID)?.callsOf('reconfigureAgent').length ?? 0,
        `${moment}: knowledge bases never reconfigure`
      ).toBe(reconfiguresBefore)
      expect(await sessionService.updateEnabledTools(SID, [tool]), moment).toBe(true)
      expect(sessions.get(SID)!.settings.enabledTools, moment).toEqual([tool])
    }

    // ① 没开着，但锁镜像说有 agent（上一次进程里建的）；存储不在 → 扩展能力的 peek 落空，没有可重配的
    sessions.get(SID)!.settings.agentLocked = true
    await bothAt('closed-locked', 'm1', 'mcp:a')
    expect(fakeHost.callsOf('peek')).toEqual([SID])

    // ② 开着、锁着（锁以运行时为准）：扩展能力那一笔交给它重配
    const session = fakeHost.put(SID, { lock: lockRecord() })
    expect((await sessionService.initAgent(SID)).created).toBe(true)
    await bothAt('alive', 'm2', 'mcp:b')
    expect(session.callsOf('reconfigureAgent')).toHaveLength(1)

    // ③ 销毁在途（锁还在，直到运行时把它清掉）
    const release = gate()
    session.destroyGate = release
    const r = sessionService.invalidateAgent(SID)
    await bothAt('closing', 'm3', 'mcp:c')
    expect(session.callsOf('reconfigureAgent')).toHaveLength(2)
    release.release()
    await r
    expect(session.lock).toBeUndefined()

    // 三个时刻两个写入口都落库、各广播一次
    expect(writesOf(SID, 'knowledgeBases')).toEqual([['m1'], ['m2'], ['m3']])
    expect(writesOf(SID, 'enabledTools')).toEqual([['mcp:a'], ['mcp:b'], ['mcp:c']])
    expect(mocks.broadcastSessionConfigChanged).toHaveBeenCalledTimes(6)
  })
})

// ─── create 恒不写键 ────────────────────────────────────────────────────────

describe('SKB-2 create 不盖快照', () => {
  it.each([
    ['不属于任何项目', (): unknown => sessionService.create({})],
    [
      '项目设过知识库',
      (): unknown => {
        seedProject('p1', { knowledgeBases: ['notes'], enabledTools: ['mcp:a'] })
        return sessionService.create({ projectId: 'p1' })
      }
    ],
    [
      '子会话、父会话设过知识库',
      (): unknown => {
        seedSession({
          id: 'parent-row',
          settings: { knowledgeBases: ['notes'], enabledTools: ['mcp:p'] }
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
    expect(mocks.daoTouchActive).not.toHaveBeenCalled()
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
