/**
 * 扩展端 ChatApi 的 MCP 命名空间 —— 与桌面 `ipc/mcpHandlers` 同一套惰性启动表态：
 * **增 / 改 / 删都不连**。连接只发生在装配工具那一刻（`ensureEnabled`）与用户手点连接时。
 *
 * 为什么要钉：改制前 add/update 里写着「启用了就（重）连」，于是打开设置页改一个 header 就会
 * 当场拉起一条连接 —— 惰性启动一旦在这里漏一处，后台连接就从「没有」变回「有一点」，
 * 而这种「一点」正是要根除的东西（首启 npx 冷启动卡住设置页、失败没人看见）。
 * update / delete 仍要**断开**：旧连接是按旧配置建的，留着就错了。
 *
 * mock 纪律同 chatApiAdapterExtensions.test.ts：适配器的 import 图带 IndexedDB / chrome.* / OPFS，
 * node 环境下起不来，本地模块一律顶掉；这里只额外把 mcpStore 与 mcpRuntime 换成可观测的替身。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn()
}))

vi.mock('../../storage/messageStore', () => ({ messageStore: {} }))
vi.mock('../../storage/sessionStore', () => ({
  sessionStore: { updateSettings: vi.fn(), getSettingsSync: () => ({}) }
}))
vi.mock('../../storage/settingsStore', () => ({ settingsStore: {} }))
vi.mock('../../storage/mcpStore', () => ({
  mcpStore: {
    findAll: () => [],
    add: mocks.add,
    update: mocks.update,
    delete: mocks.del
  }
}))
vi.mock('../../storage/projectStore', () => ({ projectStore: {} }))
vi.mock('../../storage/configShareStore', () => ({ configShareStore: {} }))
vi.mock('../mcpRuntime', () => ({
  mcpManager: {
    connect: mocks.connect,
    disconnect: mocks.disconnect,
    getStatus: () => 'disconnected',
    getError: () => undefined,
    getServerToolInfos: () => []
  }
}))
vi.mock('../eventBus', () => ({ eventBus: { emit: vi.fn(), subscribe: vi.fn() } }))
vi.mock('../toolPresentations', () => ({ getToolPresentations: vi.fn() }))
vi.mock('../toolDefinitions', () => ({ getBuiltinToolDefinitions: vi.fn() }))
vi.mock('../agentRuntime', () => ({
  ensureRuntimeSession: vi.fn(),
  resolveSessionMeta: vi.fn(),
  getRuntimeSession: vi.fn(),
  removeRuntimeSession: vi.fn(),
  setSessionModel: vi.fn()
}))
vi.mock('../subAgent', () => ({ subAgentManager: {} }))
vi.mock('../tabLease', () => ({ withTabLease: vi.fn() }))
vi.mock('@shuvix/agent-runtime', () => ({ validateShuvixMdText: vi.fn() }))
vi.mock('../titleRuntime', () => ({ titlerFor: vi.fn(), removeTitler: vi.fn() }))
vi.mock('../filesRuntime', () => ({ filesRuntime: {}, workingDirNameForSession: vi.fn() }))
vi.mock('../appEventBus', () => ({ appEventBus: { publish: vi.fn(), subscribe: vi.fn() } }))

import { chatApiAdapter } from '../chatApiAdapter'

const SERVER = { id: 'srv-1', name: 'e2e', isEnabled: 1 }

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.update.mockReturnValue(SERVER)
  mocks.connect.mockResolvedValue({ ok: true })
  mocks.disconnect.mockResolvedValue(undefined)
})

describe('扩展端 MCP：增改删都不连', () => {
  it('MCPL-U-16 add 只写库 —— 既不连也不断（新加的那台还没有任何连接）', async () => {
    const res = await chatApiAdapter.mcp.add({ name: 'e2e', type: 'http', url: 'http://x/mcp' })
    expect(res).toEqual({ success: true })
    expect(mocks.add).toHaveBeenCalledTimes(1)
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.disconnect).not.toHaveBeenCalled()
  })

  it('MCPL-U-16 update 只写库 + 断开旧连接，绝不重连', async () => {
    const res = await chatApiAdapter.mcp.update({ id: SERVER.id, isEnabled: true })
    expect(res).toEqual({ success: true })
    expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.disconnect).toHaveBeenCalledWith(SERVER.id)
  })

  it('MCPL-U-16 update 命中不存在的行：不写连接层（连断开都不发）', async () => {
    mocks.update.mockReturnValue(undefined)
    expect(await chatApiAdapter.mcp.update({ id: 'gone' })).toEqual({ success: true })
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.disconnect).not.toHaveBeenCalled()
  })

  it('MCPL-U-16 delete 先断开再删库，同样不连', async () => {
    const res = await chatApiAdapter.mcp.delete(SERVER.id)
    expect(res).toEqual({ success: true })
    expect(mocks.del).toHaveBeenCalledWith(SERVER.id)
    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('MCPL-U-16 手动连接仍走 connect —— 惰性不等于连不上', async () => {
    expect(await chatApiAdapter.mcp.connect(SERVER.id)).toEqual({ success: true })
    expect(mocks.connect).toHaveBeenCalledWith(SERVER.id)
  })
})
