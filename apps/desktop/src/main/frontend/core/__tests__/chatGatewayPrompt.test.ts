/**
 * DefaultChatGateway.prompt 不入账：ensure 失败不会落树，网关本身也不 touchActive。
 * 日历入账只旁听 eventSink 的 user_message（见 sessionDayPrompt.test.ts）。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureAgentSession: vi.fn(),
  recordUserPrompt: vi.fn(),
  touchActive: vi.fn(),
  frontendBroadcast: vi.fn()
}))

vi.mock('../../../tools/allTools', () => ({}))
vi.mock('../../../services/toolRegistry', () => ({ getBuiltinToolEntries: () => [] }))
vi.mock('../../../services/sessionService', () => ({
  sessionService: {
    ensureAgentSession: mocks.ensureAgentSession,
    getAgentSession: vi.fn(),
    resolveAgentProfileName: vi.fn()
  }
}))
vi.mock('../../../services/messageService', () => ({ messageService: {} }))
vi.mock('../../../services/sessionStorage', () => ({
  appendModelChange: vi.fn(),
  appendThinkingLevelChange: vi.fn()
}))
vi.mock('../../../services/userInputBroker', () => ({ respondToUserInput: vi.fn() }))
vi.mock('../../../services/dbManager', () => ({ dbManager: { getConnectionInfo: vi.fn() } }))
vi.mock('../../../services/mcpService', () => ({ mcpService: { getAllToolInfos: () => [] } }))
vi.mock('../../../services/skillService', () => ({ skillService: { findEnabled: () => [] } }))
vi.mock('../../../dao/sessionDao', () => ({
  sessionDao: { findById: vi.fn(), touchActive: mocks.touchActive }
}))
vi.mock('../../../dao/projectDao', () => ({ projectDao: { pick: vi.fn() } }))
vi.mock('../../../services/agentService', () => ({ agentService: { getProfile: vi.fn() } }))
vi.mock('../ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: mocks.frontendBroadcast }
}))
vi.mock('../../../services/sessionDayPromptService', () => ({
  recordUserPrompt: mocks.recordUserPrompt,
  recordFromUserMessageEvent: vi.fn()
}))

let chatGateway: (typeof import('../DefaultChatGateway'))['chatGateway']

beforeAll(async () => {
  ;({ chatGateway } = await import('../DefaultChatGateway'))
})

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
})

describe('DefaultChatGateway.prompt 不入账', () => {
  it('ensure 失败：不入账、不 touchActive，只广播 error', async () => {
    mocks.ensureAgentSession.mockResolvedValue(undefined)
    const result = await chatGateway.prompt('s1', 'hello')
    expect(result).toEqual({ error: 'Agent 未初始化' })
    expect(mocks.frontendBroadcast).toHaveBeenCalledWith({
      type: 'error',
      sessionId: 's1',
      error: 'Agent 未初始化'
    })
    expect(mocks.recordUserPrompt).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
  })

  it('ensure 成功：发送交给 session.prompt，网关本身不入账、不 touchActive', async () => {
    const prompt = vi.fn(async () => ({}))
    mocks.ensureAgentSession.mockResolvedValue({ prompt })
    await chatGateway.prompt('s1', 'hello')
    expect(prompt).toHaveBeenCalled()
    expect(mocks.recordUserPrompt).not.toHaveBeenCalled()
    expect(mocks.touchActive).not.toHaveBeenCalled()
  })
})
