/**
 * 扩展端**没有**会话级扩展能力（mcp:/skill: 勾选）—— ChatApi 适配器上的三处表态必须一致：
 *   - `session.updateEnabledTools` 恒 `success: false`，什么也不写（没有一次创建会读它）；
 *   - `agent.init().enabledTools` 恒为空（不是某个假勾选 —— chat-ui 会把它写进会话设置并据此展示）；
 *   - `tools.list` 里没有 MCP 分组、也没有 skills 分组 —— 输入框的工具选择器与会话设置的扩展能力卡
 *     正是按「一个条目都没有」自己隐藏的，这里冒出一项，扩展端就会出现一个永远写不进去的面板。
 *
 * mock 纪律同 agentRuntime.test.ts：适配器的 import 图带 IndexedDB / chrome.* / OPFS / DOM，
 * 在 node 环境下起不来，本地模块全部顶掉，只留纯函数（inlineTokens）用真件。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  resolveSessionMeta: vi.fn(),
  getRuntimeSession: vi.fn(),
  workingDirNameForSession: vi.fn()
}))

vi.mock('../../storage/messageStore', () => ({ messageStore: {} }))
vi.mock('../../storage/sessionStore', () => ({
  sessionStore: { updateSettings: mocks.updateSettings, getSettingsSync: () => ({}) }
}))
vi.mock('../../storage/settingsStore', () => ({ settingsStore: {} }))
vi.mock('../../storage/mcpStore', () => ({ mcpStore: { findAll: () => [] } }))
vi.mock('../../storage/projectStore', () => ({ projectStore: {} }))
vi.mock('../../storage/configShareStore', () => ({ configShareStore: {} }))
vi.mock('../mcpRuntime', () => ({ mcpManager: {} }))
vi.mock('../eventBus', () => ({ eventBus: { emit: vi.fn(), subscribe: vi.fn() } }))
vi.mock('../toolPresentations', () => ({ getToolPresentations: vi.fn() }))
vi.mock('../toolDefinitions', () => ({ getBuiltinToolDefinitions: vi.fn() }))
vi.mock('../agentRuntime', () => ({
  ensureRuntimeSession: vi.fn(),
  resolveSessionMeta: mocks.resolveSessionMeta,
  getRuntimeSession: mocks.getRuntimeSession,
  removeRuntimeSession: vi.fn(),
  setSessionModel: vi.fn()
}))
vi.mock('../subAgent', () => ({ subAgentManager: {} }))
vi.mock('../tabLease', () => ({ withTabLease: vi.fn() }))
vi.mock('@shuvix/agent-runtime', () => ({ validateShuvixMdText: vi.fn() }))
vi.mock('../titleRuntime', () => ({ titlerFor: vi.fn(), removeTitler: vi.fn() }))
vi.mock('../filesRuntime', () => ({
  filesRuntime: {},
  workingDirNameForSession: mocks.workingDirNameForSession
}))
vi.mock('../appEventBus', () => ({ appEventBus: { publish: vi.fn(), subscribe: vi.fn() } }))

import { chatApiAdapter } from '../chatApiAdapter'

const SID = 'ext-adapter-1'

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.resolveSessionMeta.mockResolvedValue({
    provider: 'fake-provider',
    model: 'fake-model',
    caps: {},
    modelMetadata: {}
  })
  mocks.getRuntimeSession.mockReturnValue(undefined)
  mocks.workingDirNameForSession.mockResolvedValue('')
})

describe('扩展端没有会话级扩展能力', () => {
  it('EXT-U-18 updateEnabledTools 恒 success:false 且不写库', async () => {
    const res = await chatApiAdapter.session.updateEnabledTools({
      id: SID,
      enabledTools: ['skill:a', 'mcp:b']
    })
    expect(res).toEqual({ success: false })
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('EXT-U-18 agent.init 回空勾选', async () => {
    const init = await chatApiAdapter.agent.init({ sessionId: SID })
    expect(init.success).toBe(true)
    expect(init.enabledTools).toEqual([])
  })

  it('EXT-U-18 tools.list 里没有 MCP / skills 分组的条目（选择器与扩展能力卡据此隐藏）', async () => {
    const tools = await chatApiAdapter.tools.list(SID)
    expect(tools.length).toBeGreaterThan(0)
    const extensionItems = tools.filter(
      (t) => t.group?.startsWith('mcp:') || t.group === '__skills__'
    )
    expect(extensionItems).toEqual([])
  })
})
