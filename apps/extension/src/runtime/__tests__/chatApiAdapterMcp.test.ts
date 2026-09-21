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
  findById: vi.fn(),
  nameProblem: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  closeSession: vi.fn(),
  removeRuntimeSession: vi.fn(),
  removeTitler: vi.fn(),
  sessionList: vi.fn(),
  sessionDelete: vi.fn(),
  projectDelete: vi.fn(),
  publish: vi.fn()
}))

vi.mock('../../storage/messageStore', () => ({ messageStore: {} }))
vi.mock('../../storage/sessionStore', () => ({
  sessionStore: {
    updateSettings: vi.fn(),
    getSettingsSync: () => ({}),
    list: mocks.sessionList,
    delete: mocks.sessionDelete
  }
}))
vi.mock('../../storage/settingsStore', () => ({ settingsStore: {} }))
vi.mock('../../storage/mcpStore', () => ({
  mcpStore: {
    findAll: () => [],
    nameProblem: mocks.nameProblem,
    findById: mocks.findById,
    add: mocks.add,
    update: mocks.update,
    delete: mocks.del
  }
}))
vi.mock('../../storage/projectStore', () => ({ projectStore: { delete: mocks.projectDelete } }))
vi.mock('../../storage/configShareStore', () => ({ configShareStore: {} }))
vi.mock('../mcpRuntime', () => ({
  mcpManager: {
    connect: mocks.connect,
    disconnect: mocks.disconnect,
    closeSession: mocks.closeSession,
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
  removeRuntimeSession: mocks.removeRuntimeSession,
  setSessionModel: vi.fn()
}))
vi.mock('../subAgent', () => ({ subAgentManager: {} }))
vi.mock('../tabLease', () => ({ withTabLease: vi.fn() }))
vi.mock('@shuvix/agent-runtime', () => ({ validateShuvixMdText: vi.fn() }))
vi.mock('../titleRuntime', () => ({ titlerFor: vi.fn(), removeTitler: mocks.removeTitler }))
vi.mock('../filesRuntime', () => ({ filesRuntime: {}, workingDirNameForSession: vi.fn() }))
vi.mock('../appEventBus', () => ({ appEventBus: { publish: mocks.publish, subscribe: vi.fn() } }))

import { chatApiAdapter } from '../chatApiAdapter'

const SERVER = { id: 'srv-1', name: 'e2e', isEnabled: 1 }

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.add.mockReturnValue(SERVER)
  mocks.update.mockReturnValue(SERVER)
  mocks.findById.mockReturnValue(SERVER)
  mocks.nameProblem.mockReturnValue(undefined)
  mocks.connect.mockResolvedValue({ ok: true })
  mocks.disconnect.mockResolvedValue(undefined)
  mocks.closeSession.mockResolvedValue(undefined)
  mocks.removeRuntimeSession.mockResolvedValue(undefined)
  mocks.sessionList.mockResolvedValue([])
  mocks.sessionDelete.mockResolvedValue(undefined)
  mocks.projectDelete.mockResolvedValue(undefined)
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

  it('MCPL-U-16 update 命中不存在的行：不写连接层（连断开都不发），并如实报失败', async () => {
    mocks.update.mockReturnValue(undefined)
    expect(await chatApiAdapter.mcp.update({ id: 'gone' })).toEqual({ success: false })
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

/**
 * 名字的规矩（与桌面 mcp:add / mcp:update 同一条）：名字是工具名前缀 `mcp__<name>__*`，撞名或含 `__`
 * 就当场回 `success:false` + 给人看的原因 —— 设置页对话框原样显示它。被拒的写入一个字节都不落库，
 * 连接层也不碰。
 */
describe('扩展端 MCP：名字有问题就当场拒绝，并说清原因', () => {
  const TAKEN = 'An MCP server named "browser" already exists'

  it('MCPN-1 add 名字有问题 → {success:false, error}，不写库、不连也不断', async () => {
    mocks.nameProblem.mockReturnValue(TAKEN)
    const res = await chatApiAdapter.mcp.add({ name: 'browser', type: 'http', url: 'http://x/mcp' })
    expect(res).toEqual({ success: false, error: TAKEN })
    expect(mocks.nameProblem).toHaveBeenCalledWith('browser')
    expect(mocks.add).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.disconnect).not.toHaveBeenCalled()
  })

  it('MCPN-2 add 名字没问题、存储仍不收（add 返回 undefined）→ {success:false}，不带原因', async () => {
    mocks.add.mockReturnValue(undefined)
    expect(
      await chatApiAdapter.mcp.add({ name: 'fresh', type: 'http', url: 'http://x/mcp' })
    ).toEqual({ success: false })
    expect(mocks.add).toHaveBeenCalledTimes(1)
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('MCPN-3 update 改名有问题 → {success:false, error}：按自己的 id 查名字，不写库、不断开', async () => {
    mocks.nameProblem.mockReturnValue('An MCP server name cannot contain "__"')
    const res = await chatApiAdapter.mcp.update({ id: SERVER.id, name: 'a__b' })
    expect(res).toEqual({ success: false, error: 'An MCP server name cannot contain "__"' })
    expect(mocks.nameProblem).toHaveBeenCalledWith('a__b', SERVER.id)
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.disconnect).not.toHaveBeenCalled()
  })

  it('MCPN-4 update 不改名（只启停）→ 不查名字，照常写库 + 断开旧连接', async () => {
    const res = await chatApiAdapter.mcp.update({ id: SERVER.id, isEnabled: false })
    expect(res).toEqual({ success: true })
    expect(mocks.nameProblem).not.toHaveBeenCalled()
    expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(mocks.disconnect).toHaveBeenCalledWith(SERVER.id)
  })
})

describe('扩展端 MCP：内置行删不掉', () => {
  it('MCPB-1 delete 内置行（isBuiltin:1）→ {success:false}；不断开、不删库', async () => {
    mocks.findById.mockReturnValue({ id: 'builtin-mcp-browser', name: 'browser', isBuiltin: 1 })
    expect(await chatApiAdapter.mcp.delete('builtin-mcp-browser')).toEqual({ success: false })
    expect(mocks.disconnect).not.toHaveBeenCalled()
    expect(mocks.del).not.toHaveBeenCalled()
  })

  it('MCPB-2 delete 用户的行（isBuiltin:0）→ 照常：先断开、再删库、success:true', async () => {
    mocks.findById.mockReturnValue({ ...SERVER, isBuiltin: 0 })
    expect(await chatApiAdapter.mcp.delete(SERVER.id)).toEqual({ success: true })
    expect(mocks.disconnect).toHaveBeenCalledWith(SERVER.id)
    expect(mocks.del).toHaveBeenCalledWith(SERVER.id)
    expect(mocks.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.del.mock.invocationCallOrder[0]
    )
  })
})

/**
 * 内置能力服务器（browser）的实例绑在**会话**上，不是运行时上 —— 运行时可以重建（失效 / 回退），
 * 实例要留着；只有会话本身没了才放。所以释放挂在两条删会话的路径上，且在运行时关停之后、
 * 删会话行之前。
 */
describe('会话删掉时放掉它的内置 MCP 实例', () => {
  it('MCPS-1 session.delete：依次 removeRuntimeSession → closeSession(id) → sessionStore.delete，并发 session.listChanged', async () => {
    expect(await chatApiAdapter.session.delete('s1')).toEqual({ success: true })
    expect(mocks.removeRuntimeSession).toHaveBeenCalledWith('s1')
    expect(mocks.closeSession).toHaveBeenCalledTimes(1)
    expect(mocks.closeSession).toHaveBeenCalledWith('s1')
    expect(mocks.sessionDelete).toHaveBeenCalledWith('s1')
    const order = [mocks.removeRuntimeSession, mocks.closeSession, mocks.sessionDelete].map(
      (m) => m.mock.invocationCallOrder[0]
    )
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(mocks.removeTitler).toHaveBeenCalledWith('s1')
    expect(mocks.publish).toHaveBeenCalledWith({ type: 'session.listChanged' })
  })

  it('MCPS-2 project.delete：只放这个项目的会话，每条都在运行时关停之后、删行之前；删项目排最后', async () => {
    mocks.sessionList.mockResolvedValue([
      { id: 's1', projectId: 'p1' },
      { id: 's2', projectId: 'p2' },
      { id: 's3', projectId: 'p1' },
      { id: 's4', projectId: null }
    ])
    expect(await chatApiAdapter.project.delete({ id: 'p1' })).toEqual({ success: true })
    expect(mocks.closeSession.mock.calls.map((c) => c[0])).toEqual(['s1', 's3'])
    expect(mocks.sessionDelete.mock.calls.map((c) => c[0])).toEqual(['s1', 's3'])

    const orderOf = (m: ReturnType<typeof vi.fn>, sid: string): number =>
      m.mock.invocationCallOrder[m.mock.calls.findIndex((c) => c[0] === sid)]
    for (const sid of ['s1', 's3']) {
      expect(orderOf(mocks.removeRuntimeSession, sid), sid).toBeLessThan(
        orderOf(mocks.closeSession, sid)
      )
      expect(orderOf(mocks.closeSession, sid), sid).toBeLessThan(orderOf(mocks.sessionDelete, sid))
    }
    expect(mocks.projectDelete).toHaveBeenCalledWith('p1')
    const last = Math.max(
      ...[mocks.removeRuntimeSession, mocks.closeSession, mocks.sessionDelete].flatMap(
        (m) => m.mock.invocationCallOrder
      )
    )
    expect(mocks.projectDelete.mock.invocationCallOrder[0]).toBeGreaterThan(last)
  })
})
