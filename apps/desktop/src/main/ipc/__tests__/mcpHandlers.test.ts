/**
 * mcpHandlers —— MCP server 的名字校验（`mcp:add` / `mcp:update`）。
 *
 * 名字就是工具名前缀（`mcp__<name>__<tool>`），所以：
 *   - 必须唯一 —— 表上的 UNIQUE 会抛一条生 SQLite 错误，这里要先回一句人话；
 *     内置行（browser / ssh）占着的名字同样算被占；
 *   - 不能含 `__` —— 否则一台自定义 server 的工具会以 `mcp__browser__` 开头、冒充内置浏览器；
 *   - 按去掉首尾空白的写法查、也按这个写法存（带空格存进去，下一次查重就对不上了）。
 * 被拒的请求什么都不写、也不断开任何连接。内置行本身不改名（它的名字字段被忽略，也就不校验）。
 *
 * electron 是替身（handle 收进 Map）；mcpDao / mcpService 只替到接口那一层。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
type Row = Record<string, unknown>

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  rows: [] as Array<Record<string, unknown>>
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      state.handlers.set(channel, handler)
    }
  }
}))
vi.mock('../../dao/mcpDao', () => ({
  mcpDao: {
    findAll: vi.fn(() => state.rows),
    pick: vi.fn((id: string) => state.rows.find((r) => r.id === id)),
    insert: vi.fn(),
    update: vi.fn(),
    deleteById: vi.fn()
  }
}))
vi.mock('../../services/mcpService', () => ({
  mcpService: {
    getStatus: vi.fn(() => 'disconnected'),
    getError: vi.fn(),
    connect: vi.fn(async () => ({ ok: true })),
    disconnect: vi.fn(async () => {}),
    getServerToolInfos: vi.fn(() => [])
  }
}))

import { mcpDao } from '../../dao/mcpDao'
import { mcpService } from '../../services/mcpService'
import { registerMcpHandlers } from '../mcpHandlers'

registerMcpHandlers()

/** 像渲染端 invoke 那样调一个已注册的处理函数 */
const invoke = (channel: string, ...args: unknown[]): unknown => {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler({}, ...args)
}

const row = (id: string, name: string, over: Row = {}): Row => ({
  id,
  name,
  type: 'stdio',
  command: 'npx',
  args: '[]',
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

beforeEach(() => {
  vi.clearAllMocks()
  state.rows = [
    row('builtin-mcp-browser', 'browser', { type: 'inproc', command: '', isBuiltin: 1 }),
    row('builtin-mcp-ssh', 'ssh', { type: 'inproc', command: '', isBuiltin: 1 }),
    row('u1', 'mine'),
    row('u2', 'other', { type: 'http', command: '', url: 'https://x.example/mcp' })
  ]
})

describe('mcp:add 的名字校验', () => {
  it.each<[string, string]>([
    ['', 'An MCP server needs a name'],
    ['   ', 'An MCP server needs a name'],
    ['a__b', 'An MCP server name cannot contain "__"'],
    ['browser__x', 'An MCP server name cannot contain "__"'],
    ['browser', 'An MCP server named "browser" already exists'],
    [' browser ', 'An MCP server named "browser" already exists'],
    ['ssh', 'An MCP server named "ssh" already exists'],
    ['mine', 'An MCP server named "mine" already exists']
  ])('MH-1 名字 %j → 拒绝「%s」，什么都不写', async (name, error) => {
    expect(await invoke('mcp:add', { name, type: 'stdio', command: 'npx' })).toEqual({
      success: false,
      error
    })
    expect(mcpDao.insert).not.toHaveBeenCalled()
  })

  it('MH-2 合法的名字 → 恰好插一行（按去掉首尾空白的写法存），回 {success, id}', async () => {
    const result = (await invoke('mcp:add', {
      name: '  my-server ',
      type: 'http',
      url: 'https://my.example/mcp',
      headers: { Authorization: 'Bearer x' }
    })) as { success: boolean; id: string }

    expect(result.success).toBe(true)
    expect(mcpDao.insert).toHaveBeenCalledTimes(1)
    const inserted = vi.mocked(mcpDao.insert).mock.calls[0][0] as unknown as Row
    expect(result).toEqual({ success: true, id: inserted.id })
    expect(inserted).toMatchObject({
      name: 'my-server',
      type: 'http',
      url: 'https://my.example/mcp',
      headers: JSON.stringify({ Authorization: 'Bearer x' }),
      isEnabled: 1,
      isBuiltin: 0,
      cachedTools: '[]'
    })
  })
})

describe('mcp:update 的名字校验', () => {
  it.each<[string, string]>([
    ['other', 'An MCP server named "other" already exists'],
    ['browser', 'An MCP server named "browser" already exists'],
    [' ssh ', 'An MCP server named "ssh" already exists'],
    ['my__server', 'An MCP server name cannot contain "__"'],
    ['  ', 'An MCP server needs a name']
  ])('MH-3 用户的行改名为 %j → 拒绝「%s」：不写、不断开', async (name, error) => {
    expect(await invoke('mcp:update', { id: 'u1', name })).toEqual({ success: false, error })
    expect(mcpDao.update).not.toHaveBeenCalled()
    expect(mcpService.disconnect).not.toHaveBeenCalled()
  })

  it('MH-4 改回自己的名字不算撞名；新名字按去掉首尾空白的写法存', async () => {
    expect(await invoke('mcp:update', { id: 'u1', name: 'mine' })).toEqual({ success: true })
    expect(vi.mocked(mcpDao.update).mock.calls[0]).toEqual(['u1', { name: 'mine' }])

    expect(await invoke('mcp:update', { id: 'u1', name: '  renamed ' })).toEqual({
      success: true
    })
    expect(vi.mocked(mcpDao.update).mock.calls[1]).toEqual(['u1', { name: 'renamed' }])
    expect(mcpService.disconnect).toHaveBeenCalledTimes(2)
  })

  it('MH-5 内置行不改名：name（哪怕不合法）被忽略、不校验，其余允许的字段照常写', async () => {
    expect(
      await invoke('mcp:update', { id: 'builtin-mcp-browser', name: 'x__y', isEnabled: false })
    ).toEqual({ success: true })
    expect(vi.mocked(mcpDao.update).mock.calls).toEqual([['builtin-mcp-browser', { isEnabled: 0 }]])
  })
})
