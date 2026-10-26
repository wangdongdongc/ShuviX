/**
 * sessionService —— lastActiveAt（用户动手）与 updatedAt（账本）拆开。
 *
 * 新建时三者同刻；之后改标题 / 挪项目 / 改会话设置 / 改会话权限表（services/acl 的授予、改访问方式、删除）
 * 都不再 touchActive（日历按 session_day_prompts，lastActiveAt 只在用户消息入账时写）—— 改扩展能力时当场重配锁住的
 * agent（2026-10-26）也一样。权限表是真的，
 * 只替掉它底下的 dao/sessionAclDao（spy）与派生行的来源（acl/derive：一个都不派生）。
 * 补键、自动标题、pinAgentProfile 不在这里 —— 见并列的 Title / EnabledTools / Pin 用例。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { fakeHost, lockRecord, resetFakeHost } from './support/fakeSessionHost'

const mocks = vi.hoisted(() => ({
  daoInsert: vi.fn(),
  daoUpdateProjectId: vi.fn(),
  daoUpdateSettings: vi.fn(),
  daoUpdateTitle: vi.fn(),
  daoPick: vi.fn(),
  daoPickSettings: vi.fn(),
  daoTouchActive: vi.fn(),
  aclFindBySession: vi.fn((_sid: string): unknown[] => []),
  aclInsert: vi.fn(),
  aclUpdateAccess: vi.fn((): boolean => true),
  aclDeleteById: vi.fn((): boolean => true)
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    insert: mocks.daoInsert,
    updateProjectId: mocks.daoUpdateProjectId,
    updateSettings: mocks.daoUpdateSettings,
    updateTitle: mocks.daoUpdateTitle,
    pick: mocks.daoPick,
    pickSettings: mocks.daoPickSettings,
    touchActive: mocks.daoTouchActive,
    findChildren: () => []
  }
}))
vi.mock('../../dao/sessionAclDao', () => ({
  sessionAclDao: {
    findBySession: mocks.aclFindBySession,
    insert: mocks.aclInsert,
    updateAccess: mocks.aclUpdateAccess,
    deleteById: mocks.aclDeleteById,
    deleteBySession: vi.fn(),
    transaction: <T>(fn: () => T): T => fn()
  }
}))
vi.mock('../acl/derive', () => ({
  derivePathEntries: () => [],
  derivedKey: (e: { source: string; sourceKey: string; target: string }) =>
    `${e.source}\u0000${e.sourceKey}\u0000${e.target}`
}))
vi.mock('../../dao/sessionDayPromptDao', () => ({
  sessionDayPromptDao: { deleteBySessionId: vi.fn() }
}))
vi.mock('../sessionDayPromptService', () => ({
  recordUserEntry: vi.fn(),
  recordSessionCreated: vi.fn()
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: {} }))
vi.mock('../../dao/providerDao', () => ({ providerDao: {} }))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: vi.fn() } }))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: vi.fn() } }))
vi.mock('../messageService', () => ({ messageService: {} }))
vi.mock('../sessionStorage', () => ({
  isDurableSession: () => true,
  readSessionRunConfig: vi.fn(),
  recordSessionModel: vi.fn()
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: vi.fn(),
  getToolResultsBase: vi.fn(),
  isSafeSessionId: (id: string) => !!id && !/[/\\]/.test(id) && !id.includes('..')
}))
vi.mock('../mcpService', () => ({ mcpService: { closeSession: vi.fn() } }))
vi.mock('../toolAggregator', () => ({
  filterAvailableTools: vi.fn((tools: string[]) => tools)
}))
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
let sessionAcl: (typeof import('../acl'))['sessionAcl']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
  ;({ sessionAcl } = await import('../acl'))
})
beforeEach(() => {
  // mockReset 回到 vi.fn(impl) 的缺省实现
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.daoPick.mockReturnValue({ id: 's1' })
  mocks.daoPickSettings.mockReturnValue({})
  sessionAcl.forgetReconciled()
  resetFakeHost()
})

/** s1 的权限表里已有一条授予的读（sessionAclDao 读出来的就是它） */
const grantedRow = {
  id: 'acl-1',
  sessionId: 's1',
  kind: 'path',
  target: '/a',
  access: 'read',
  source: 'user',
  sourceKey: '',
  createdAt: 1,
  updatedAt: 1
}

describe('lastActiveAt', () => {
  it('create：lastActiveAt === createdAt === updatedAt', () => {
    sessionService.create()
    const row = mocks.daoInsert.mock.calls[0][0] as {
      createdAt: number
      updatedAt: number
      lastActiveAt: number
    }
    expect(row.lastActiveAt).toBe(row.createdAt)
    expect(row.updatedAt).toBe(row.createdAt)
  })

  it('updateProjectId / 权限表的授予、改访问方式、删除 不 touchActive', () => {
    sessionService.updateProjectId('s1', 'p2')
    expect(sessionAcl.grantPath('s1', '/b', 'read')).not.toBeNull()
    expect(mocks.aclInsert).toHaveBeenCalledTimes(1)

    mocks.aclFindBySession.mockReturnValue([grantedRow])
    expect(sessionAcl.setAccess('s1', 'acl-1', 'write')).toBe(true)
    expect(sessionAcl.remove('s1', 'acl-1')).toBe(true)
    expect(mocks.aclUpdateAccess).toHaveBeenCalledTimes(1)
    expect(mocks.aclDeleteById).toHaveBeenCalledTimes(1)
    expect(mocks.daoTouchActive).not.toHaveBeenCalled()
    // 权限表不在会话设置里：会话行一笔都没写
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
  })

  it('授予一条已有的路径（同样的访问方式）：表不写、不 touchActive', () => {
    mocks.aclFindBySession.mockReturnValue([grantedRow])
    expect(sessionAcl.grantPath('s1', '/a', 'read')).toMatchObject({ id: 'acl-1' })
    expect(mocks.aclInsert).not.toHaveBeenCalled()
    expect(mocks.aclUpdateAccess).not.toHaveBeenCalled()
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
    expect(mocks.daoTouchActive).not.toHaveBeenCalled()
  })

  it('updateTitle / updateEnabledTools / updateKnowledgeBases 不 touchActive', async () => {
    sessionService.updateTitle('s1', 'Renamed')
    expect(mocks.daoUpdateTitle).toHaveBeenCalledWith('s1', 'Renamed')
    expect(await sessionService.updateEnabledTools('s1', ['skill:a'])).toBe(true)
    expect(sessionService.updateKnowledgeBases('s1', ['notes'])).toBe(true)
    expect(mocks.daoTouchActive).not.toHaveBeenCalled()
  })

  it('updateEnabledTools 当场重配锁住的 agent：也不 touchActive', async () => {
    const session = fakeHost.put('s1', { lock: lockRecord() })
    expect(await sessionService.updateEnabledTools('s1', ['skill:a'])).toBe(true)
    expect(session.callsOf('reconfigureAgent')).toHaveLength(1)
    expect(mocks.daoTouchActive).not.toHaveBeenCalled()
  })
})
