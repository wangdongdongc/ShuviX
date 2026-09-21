/**
 * 扩展端配置分享（configShareStore）的 MCP 部分 —— 内置能力服务器进来之后的导出 / 导入规矩：
 *
 *   - **导出**：`inproc` 行（内置能力服务器）没有任何可迁移的配置 —— 每个安装自己种 —— 所以既不进
 *     导出候选，勾了也不导；
 *   - **导入一条标了内置的项**：本端恰好有同名内置行（桌面导出的 `browser`）→ 没什么可导的，算成功，
 *     一个字节都不写；本端没有（桌面的 `ssh`）→ 失败并说清楚；
 *   - **导入一条自定义项，名字却是本端内置行的名字** → 失败，内置行不被覆盖、也不被断开；
 *   - 其余照旧：同名自定义行整体覆盖 + 启用 + 断开旧连接（惰性启动，不重连），新名字新增，
 *     没勾的不碰；存储不收（add 返回 undefined）→ 如实报失败。
 *
 * 编解码与导入判定用 chat-protocol 的真内核；settingsStore / mcpStore / mcpRuntime 顶成替身
 * （真件的 import 图带 chrome.storage 与 MCP 运行时）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConfigSharePayload } from '@shuvix/chat-protocol/configShareCore'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import type {
  ConfigSharePayload,
  ExportedMcpServer,
  ImportSelection
} from '@shuvix/chat-protocol/types/configShare'

const mocks = vi.hoisted(() => ({
  servers: [] as unknown[],
  update: vi.fn(),
  add: vi.fn(),
  disconnect: vi.fn()
}))

vi.mock('../settingsStore', () => ({
  settingsStore: {
    loadState: async () => {},
    listProviders: () => [],
    listModelsFor: () => []
  }
}))
vi.mock('../mcpStore', () => ({
  mcpStore: {
    loadState: async () => {},
    findAll: () => [...mocks.servers],
    update: mocks.update,
    add: mocks.add
  }
}))
vi.mock('../../runtime/mcpRuntime', () => ({ mcpManager: { disconnect: mocks.disconnect } }))

import { configShareStore } from '../configShareStore'

const server = (over: Partial<McpServer>): McpServer => ({
  id: 'x',
  name: 'x',
  type: 'http',
  command: '',
  args: '[]',
  env: '{}',
  url: '',
  headers: '{}',
  metadata: '{}',
  isEnabled: 1,
  isBuiltin: 0,
  cachedTools: '[]',
  createdAt: 0,
  updatedAt: 0,
  ...over
})

const BROWSER = server({ id: 'builtin-mcp-browser', name: 'browser', type: 'inproc', isBuiltin: 1 })
const TAVILY = server({
  id: 'mcp-tavily',
  name: 'tavily',
  url: 'https://mcp.tavily.example/mcp',
  env: '{"TAVILY_KEY":"secret"}',
  headers: '{"Authorization":"Bearer t"}'
})
const OFF = server({ id: 'mcp-off', name: 'off', url: 'https://off.example/mcp', isEnabled: 0 })

/** 导出端的一项（缺省是一台自定义 http server） */
const exported = (over: Partial<ExportedMcpServer>): ExportedMcpServer => ({
  name: 'x',
  type: 'http',
  command: null,
  args: [],
  env: {},
  url: 'https://x.example/mcp',
  headers: {},
  metadata: null,
  sensitiveStripped: false,
  isBuiltin: false,
  ...over
})

const payloadOf = (mcpServers: ExportedMcpServer[]): ConfigSharePayload => ({
  version: 1,
  exportedAt: '2026-09-21T00:00:00.000Z',
  appVersion: '1.0.0',
  mcpServers
})

const selecting = (...mcpNames: string[]): ImportSelection => ({
  providerNames: [],
  modelKeys: [],
  mcpNames
})

beforeEach(() => {
  mocks.servers = [BROWSER, TAVILY, OFF]
  mocks.update.mockReset()
  mocks.add.mockReset()
  mocks.disconnect.mockReset()
  mocks.update.mockImplementation((p: { id: string }) => ({ ...TAVILY, id: p.id }))
  mocks.add.mockImplementation((p: { name: string }) => server({ id: `mcp-${p.name}`, ...p }))
  mocks.disconnect.mockResolvedValue(undefined)
  vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '9.9.9' }) } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('导出：内置能力服务器没有可迁移的配置', () => {
  it('CS-1 导出候选不列 inproc 行（也不列停用的行）', async () => {
    const snapshot = await configShareStore.buildExportSnapshot()
    expect(snapshot.mcpServers).toEqual([{ name: 'tavily', type: 'http', isBuiltin: false }])
  })

  it('CS-2 勾了 browser 也不导；自定义行照导（不含敏感值时 env / headers 的值置空）', async () => {
    const encoded = await configShareStore.buildExportPayload({
      providers: [],
      mcpServers: [
        { name: 'browser', includeSensitive: true },
        { name: 'tavily', includeSensitive: false }
      ]
    })
    const payload = parseConfigSharePayload(encoded)
    expect(payload.appVersion).toBe('9.9.9')
    expect(payload.mcpServers?.map((s) => s.name)).toEqual(['tavily'])
    expect(payload.mcpServers?.[0]).toMatchObject({
      type: 'http',
      url: 'https://mcp.tavily.example/mcp',
      env: { TAVILY_KEY: '' },
      headers: { Authorization: '' },
      sensitiveStripped: true,
      isBuiltin: false
    })
  })

  it('CS-2b 只勾了 browser → 导出里根本没有 mcpServers 这一段', async () => {
    const encoded = await configShareStore.buildExportPayload({
      providers: [],
      mcpServers: [{ name: 'browser', includeSensitive: true }]
    })
    expect(parseConfigSharePayload(encoded).mcpServers).toBeUndefined()
  })
})

