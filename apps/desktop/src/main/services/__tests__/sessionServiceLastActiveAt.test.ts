/**
 * sessionService —— lastActiveAt（用户动手）与 updatedAt（账本）拆开。
 *
 * 新建时三者同刻；之后改标题 / 挪项目 / 改会话设置都不再 touchActive
 * （日历按 session_day_prompts，lastActiveAt 只在用户消息入账时写）。
 * 补键、自动标题、pinAgentProfile 不在这里 —— 见并列的 Title / EnabledTools / Pin 用例。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  daoInsert: vi.fn(),
  daoUpdateProjectId: vi.fn(),
  daoUpdateSettings: vi.fn(),
  daoUpdateTitle: vi.fn(),
  daoPick: vi.fn(),
  daoPickSettings: vi.fn(),
  daoTouchActive: vi.fn(),
  buildAllowEntry: vi.fn((type: string, p: string) => `${type === 'read' ? 'Read' : 'Write'}(${p})`)
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
vi.mock('../../dao/sessionDayPromptDao', () => ({
  sessionDayPromptDao: { deleteBySessionId: vi.fn() }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: {} }))
vi.mock('../../dao/providerDao', () => ({ providerDao: {} }))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: vi.fn() } }))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: vi.fn() } }))
vi.mock('../messageService', () => ({ messageService: {} }))
vi.mock('../sessionStorage', () => ({
  readSessionRunConfig: vi.fn(),
  addSessionTreePin: vi.fn(),
  appendModelChange: vi.fn()
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({ getTempWorkspace: vi.fn(), getToolResultsBase: vi.fn() }))
vi.mock('../mcpService', () => ({ mcpService: { closeSession: vi.fn() } }))
vi.mock('../toolAggregator', () => ({
  filterAvailableTools: vi.fn((tools: string[]) => tools)
}))
vi.mock('../../utils/toolUtils/allowList', () => ({ buildAllowEntry: mocks.buildAllowEntry }))
vi.mock('../agentService', () => ({ agentService: { getProfile: vi.fn() } }))
vi.mock('../agentSession', () => ({ AgentSession: class {} }))
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
beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.buildAllowEntry.mockImplementation(
    (type: string, p: string) => `${type === 'read' ? 'Read' : 'Write'}(${p})`
  )
  mocks.daoPick.mockReturnValue({ id: 's1' })
  mocks.daoPickSettings.mockReturnValue({ allowList: [] })
})

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

  it('updateProjectId / updateAutoAllow / addAllowListPaths / removeAllowListEntry 不 touchActive', () => {
    sessionService.updateProjectId('s1', 'p2')
    sessionService.updateAutoAllow('s1', true)
    sessionService.addAllowListPaths('s1', 'read', ['/a'])
    sessionService.removeAllowListEntry('s1', 'Read(/a)')
    expect(mocks.daoTouchActive).not.toHaveBeenCalled()
  })

  it('addAllowListPaths 没有新条目时不 touchActive', () => {
    mocks.daoPickSettings.mockReturnValue({ allowList: ['Read(/a)'] })
    sessionService.addAllowListPaths('s1', 'read', ['/a'])
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
    expect(mocks.daoTouchActive).not.toHaveBeenCalled()
  })

  it('updateTitle / updateEnabledTools / updateKnowledgeBases 不 touchActive', () => {
    sessionService.updateTitle('s1', 'Renamed')
    expect(mocks.daoUpdateTitle).toHaveBeenCalledWith('s1', 'Renamed')
    expect(sessionService.updateEnabledTools('s1', ['skill:a'])).toBe(true)
    expect(sessionService.updateKnowledgeBases('s1', ['notes'])).toBe(true)
    expect(mocks.daoTouchActive).not.toHaveBeenCalled()
  })
})
