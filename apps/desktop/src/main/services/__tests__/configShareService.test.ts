/**
 * configShareService —— 配置分享里的 MCP server。
 *
 * 内置能力服务器（`inproc`：ssh / browser）没有任何可迁移的配置 —— 每个安装自己种 ——
 * 所以导出的候选集里没有它们，哪怕勾选名单里点了它们的名字，写出来的分享串里也没有（CS-1/2）。
 *
 * 导入这一侧（CS-3/4）：本端同名的是**内置能力服务器**（inproc）→ 没有可导入的东西，跳过；
 * 它的启停是本机的选择，导入不能顺手把一台停用的内置 server 重新打开（不论导出端是否标了内置，
 * 预览里是 skipBuiltin）。本端同名的是非 inproc 的内置行 → 只合并 env（不动结构字段，空值不覆盖
 * 已有的键）。标成内置、本端却没有同名内置（没有这一行，或同名的是用户自己的 server）→ 跳过并报
 * 「not available on this install」，不拿残缺的内置条目去污染本端配置。
 *
 * DAO / mcpService / electron 都是替身；分享串用 chat-protocol 的真编解码（导出之后原样解回来看）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConfigSharePayload } from '@shuvix/chat-protocol/configShareCore'
import type { ConfigSharePayload, ExportedMcpServer } from '@shuvix/chat-protocol/types/configShare'

type Row = Record<string, unknown>

const state = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9' } }))
vi.mock('../../dao/providerDao', () => ({
  providerDao: {
    findEnabled: vi.fn(() => []),
    findEnabledModels: vi.fn(() => []),
    findAll: vi.fn(() => [])
  }
}))
vi.mock('../../utils/appEventBus', () => ({ appEventBus: { publish: vi.fn() } }))
vi.mock('../../dao/mcpDao', () => ({
  mcpDao: {
    findEnabled: vi.fn(() => state.rows.filter((r) => r.isEnabled === 1)),
    findByName: vi.fn((name: string) => state.rows.find((r) => r.name === name)),
    insert: vi.fn(),
    update: vi.fn()
  }
}))
vi.mock('../mcpService', () => ({ mcpService: { disconnect: vi.fn(async () => {}) } }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { mcpDao } from '../../dao/mcpDao'
import { mcpService } from '../mcpService'
import { configShareService } from '../configShareService'

const row = (id: string, name: string, over: Row = {}): Row => ({
  id,
  name,
  type: 'stdio',
  command: 'npx',
  args: '["-y","fs-mcp"]',
  env: '{}',
  url: '',
  headers: '{}',
  metadata: '{}',
  isEnabled: 1,
  isBuiltin: 0,
  cachedTools: '[]',
  createdAt: 1,
  updatedAt: 1,
  ...over
})

const builtin = (id: string, name: string, over: Row = {}): Row =>
  row(id, name, { type: 'inproc', command: '', args: '[]', isBuiltin: 1, ...over })

beforeEach(() => {
  vi.clearAllMocks()
  state.rows = [
    builtin('builtin-mcp-ssh', 'ssh'),
    builtin('builtin-mcp-browser', 'browser'),
    row('u-fs', 'fs'),
    row('u-remote', 'remote', {
      type: 'http',
      command: '',
      url: 'https://remote.example/mcp',
      headers: '{"Authorization":"Bearer x"}'
    })
  ]
})

describe('configShareService — 导出不带内置能力服务器', () => {
  it('CS-1 导出候选里没有 inproc 行，其余已启用的照常列出', () => {
    expect(configShareService.buildExportSnapshot().mcpServers).toEqual([
      { name: 'fs', type: 'stdio', isBuiltin: false },
      { name: 'remote', type: 'http', isBuiltin: false }
    ])
  })

  it('CS-2 勾选名单里点了 ssh / browser 也不写进分享串；只剩它们时分享串里没有 mcpServers', () => {
    const decode = (encoded: string): ConfigSharePayload => parseConfigSharePayload(encoded)
    const everything = decode(
      configShareService.buildExportPayload({
        providers: [],
        mcpServers: ['ssh', 'browser', 'remote'].map((name) => ({ name, includeSensitive: true }))
      })
    )
    expect(everything.mcpServers?.map((s) => s.name)).toEqual(['remote'])
    expect(everything.mcpServers?.[0]).toMatchObject({
      type: 'http',
      url: 'https://remote.example/mcp',
      isBuiltin: false
    })

    const onlyBuiltins = decode(
      configShareService.buildExportPayload({
        providers: [],
        mcpServers: ['ssh', 'browser'].map((name) => ({ name, includeSensitive: true }))
      })
    )
    expect(onlyBuiltins.mcpServers).toBeUndefined()
  })
})

describe('configShareService — 导入与本端内置同名的条目', () => {
  /** 一条标成内置的导出条目：结构字段为空，只带 env */
  const exportedBuiltin = (name: string, env: Record<string, string>): ExportedMcpServer => ({
    name,
    type: 'http',
    command: null,
    args: null,
    env,
    url: null,
    headers: null,
    metadata: null,
    sensitiveStripped: false,
    isBuiltin: true
  })

  const payloadOf = (...mcpServers: ExportedMcpServer[]): ConfigSharePayload => ({
    version: 1,
    exportedAt: '2026-09-21T00:00:00.000Z',
    appVersion: '9.9.8',
    mcpServers
  })

  it.each<[string, (name: string) => ExportedMcpServer]>([
    ['标成内置的条目', (name) => exportedBuiltin(name, { A: '1' })],
    [
      '用户自己的同名 server',
      (name) => ({
        ...exportedBuiltin(name, { A: '1' }),
        url: 'https://playwright.example/mcp',
        isBuiltin: false
      })
    ]
  ])(
    'CS-3 本端同名的是内置能力服务器（停用中），导入%s → 跳过：不写、不断、不重新启用；预览同样是 skipBuiltin',
    async (_l, make) => {
      state.rows[1] = builtin('builtin-mcp-browser', 'browser', { isEnabled: 0 })
      const payload = payloadOf(make('browser'))
      const result = await configShareService.applyImportPayload(payload, {
        providerNames: [],
        modelKeys: [],
        mcpNames: ['browser']
      })

      expect(result.mcpServers).toEqual([
        {
          name: 'browser',
          ok: false,
          error: '"browser" is a built-in server here and has nothing to import — skipped'
        }
      ])
      expect(mcpDao.update).not.toHaveBeenCalled()
      expect(mcpDao.insert).not.toHaveBeenCalled()
      expect(mcpService.disconnect).not.toHaveBeenCalled()
      expect(configShareService.planImport(payload).mcpServers).toEqual([
        expect.objectContaining({ name: 'browser', action: 'skipBuiltin' })
      ])
    }
  )

  it('CS-3b 本端同名的是非 inproc 的内置行 → 只合并 env（空值不覆盖已有的键），断开旧连接；不插行、不动结构字段', async () => {
    state.rows.push(
      row('builtin-mcp-hosted', 'hosted', {
        type: 'http',
        isBuiltin: 1,
        env: '{"KEEP":"k","B":"old"}'
      })
    )
    const result = await configShareService.applyImportPayload(
      payloadOf(exportedBuiltin('hosted', { A: '1', B: '', KEEP: 'new' })),
      { providerNames: [], modelKeys: [], mcpNames: ['hosted'] }
    )

    expect(result.mcpServers).toEqual([{ name: 'hosted', ok: true }])
    expect(mcpService.disconnect).toHaveBeenCalledWith('builtin-mcp-hosted')
    expect(vi.mocked(mcpDao.update).mock.calls).toEqual([
      [
        'builtin-mcp-hosted',
        { env: JSON.stringify({ KEEP: 'new', B: 'old', A: '1' }), isEnabled: 1 }
      ]
    ])
    expect(mcpDao.insert).not.toHaveBeenCalled()
  })

  it.each<[string, () => void]>([
    ['本端没有这一行', () => undefined],
    ['同名的是用户自己的 server', () => void state.rows.push(row('u-x', 'x'))]
  ])(
    'CS-4 标成内置、本端却没有同名内置（%s）→ 跳过并报 not available，什么都不写',
    async (_l, arrange) => {
      arrange()
      const result = await configShareService.applyImportPayload(
        payloadOf(exportedBuiltin('x', { TOKEN: 't' })),
        { providerNames: [], modelKeys: [], mcpNames: ['x'] }
      )

      expect(result.mcpServers).toEqual([
        {
          name: 'x',
          ok: false,
          error:
            'Built-in "x" is not available on this install — skipped to avoid corrupting config'
        }
      ])
      expect(mcpDao.insert).not.toHaveBeenCalled()
      expect(mcpDao.update).not.toHaveBeenCalled()
      expect(mcpService.disconnect).not.toHaveBeenCalled()
    }
  )
})
