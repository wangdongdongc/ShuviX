/**
 * sessionService —— `tool_search` 用的三个入口：`rootToolState`、`enableServer`、`lockedServerTools`。
 *
 *   ES-1 rootToolState：档案声明 + 勾选 - 取消（与创建、重配同一条归一规则）；selection 是存着的原样；optedOut 是取消的那些
 *   ES-2 enableServer 现读勾选：卡片等待时用户勾上的不丢；不重复；取消记号撤掉；只写一次、重配一次
 *   ES-3 答的是锁里这台的工具声明：不在锁里 / 重配被取消 → undefined，勾选留着；名字 `constructor` → undefined（只认自有属性）
 *
 * mock 面照抄 sessionServiceReconfigure.test.ts（import 图全换假件、会话运行时换成假宿主、sessionDao / projectDao
 * 是一张内存行表），档案替身（agentService.getProfile）在这里可按用例定工具名单。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCreationError } from '@shuvix/agent-runtime'
import { fakeHost, lockRecord, resetFakeHost } from './support/fakeSessionHost'

const mocks = vi.hoisted(() => ({
  daoPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  daoPickSettings: vi.fn<(id: string, keys: string[]) => unknown>(),
  daoUpdateSettings: vi.fn<(id: string, patch: Record<string, unknown>) => void>(),
  daoFindById: vi.fn<(id: string) => unknown>(),
  projectPick: vi.fn<(id: string, cols: string[]) => unknown>(),
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
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: mocks.projectPick } }))
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

const sessions = new Map<string, MemSession>()

function pickCols(row: object | undefined, cols: readonly string[]): unknown {
  if (!row) return undefined
  const source = row as Record<string, unknown>
  return Object.fromEntries(cols.map((c) => [c, structuredClone(source[c])]))
}

const SID = 'es-1'

function seedSession(enabledTools: string[] = []): void {
  sessions.set(SID, {
    id: SID,
    title: SID,
    projectId: null,
    parentId: null,
    settings: { enabledTools },
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: 0
  })
}

const stored = (): unknown => sessions.get(SID)!.settings.enabledTools
const writes = (): unknown[][] => mocks.daoUpdateSettings.mock.calls.filter((c) => c[0] === SID)

const DECLS = [{ name: 'list_tabs', description: 'List tabs.', parameters: { type: 'object' } }]

function profileWithTools(tools: string[]): void {
  mocks.getProfile.mockImplementation((name) => ({
    name,
    tools,
    promptBlocks: []
  }))
}

beforeEach(() => {
  sessions.clear()
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.daoPick.mockImplementation((id, cols) => pickCols(sessions.get(id), cols))
  mocks.daoPickSettings.mockImplementation((id, keys) => pickCols(sessions.get(id)?.settings, keys))
  mocks.daoUpdateSettings.mockImplementation((id, patch) => {
    const row = sessions.get(id)
    if (row) row.settings = { ...row.settings, ...structuredClone(patch) }
  })
  mocks.daoFindById.mockImplementation((id) => structuredClone(sessions.get(id)))
  mocks.projectPick.mockReturnValue(undefined)
  profileWithTools([])
  resetFakeHost()
})

describe('ES-1 rootToolState', () => {
  it('ES-1 档案声明 + 勾选 - 取消；selection 原样；optedOut 是取消的那些', () => {
    profileWithTools(['bash', 'mcp:declared', 'mcp:unticked'])
    seedSession(['mcp:ticked', '-mcp:unticked'])

    const state = sessionService.rootToolState(SID)

    expect(state.names).toEqual(['bash', 'mcp:declared', 'mcp:ticked'])
    expect(state.selection).toEqual(['mcp:ticked', '-mcp:unticked'])
    expect([...state.optedOut]).toEqual(['mcp:unticked'])
  })

  it('ES-1 按会话形态推导的档案：没有项目的会话读 chat', () => {
    profileWithTools(['tool_search'])
    seedSession()

    expect(sessionService.rootToolState(SID).names).toEqual(['tool_search'])
    expect(mocks.getProfile).toHaveBeenCalledWith('chat')
  })

  it('ES-1 取消一个档案没声明的项什么也不做；内置名混进勾选也进不来', () => {
    profileWithTools(['bash'])
    seedSession(['-mcp:never', 'read', 'mcp:ticked'])

    const state = sessionService.rootToolState(SID)

    expect(state.names).toEqual(['bash', 'mcp:ticked'])
    // 不是勾选能有的条目（内置工具名）在读的时候就滤掉了
    expect(state.selection).toEqual(['-mcp:never', 'mcp:ticked'])
    expect([...state.optedOut]).toEqual(['mcp:never'])
  })

  it('ES-1 档案找不到 → 只有勾选；会话不存在 → 全空', () => {
    mocks.getProfile.mockReturnValue(undefined)
    seedSession(['mcp:ticked'])
    expect(sessionService.rootToolState(SID).names).toEqual(['mcp:ticked'])

    const missing = sessionService.rootToolState('no-such-session')
    expect(missing.names).toEqual([])
    expect(missing.selection).toEqual([])
    expect(missing.optedOut.size).toBe(0)
  })
})

describe('ES-2 enableServer 现读勾选', () => {
  it('ES-2 卡片等待时用户勾上的不丢：读的是调用那一刻的设置', async () => {
    seedSession(['mcp:a'])
    fakeHost.put(SID, { lock: lockRecord({ mcp: { target: DECLS as never } }) })
    // 工具算预判时读到的是这一份
    expect(sessionService.rootToolState(SID).selection).toEqual(['mcp:a'])
    // 卡片等着的时候，用户在选择器里勾了一台
    await sessionService.updateEnabledTools(SID, ['mcp:a', 'mcp:b'])
    mocks.daoUpdateSettings.mockClear()

    await sessionService.enableServer(SID, 'target')

    expect(stored()).toEqual(['mcp:a', 'mcp:b', 'mcp:target'])
    expect(writes()).toHaveLength(1)
  })

  it('ES-2 已经勾着 → 不重复', async () => {
    seedSession(['mcp:target', 'mcp:a'])
    fakeHost.put(SID, { lock: lockRecord() })

    await sessionService.enableServer(SID, 'target')

    const tools = stored() as string[]
    expect(tools.filter((entry) => entry === 'mcp:target')).toHaveLength(1)
    expect(new Set(tools)).toEqual(new Set(['mcp:target', 'mcp:a']))
  })

  it('ES-2 取消记号撤掉', async () => {
    seedSession(['-mcp:target', 'mcp:a'])
    fakeHost.put(SID, { lock: lockRecord() })

    await sessionService.enableServer(SID, 'target')

    expect(stored()).toEqual(['mcp:a', 'mcp:target'])
  })

  it('ES-2 只写一次、广播一次、重配一次，重配在写之后', async () => {
    seedSession(['mcp:a'])
    const session = fakeHost.put(SID, { lock: lockRecord() })
    const reconfigure = vi.spyOn(session, 'reconfigureAgent')

    await sessionService.enableServer(SID, 'target')

    expect(writes()).toEqual([[SID, { enabledTools: ['mcp:a', 'mcp:target'] }]])
    expect(mocks.broadcastSessionConfigChanged.mock.calls).toEqual([[SID]])
    expect(session.callsOf('reconfigureAgent')).toHaveLength(1)
    expect(reconfigure.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.daoUpdateSettings.mock.invocationCallOrder[0]
    )
  })
})

describe('ES-3 答的是这台真的接上了没有', () => {
  it('ES-3 重配之后锁里有它 → 回它的工具声明（lockedServerTools 同一份）', async () => {
    seedSession()
    const session = fakeHost.put(SID, { lock: lockRecord() })
    vi.spyOn(session, 'reconfigureAgent').mockImplementation(async () => {
      session.lock = lockRecord({ mcp: { target: DECLS as never } })
      return { applied: true, record: session.lock }
    })

    expect(await sessionService.enableServer(SID, 'target')).toEqual(DECLS)
    expect(sessionService.lockedServerTools(SID, 'target')).toEqual(DECLS)
  })

  it('ES-3 锁里没有它（连不上、或没有锁）→ undefined，勾选留着', async () => {
    seedSession(['mcp:a'])
    fakeHost.put(SID, { lock: lockRecord({ mcp: { other: DECLS as never } }) })

    expect(await sessionService.enableServer(SID, 'target')).toBeUndefined()
    expect(stored()).toEqual(['mcp:a', 'mcp:target'])
  })

  it('ES-3 会话开着但没有锁 → undefined，勾选留着（下一次创建按它建）', async () => {
    seedSession()
    fakeHost.put(SID)

    expect(await sessionService.enableServer(SID, 'target')).toBeUndefined()
    expect(stored()).toEqual(['mcp:target'])
  })

  it('ES-3 重配被取消 → undefined，勾选留着，不抛', async () => {
    seedSession()
    fakeHost.put(SID, {
      lock: lockRecord(),
      reconfigureError: new AgentCreationError('cancelled', 'cancelled by destroy')
    })

    expect(await sessionService.enableServer(SID, 'target')).toBeUndefined()
    expect(stored()).toEqual(['mcp:target'])
    expect(mocks.warn).not.toHaveBeenCalled()
  })

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'ES-3 名字 %s 不从原型上捡：undefined',
    async (name) => {
      seedSession()
      fakeHost.put(SID, { lock: lockRecord({ mcp: { other: DECLS as never } }) })

      expect(sessionService.lockedServerTools(SID, name)).toBeUndefined()
      expect(await sessionService.enableServer(SID, name)).toBeUndefined()
    }
  )

  it('ES-3 lockedServerTools：会话没开着 → undefined，不碰宿主的 open / peek', () => {
    seedSession()
    expect(sessionService.lockedServerTools(SID, 'target')).toBeUndefined()
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.callsOf('peek')).toEqual([])
  })
})
