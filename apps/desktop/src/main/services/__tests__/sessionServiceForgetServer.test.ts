/**
 * sessionService.forgetServerSelection —— 一台服务器永远没了（组件删除）：所有会话和项目的勾选里抹掉它。组件的勾选算读授权，
 * 留着的话，同 id 的新组件会继承这份同意。
 *
 *   FS-3 项目：有这一项的改（别的设置键不动）；没有这一项的不写（不刷 updatedAt）；归档了的也算；不是数组的不碰
 *   FS-4 只抹这一台的两种记号：前缀相同的别的组件不动，加项和取消记号都抹
 *   FS-5 改了的会话各广播一次 session.configChanged（开着的界面才不会把旧的整份写回来）；没改的不广播
 *   FS-6 改了的会话当场重配（锁里摘掉，同 id 的新组件开启时不沿用旧声明），重配时读到的已经是抹过的；没改的不碰
 *   FS-7 某一条的重配失败 / 抛错：不拒绝，别的会话照样处理
 *
 * mock 面照抄 sessionServiceEnableServer.test.ts。sessionRecords 用真的（它的内存会话与坏行那一面在 sessionRecordsEphemeral.test）。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeHost, lockRecord, resetFakeHost } from './support/fakeSessionHost'

const mocks = vi.hoisted(() => ({
  daoPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  daoPickSettings: vi.fn<(id: string, keys: string[]) => unknown>(),
  daoUpdateSettings: vi.fn<(id: string, patch: Record<string, unknown>) => void>(),
  daoFindById: vi.fn<(id: string) => unknown>(),
  daoFindAll: vi.fn<() => unknown[]>(),
  projectPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  projectFindAll: vi.fn<() => unknown[]>(),
  projectUpdate: vi.fn<(id: string, fields: Record<string, unknown>) => void>(),
  getProfile: vi.fn<(name: string) => unknown>(),
  broadcastSessionConfigChanged: vi.fn<(sessionId: string) => void>(),
  warn: vi.fn<(message: string) => void>()
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    pick: mocks.daoPick,
    pickSettings: mocks.daoPickSettings,
    updateSettings: mocks.daoUpdateSettings,
    insert: vi.fn(),
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
vi.mock('../sessionDayPromptService', () => ({
  recordUserEntry: vi.fn(),
  recordSessionCreated: vi.fn()
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: vi.fn() } }))
vi.mock('../../dao/providerDao', () => ({
  providerDao: {
    findModelsByProvider: vi.fn(() => []),
    findEnabled: vi.fn(() => []),
    findEnabledModels: vi.fn(() => [])
  }
}))
vi.mock('../../dao/projectDao', () => ({
  projectDao: {
    pick: mocks.projectPick,
    findAll: mocks.projectFindAll,
    update: mocks.projectUpdate
  }
}))
vi.mock('../models', () => ({
  getModelRegistry: vi.fn(),
  providerCredentialPort: { listProviders: vi.fn(() => []) }
}))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: vi.fn() } }))
vi.mock('../messageService', () => ({ messageService: { clear: vi.fn() } }))
vi.mock('../sessionStorage', () => ({
  isDurableSession: () => true,
  readSessionRunConfig: vi.fn(async () => ({})),
  recordSessionModel: vi.fn(async () => {})
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: (sid: string) => `/nonexistent/shuvix-unit/tmp/${sid}`,
  getToolResultsBase: () => '/nonexistent/shuvix-unit/tool-results'
}))
vi.mock('../mcpService', () => ({ mcpService: { closeSession: vi.fn() } }))
vi.mock('../toolAggregator', () => ({
  filterAvailableTools: vi.fn((tools: string[]) => tools)
}))
vi.mock('../acl', () => ({ sessionAcl: { initialize: vi.fn(), deleteSession: vi.fn() } }))
vi.mock('../agentService', () => ({
  agentService: { getProfile: mocks.getProfile }
}))
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
  chatFrontendRegistry: { broadcast: vi.fn() }
}))
vi.mock('../userInputBroker', () => ({ registerUserInputParticipant: vi.fn() }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: mocks.warn, error: () => {} })
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
  name: string
  settings: Record<string, unknown>
  archivedAt: number
}

const sessions = new Map<string, MemSession>()
const projects = new Map<string, MemProject>()

function pickCols(row: object | undefined, cols: readonly string[]): unknown {
  if (!row) return undefined
  const source = row as Record<string, unknown>
  return Object.fromEntries(cols.map((c) => [c, structuredClone(source[c])]))
}

function seedSession(id: string, settings: Record<string, unknown>): void {
  sessions.set(id, {
    id,
    title: id,
    projectId: null,
    parentId: null,
    settings,
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: 0
  })
}

function seedProject(id: string, settings: Record<string, unknown>, archivedAt = 0): void {
  projects.set(id, { id, name: id, settings, archivedAt })
}

const toolsOf = (id: string): unknown => sessions.get(id)!.settings.enabledTools

const TICK = 'mcp:widget-a-b'
const OPT_OUT = '-mcp:widget-a-b'

beforeEach(() => {
  sessions.clear()
  projects.clear()
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.daoPick.mockImplementation((id, cols) => pickCols(sessions.get(id), cols))
  mocks.daoPickSettings.mockImplementation((id, keys) => pickCols(sessions.get(id)?.settings, keys))
  mocks.daoUpdateSettings.mockImplementation((id, patch) => {
    const row = sessions.get(id)
    if (row) row.settings = { ...row.settings, ...structuredClone(patch) }
  })
  mocks.daoFindById.mockImplementation((id) => structuredClone(sessions.get(id)))
  mocks.daoFindAll.mockImplementation(() => structuredClone([...sessions.values()]))
  mocks.projectPick.mockReturnValue(undefined)
  mocks.projectFindAll.mockImplementation(() => structuredClone([...projects.values()]))
  mocks.projectUpdate.mockImplementation((id, fields) => {
    const row = projects.get(id)
    if (row) Object.assign(row, structuredClone(fields))
  })
  mocks.getProfile.mockImplementation((name) => ({
    name,
    tools: [],
    promptBlocks: []
  }))
  resetFakeHost()
})

describe('forgetServerSelection', () => {
  it('FS-3 项目：有这一项的抹掉（别的设置键不动）；没有的不写；归档了的也算；不是数组的不碰', async () => {
    seedProject('with', { enabledTools: ['mcp:x', TICK, OPT_OUT], knowledgeBases: ['kb'] })
    seedProject('archived', { enabledTools: [TICK] }, 123)
    seedProject('without', { enabledTools: ['mcp:x'] })
    seedProject('none', { knowledgeBases: ['kb'] })
    seedProject('not-array', { enabledTools: TICK })

    await sessionService.forgetServerSelection('widget-a-b')

    expect(mocks.projectUpdate.mock.calls.map((call) => call[0]).sort()).toEqual([
      'archived',
      'with'
    ])
    expect(projects.get('with')!.settings).toEqual({
      enabledTools: ['mcp:x'],
      knowledgeBases: ['kb']
    })
    expect(projects.get('archived')!.settings).toEqual({ enabledTools: [] })
    expect(projects.get('not-array')!.settings).toEqual({ enabledTools: TICK })
  })

  it('FS-4 只抹这一台的两种记号：前缀相同的别的组件、别的服务器都不动，次序不变', async () => {
    seedSession('s1', {
      enabledTools: ['mcp:browser', TICK, 'mcp:widget-a-b-c', OPT_OUT, '-mcp:widget-a-b-c'],
      model: 'm'
    })

    await sessionService.forgetServerSelection('widget-a-b')

    expect(sessions.get('s1')!.settings).toEqual({
      enabledTools: ['mcp:browser', 'mcp:widget-a-b-c', '-mcp:widget-a-b-c'],
      model: 'm'
    })
    expect(sessionService.rootToolState('s1').selection).not.toContain(TICK)
  })

  it('FS-5 改了的会话各广播一次；没改的不广播、不写', async () => {
    seedSession('s1', { enabledTools: [TICK] })
    seedSession('s2', { enabledTools: [OPT_OUT, 'mcp:x'] })
    seedSession('s3', { enabledTools: ['mcp:x'] })
    seedSession('s4', {})

    await sessionService.forgetServerSelection('widget-a-b')

    expect(mocks.broadcastSessionConfigChanged.mock.calls.map((call) => call[0]).sort()).toEqual([
      's1',
      's2'
    ])
    expect(mocks.daoUpdateSettings.mock.calls.map((call) => call[0]).sort()).toEqual(['s1', 's2'])
    expect(toolsOf('s1')).toEqual([])
    expect(toolsOf('s2')).toEqual(['mcp:x'])
  })

  it('FS-6 改了的会话当场重配，重配时读到的已经是抹过的；没改的不重配', async () => {
    seedSession('s1', { enabledTools: [TICK] })
    seedSession('s2', { enabledTools: ['mcp:x'] })
    const affected = fakeHost.put('s1', { lock: lockRecord() })
    const untouched = fakeHost.put('s2', { lock: lockRecord() })
    const seen: unknown[] = []
    const reconfigure = vi.spyOn(affected, 'reconfigureAgent').mockImplementation(async () => {
      seen.push(structuredClone(toolsOf('s1')))
      return { applied: true, record: affected.lock! }
    })
    const other = vi.spyOn(untouched, 'reconfigureAgent')

    await sessionService.forgetServerSelection('widget-a-b')

    expect(reconfigure).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([[]])
    expect(other).not.toHaveBeenCalled()
  })

  it('FS-6 等重配落定才算完（调用方 await 得到「已经摘掉了」）', async () => {
    seedSession('s1', { enabledTools: [TICK] })
    const session = fakeHost.put('s1', { lock: lockRecord() })
    let finish: () => void = () => {}
    vi.spyOn(session, 'reconfigureAgent').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ applied: true, record: session.lock! })
        })
    )
    let done = false
    const forgetting = sessionService.forgetServerSelection('widget-a-b').then(() => {
      done = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(done).toBe(false)
    finish()
    await forgetting
    expect(done).toBe(true)
  })

  it('FS-7 一条的重配抛错：不拒绝，别的会话照样重配，记一条 warn；勾选都已抹掉', async () => {
    seedSession('s1', { enabledTools: [TICK] })
    seedSession('s2', { enabledTools: [TICK] })
    const bad = fakeHost.put('s1', { lock: lockRecord() })
    const good = fakeHost.put('s2', { lock: lockRecord() })
    vi.spyOn(bad, 'reconfigureAgent').mockRejectedValue(new Error('boom'))
    const reconfigured = vi
      .spyOn(good, 'reconfigureAgent')
      .mockImplementation(async () => ({ applied: true, record: good.lock! }))

    await expect(sessionService.forgetServerSelection('widget-a-b')).resolves.toBeUndefined()

    expect(reconfigured).toHaveBeenCalledTimes(1)
    expect(mocks.warn.mock.calls.some(([line]) => line.includes('boom'))).toBe(true)
    expect(toolsOf('s1')).toEqual([])
    expect(toolsOf('s2')).toEqual([])
  })

  it('FS-7 没有 agent 的会话：只抹勾选、广播，不打开任何东西', async () => {
    seedSession('s1', { enabledTools: [TICK] })
    await sessionService.forgetServerSelection('widget-a-b')
    expect(toolsOf('s1')).toEqual([])
    expect(mocks.broadcastSessionConfigChanged).toHaveBeenCalledTimes(1)
  })
})
