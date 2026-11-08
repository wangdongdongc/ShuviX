/**
 * mcpHandlers —— MCP server 的名字校验（`mcp:add` / `mcp:update`）。
 *
 * 名字就是工具名前缀（`mcp__<name>__<tool>`），所以：
 *   - 必须唯一 —— 表上的 UNIQUE 会抛一条生 SQLite 错误，这里要先回一句人话；
 *     内置行（browser / ssh）占着的名字同样算被占；
 *   - 不能含 `__` —— 否则一台自定义 server 的工具会以 `mcp__browser__` 开头、冒充内置浏览器；
 *   - 按去掉首尾空白的写法查、也按这个写法存（带空格存进去，下一次查重就对不上了）。
 *   - `widget-` 开头（不分大小写）是留给组件的：每个有 API 的组件是一台 `widget-<id>`（2026-11-04），工具卡片只凭前缀认组件，
 *     而组件的勾选算读授权 —— 用户的服务器不能占这个名字。
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
import { attachIpcAdapter } from '../ipcAdapter'

registerMcpHandlers()
// 注册表经 IPC 适配器挂到（替身）ipcMain 上：handlers 里收的是适配器包过的处理函数
attachIpcAdapter()

/** 像渲染端 invoke 那样调一个已注册的处理函数 */
const invoke = (channel: string, ...args: unknown[]): unknown => {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler({ sender: { id: 1 } }, ...args)
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

describe('`widget-` 是留给组件的名字', () => {
  const RESERVED = 'Names starting with "widget-" are kept for widgets'

  it.each(['widget-x', 'widget-a-b', '  widget-x  ', 'Widget-a-b', 'WIDGET-X', 'widget-'])(
    'MH-W1 mcp:add 名字 %j → 拒绝，什么都不写',
    async (name) => {
      expect(await invoke('mcp:add', { name, type: 'stdio', command: 'npx' })).toEqual({
        success: false,
        error: RESERVED
      })
      expect(mcpDao.insert).not.toHaveBeenCalled()
    }
  )

  it.each(['widget-x', ' widget-a-b ', 'Widget-a-b'])(
    'MH-W2 mcp:update 用户的行改名为 %j → 拒绝：不写、不断开',
    async (name) => {
      expect(await invoke('mcp:update', { id: 'u1', name })).toEqual({
        success: false,
        error: RESERVED
      })
      expect(mcpDao.update).not.toHaveBeenCalled()
      expect(mcpService.disconnect).not.toHaveBeenCalled()
    }
  )

  it('MH-W3 内置行的 name 被忽略：不合法的名字不拦住其余字段', async () => {
    state.rows.push(row('b1', 'b1', { isBuiltin: 1 }))
    expect(await invoke('mcp:update', { id: 'b1', name: 'widget-x', isEnabled: false })).toEqual({
      success: true
    })
    expect(mcpDao.update).toHaveBeenCalledWith('b1', { isEnabled: 0 })
  })

  it.each(['my-widget-x', 'widgets', 'widgetish', 'custom-widget-a-b'])(
    'MH-W4 %s 没有保留前缀，照常能加',
    async (name) => {
      expect(await invoke('mcp:add', { name, type: 'stdio', command: 'npx' })).toMatchObject({
        success: true
      })
      expect(mcpDao.insert).toHaveBeenCalledTimes(1)
    }
  )

  it('MH-W5 mcp:list 只读配置行：算出来的组件服务器不经这里（替身 mcpService 上连 findAll 都没有）', async () => {
    const listed = (await invoke('mcp:list')) as Array<{ id: string }>
    expect(listed.map((s) => s.id)).toEqual(state.rows.map((r) => r.id))
    expect(mcpDao.findAll).toHaveBeenCalled()
  })
})

describe('空的 env / headers 交给 DAO 的写法', () => {
  // mcpDao 判断「空值不加密、不覆盖解不开的密文」靠的就是字面量 `{}`，这里换一种写法（`{ }`、null）那条判断就失效了
  it('MH-6 mcp:update 的 {} → 恰好是字符串 `{}`；mcp:add 两个字段都不给也是 `{}`', async () => {
    expect(await invoke('mcp:update', { id: 'u1', env: {}, headers: {} })).toEqual({
      success: true
    })
    expect(vi.mocked(mcpDao.update).mock.calls).toEqual([['u1', { env: '{}', headers: '{}' }]])

    await invoke('mcp:add', { name: 'fresh', type: 'stdio', command: 'npx' })
    const inserted = vi.mocked(mcpDao.insert).mock.calls[0][0] as unknown as Row
    expect(inserted.env).toBe('{}')
    expect(inserted.headers).toBe('{}')
  })
})

describe('工作目录（metadata.cwd）', () => {
  it('MH-C1 mcp:add 带绝对路径 → 存进 metadata（去掉首尾空白）；不给 / 空串 → metadata 是 `{}`', async () => {
    await invoke('mcp:add', { name: 'a', type: 'stdio', command: 'npx', cwd: '  /srv/tools ' })
    await invoke('mcp:add', { name: 'b', type: 'stdio', command: 'npx' })
    await invoke('mcp:add', { name: 'c', type: 'stdio', command: 'npx', cwd: '   ' })
    const metadata = vi
      .mocked(mcpDao.insert)
      .mock.calls.map(([server]) => (server as unknown as Row).metadata)
    expect(metadata).toEqual([JSON.stringify({ cwd: '/srv/tools' }), '{}', '{}'])
  })

  it.each(['relative/dir', './here', '~/tools'])(
    'MH-C2 mcp:add 相对路径 %j → 拒绝，什么都不写',
    async (cwd) => {
      expect(await invoke('mcp:add', { name: 'a', type: 'stdio', command: 'npx', cwd })).toEqual({
        success: false,
        error: `The working directory must be an absolute path, got "${cwd}"`
      })
      expect(mcpDao.insert).not.toHaveBeenCalled()
    }
  )

  it('MH-C3 mcp:update 给目录 → metadata 只带 cwd 这一个键（DAO 去合并，别的键不动）；`` → 删掉这个键', async () => {
    await invoke('mcp:update', { id: 'u1', cwd: ' /srv/tools ' })
    await invoke('mcp:update', { id: 'u1', cwd: '' })
    // toStrictEqual：`{ cwd: undefined }`（删掉这个键）与 `{}`（不动）是两回事
    expect(vi.mocked(mcpDao.update).mock.calls[0]).toStrictEqual([
      'u1',
      { metadata: { cwd: '/srv/tools' } }
    ])
    expect(vi.mocked(mcpDao.update).mock.calls[1]).toStrictEqual([
      'u1',
      { metadata: { cwd: undefined } }
    ])
  })

  it('MH-C4 mcp:update 不给 cwd → 不碰 metadata', async () => {
    await invoke('mcp:update', { id: 'u1', command: 'uvx' })
    expect(vi.mocked(mcpDao.update).mock.calls[0]).toStrictEqual(['u1', { command: 'uvx' }])
  })

  it('MH-C5 mcp:update 相对路径 → 拒绝：不写、不断开', async () => {
    expect(await invoke('mcp:update', { id: 'u1', cwd: 'tools', command: 'uvx' })).toEqual({
      success: false,
      error: 'The working directory must be an absolute path, got "tools"'
    })
    expect(mcpDao.update).not.toHaveBeenCalled()
    expect(mcpService.disconnect).not.toHaveBeenCalled()
  })

  it('MH-C6 内置行的 cwd 被忽略（哪怕不合法），其余允许的字段照常写', async () => {
    expect(
      await invoke('mcp:update', { id: 'builtin-mcp-ssh', cwd: 'relative', isEnabled: false })
    ).toEqual({ success: true })
    expect(vi.mocked(mcpDao.update).mock.calls).toStrictEqual([
      ['builtin-mcp-ssh', { isEnabled: 0 }]
    ])
  })
})

describe('记住的 transport（metadata.transport）随地址走', () => {
  it('MH-T1 改了地址 → 清掉记住的 transport，下次重新先试 Streamable HTTP', async () => {
    await invoke('mcp:update', { id: 'u2', url: 'https://y.example/sse' })
    expect(vi.mocked(mcpDao.update).mock.calls[0]).toStrictEqual([
      'u2',
      { url: 'https://y.example/sse', metadata: { transport: undefined } }
    ])
  })

  it('MH-T2 改了类型 → 同样清掉', async () => {
    await invoke('mcp:update', { id: 'u2', type: 'stdio' })
    expect(vi.mocked(mcpDao.update).mock.calls[0]).toStrictEqual([
      'u2',
      { type: 'stdio', metadata: { transport: undefined } }
    ])
  })

  it('MH-T3 设置对话框原样存回（地址、类型都没变）→ 不清', async () => {
    await invoke('mcp:update', {
      id: 'u2',
      name: 'other',
      type: 'http',
      url: 'https://x.example/mcp',
      cwd: ''
    })
    expect(vi.mocked(mcpDao.update).mock.calls[0]).toStrictEqual([
      'u2',
      { name: 'other', type: 'http', url: 'https://x.example/mcp', metadata: { cwd: undefined } }
    ])
  })
})