describe('导入：标了内置的项', () => {
  it('CS-3 本端有同名内置行（桌面导出的 browser）→ 跳过：没有可导入的配置，不写、不断；预览同样是 skipBuiltin', async () => {
    const payload = payloadOf([exported({ name: 'browser', isBuiltin: true, url: null })])
    const result = await configShareStore.applyImport({ payload, selection: selecting('browser') })
    expect(result.mcpServers).toEqual([
      {
        name: 'browser',
        ok: false,
        error: '"browser" is a built-in server here and has nothing to import — skipped'
      }
    ])
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.add).not.toHaveBeenCalled()
    expect(mocks.disconnect).not.toHaveBeenCalled()
    // 预览与结果对得上：都是「跳过」
    const plan = await configShareStore.planImport(payload)
    expect(plan.mcpServers).toEqual([
      expect.objectContaining({ name: 'browser', action: 'skipBuiltin' })
    ])
  })

  it('CS-4 本端没有的内置（桌面的 ssh）→ 失败，原因说清楚；什么都不写', async () => {
    const payload = payloadOf([exported({ name: 'ssh', isBuiltin: true, url: null })])
    const result = await configShareStore.applyImport({ payload, selection: selecting('ssh') })
    expect(result.mcpServers).toEqual([
      {
        name: 'ssh',
        ok: false,
        error: 'Built-in "ssh" is not available in the extension — skipped'
      }
    ])
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.add).not.toHaveBeenCalled()
    const plan = await configShareStore.planImport(payload)
    expect(plan.mcpServers).toEqual([
      expect.objectContaining({ name: 'ssh', action: 'skipMissingBuiltin' })
    ])
  })
})

describe('导入：自定义项', () => {
  it('CS-5 名字恰是本端内置行的名字（一台叫 browser 的自定义 server）→ 失败；内置行不被改、不被断开', async () => {
    const payload = payloadOf([
      exported({ name: 'browser', url: 'https://playwright.example/mcp' })
    ])
    const result = await configShareStore.applyImport({ payload, selection: selecting('browser') })
    expect(result.mcpServers).toEqual([
      {
        name: 'browser',
        ok: false,
        error: '"browser" is a built-in server here and has nothing to import — skipped'
      }
    ])
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.add).not.toHaveBeenCalled()
    expect(mocks.disconnect).not.toHaveBeenCalled()
    // 预览不再说「并入内置」—— 与结果一致
    const plan = await configShareStore.planImport(payload)
    expect(plan.mcpServers).toEqual([
      expect.objectContaining({ name: 'browser', action: 'skipBuiltin' })
    ])
  })

  it('CS-6 同名自定义行 → 整体覆盖 + 启用 + 只断开不重连；新名字 → 新增 http 行；没勾的不碰', async () => {
    const payload = payloadOf([
      exported({
        name: 'tavily',
        url: 'https://new.tavily.example/mcp',
        env: { TAVILY_KEY: 'k2' },
        headers: { H: '1' }
      }),
      exported({ name: 'fresh', url: 'https://fresh.example/mcp', env: { A: 'b' } }),
      exported({ name: 'ignored', url: 'https://ignored.example/mcp' })
    ])
    const result = await configShareStore.applyImport({
      payload,
      selection: selecting('tavily', 'fresh')
    })
    expect(result.mcpServers).toEqual([
      { name: 'tavily', ok: true },
      { name: 'fresh', ok: true }
    ])
    expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(mocks.update).toHaveBeenCalledWith({
      id: TAVILY.id,
      name: 'tavily',
      url: 'https://new.tavily.example/mcp',
      env: { TAVILY_KEY: 'k2' },
      headers: { H: '1' },
      isEnabled: true
    })
    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.disconnect).toHaveBeenCalledWith(TAVILY.id)
    expect(mocks.add).toHaveBeenCalledTimes(1)
    expect(mocks.add).toHaveBeenCalledWith({
      type: 'http',
      name: 'fresh',
      url: 'https://fresh.example/mcp',
      env: { A: 'b' },
      headers: {}
    })
  })

  it('CS-7 存储不收新增（add 返回 undefined）→ 如实报失败', async () => {
    mocks.add.mockReturnValue(undefined)
    const payload = payloadOf([exported({ name: 'x' })])
    const result = await configShareStore.applyImport({ payload, selection: selecting('x') })
    expect(result.mcpServers).toEqual([
      { name: 'x', ok: false, error: 'An MCP server named "x" already exists — skipped' }
    ])
  })
})
