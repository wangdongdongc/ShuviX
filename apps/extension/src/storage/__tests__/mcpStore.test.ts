/**
 * 扩展端 MCP 存储（chrome.storage.local + 内存缓存）—— 内置 browser 行的种植与守护、名字唯一。
 *
 * 钉的是：
 *   - **种植**：缺了就种上内置 `browser` 行（inproc、恒开、id 与桌面 v27 迁移同一个），并落盘一次；
 *     名字若已被用户加的 server 占着，先给那一行改名 `browser-custom`（再撞加序号）—— 与桌面 v27
 *     同一条规则；已经有了就什么都不动（停用着的也不给「修」回启用）；
 *   - **名字**：名字是工具名前缀 `mcp__<name>__*`，必须非空、唯一、不含 `__`（否则一台自定义 server
 *     的工具能以 `mcp__browser__` 开头冒充内置浏览器），比较与落盘都按去掉首尾空白之后的名字；
 *   - **内置行只能启停**：改名 / 改地址 / 改 env 一律拒绝，删不掉。表单把没改的字段写成 undefined
 *     送来，那不算「改配置」。
 *
 * store 把缓存放在模块级（`cache` / `loaded`），所以每条用例 `vi.resetModules()` 之后动态 import 一份
 * 新的；chrome.storage.local 桩在内存里，读写都深拷贝 —— 缓存与「盘上」那份不共用对象，
 * 于是「落没落盘」只能从 set 的调用看出来，不会被别名蒙混过去。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_MCP_SERVER_NAME } from '@shuvix/agent-runtime'
import type { McpServer, McpServerUpdateParams } from '@shuvix/chat-protocol/types/mcp'

const KEY = 'mcpServers'
const BUILTIN_ID = 'builtin-mcp-browser'

let disk: Record<string, unknown>
let get: ReturnType<typeof vi.fn>
let set: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  disk = {}
  get = vi.fn(async (key: string) => (key in disk ? { [key]: structuredClone(disk[key]) } : {}))
  set = vi.fn(async (obj: Record<string, unknown>) => {
    Object.assign(disk, structuredClone(obj))
  })
  vi.stubGlobal('chrome', { storage: { local: { get, set } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 一台用户自己加的 http server（字段写满，好看出「除了名字都没动」） */
const userRow = (over: Partial<McpServer>): McpServer => ({
  id: 'u1',
  name: 'browser',
  type: 'http',
  command: '',
  args: '[]',
  env: '{"TOKEN":"t"}',
  url: 'https://playwright.example/mcp',
  headers: '{"X-A":"1"}',
  metadata: '{"note":"mine"}',
  isEnabled: 1,
  isBuiltin: 0,
  cachedTools: '[{"name":"click"}]',
  createdAt: 10,
  updatedAt: 10,
  ...over
})

/** 盘上已经有了的内置行（可以是停用着的） */
const storedBuiltin = (over: Partial<McpServer> = {}): McpServer => ({
  id: BUILTIN_ID,
  name: 'browser',
  type: 'inproc',
  command: '',
  args: '[]',
  env: '{}',
  url: '',
  headers: '{}',
  metadata: '{}',
  isEnabled: 1,
  isBuiltin: 1,
  cachedTools: '[]',
  createdAt: 5,
  updatedAt: 5,
  ...over
})

/** 盘上放好 stored（不给 = 空），加载一份新的 store 模块 */
async function load(stored?: McpServer[]): Promise<typeof import('../mcpStore')> {
  if (stored) disk[KEY] = structuredClone(stored)
  const mod = await import('../mcpStore')
  await mod.mcpStore.loadState()
  return mod
}

/** 最后一次落盘的那份数组 */
const lastPersisted = (): McpServer[] => {
  expect(set).toHaveBeenCalled()
  return (set.mock.calls.at(-1)![0] as Record<string, McpServer[]>)[KEY]
}

describe('种植内置 browser 行', () => {
  it('MS-1 空存储：findAll 恰为那一行内置 browser，并落盘一次', async () => {
    const { mcpStore, BUILTIN_BROWSER_ID } = await load()
    const expected = {
      id: 'builtin-mcp-browser',
      name: 'browser',
      type: 'inproc',
      command: '',
      args: '[]',
      env: '{}',
      url: '',
      headers: '{}',
      metadata: '{}',
      isEnabled: 1,
      isBuiltin: 1,
      cachedTools: '[]',
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number)
    }
    expect(mcpStore.findAll()).toEqual([expected])
    expect(BUILTIN_BROWSER_ID).toBe('builtin-mcp-browser')
    expect(set).toHaveBeenCalledTimes(1)
    expect(lastPersisted()).toEqual([expected])
    // 同步 McpStore 接口也看得到它（恒开，于是注入每条会话）
    expect(mcpStore.findById(BUILTIN_ID)?.name).toBe('browser')
    expect(mcpStore.findEnabled().map((s) => s.id)).toEqual([BUILTIN_ID])
  })

  it('MS-2 名字被用户的 server 占着：那一行改名 browser-custom（其余字段不动、updatedAt 刷新），内置行排第一，改动落盘', async () => {
    const mine = userRow({})
    const { mcpStore } = await load([mine])
    const all = mcpStore.findAll()
    expect(all.map((s) => [s.id, s.name])).toEqual([
      [BUILTIN_ID, 'browser'],
      ['u1', 'browser-custom']
    ])
    const renamed = all[1]
    const { name: _n, updatedAt, ...rest } = renamed
    const { name: _on, updatedAt: before, ...restBefore } = mine
    expect(rest).toEqual(restBefore)
    expect(updatedAt).toBeGreaterThan(before)
    expect(set).toHaveBeenCalledTimes(1)
    expect(lastPersisted().map((s) => [s.id, s.name])).toEqual([
      [BUILTIN_ID, 'browser'],
      ['u1', 'browser-custom']
    ])
  })

  it('MS-3 browser-custom 也被占了 → browser-custom-2；-2 也占了 → browser-custom-3', async () => {
    const two = await load([userRow({}), userRow({ id: 'u2', name: 'browser-custom' })])
    expect(two.mcpStore.findById('u1')?.name).toBe('browser-custom-2')
    expect(two.mcpStore.findById('u2')?.name).toBe('browser-custom')

    vi.resetModules()
    disk = {}
    const three = await load([
      userRow({}),
      userRow({ id: 'u2', name: 'browser-custom' }),
      userRow({ id: 'u3', name: 'browser-custom-2' })
    ])
    expect(three.mcpStore.findById('u1')?.name).toBe('browser-custom-3')
    // 名字全表唯一
    const names = three.mcpStore.findAll().map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('MS-4 已经有内置行（哪怕停用着）：不写盘、不改它；第二次 loadState 不再读存储', async () => {
    const { mcpStore } = await load([storedBuiltin({ isEnabled: 0 }), userRow({ name: 'other' })])
    expect(set).not.toHaveBeenCalled()
    expect(mcpStore.findById(BUILTIN_ID)).toEqual(storedBuiltin({ isEnabled: 0 }))
    expect(mcpStore.findById('u1')?.name).toBe('other')
    expect(mcpStore.findEnabled().map((s) => s.id)).toEqual(['u1'])

    await mcpStore.loadState()
    expect(get).toHaveBeenCalledTimes(1)
    expect(set).not.toHaveBeenCalled()
  })

  it('MS-9 种下的名字就是 server 注册表用的名字，id 与桌面 v27 迁移的同一个', async () => {
    const { mcpStore, BUILTIN_BROWSER_ID } = await load()
    const builtin = mcpStore.findAll().find((s) => s.isBuiltin === 1)
    expect(builtin?.name).toBe(BROWSER_MCP_SERVER_NAME)
    expect(builtin?.id).toBe(BUILTIN_BROWSER_ID)
  })
})

describe('nameProblem —— 名字是工具名前缀', () => {
  it.each<[string, string]>([
    ['', 'An MCP server needs a name'],
    ['   ', 'An MCP server needs a name'],
    ['a__b', 'An MCP server name cannot contain "__"'],
    ['browser', 'An MCP server named "browser" already exists'],
    // 按去掉首尾空白之后的名字比较
    [' browser ', 'An MCP server named "browser" already exists']
  ])('MS-5 %j → %j', async (name, problem) => {
    const { mcpStore } = await load()
    expect(mcpStore.nameProblem(name)).toBe(problem)
  })

  it('MS-5b 没问题 → undefined；自己那一行不算撞名', async () => {
    const { mcpStore } = await load([userRow({ name: 'mine' })])
    expect(mcpStore.nameProblem('fresh')).toBeUndefined()
    expect(mcpStore.nameProblem('mine')).toBe('An MCP server named "mine" already exists')
    expect(mcpStore.nameProblem('mine', 'u1')).toBeUndefined()
    expect(mcpStore.nameProblem('browser', BUILTIN_ID)).toBeUndefined()
    // 自己的 id 只豁免自己：换成别人的 id 照样撞
    expect(mcpStore.nameProblem('browser', 'u1')).toBe(
      'An MCP server named "browser" already exists'
    )
  })
})

describe('add / update / delete', () => {
  it('MS-6 add：名字有问题 → undefined、不落盘；没问题 → 一行 http 自定义 server（名字去空白）', async () => {
    const { mcpStore } = await load()
    const writes = set.mock.calls.length
    for (const bad of ['', 'a__b', 'browser', ' browser ']) {
      expect(mcpStore.add({ name: bad, type: 'http', url: 'https://x/mcp' }), bad).toBeUndefined()
    }
    expect(set.mock.calls.length).toBe(writes)
    expect(mcpStore.findAll()).toHaveLength(1)

    // 扩展只有 http：传 stdio 也落成 http
    const added = mcpStore.add({
      name: ' search ',
      type: 'stdio',
      url: 'https://s.example/mcp',
      env: { K: 'v' },
      headers: { H: '1' }
    })
    expect(added).toMatchObject({
      name: 'search',
      type: 'http',
      isBuiltin: 0,
      isEnabled: 1,
      url: 'https://s.example/mcp',
      env: '{"K":"v"}',
      headers: '{"H":"1"}'
    })
    expect(added!.id).toMatch(/^mcp-/)
    expect(set.mock.calls.length).toBe(writes + 1)
    expect(lastPersisted().map((s) => s.name)).toEqual(['browser', 'search'])
  })

  it('MS-7a update 改名：撞名 / 含 __ → undefined 且不动；改成自己的名字可以；落盘的是去空白后的名字', async () => {
    const { mcpStore } = await load([
      userRow({ id: 'u1', name: 'foo' }),
      userRow({ id: 'u2', name: 'bar' })
    ])
    const writes = set.mock.calls.length
    expect(mcpStore.update({ id: 'u1', name: 'bar' })).toBeUndefined()
    expect(mcpStore.update({ id: 'u1', name: 'browser' })).toBeUndefined()
    expect(mcpStore.update({ id: 'u1', name: 'x__y' })).toBeUndefined()
    expect(mcpStore.update({ id: 'u1', name: '  ' })).toBeUndefined()
    expect(mcpStore.findById('u1')?.name).toBe('foo')
    expect(set.mock.calls.length).toBe(writes)

    expect(mcpStore.update({ id: 'u1', name: 'foo' })?.name).toBe('foo')
    expect(mcpStore.update({ id: 'u1', name: ' baz ' })?.name).toBe('baz')
    expect(lastPersisted().find((s) => s.id === 'u1')?.name).toBe('baz')
    // 行不存在
    expect(mcpStore.update({ id: 'nope', isEnabled: false })).toBeUndefined()
  })

  it('MS-7b 内置行可以启停（落盘）；表单送来的 undefined 字段不算改配置', async () => {
    const { mcpStore } = await load()
    const off = mcpStore.update({ id: BUILTIN_ID, isEnabled: false })
    expect(off?.isEnabled).toBe(0)
    expect(lastPersisted().find((s) => s.id === BUILTIN_ID)?.isEnabled).toBe(0)

    const on = mcpStore.update({ id: BUILTIN_ID, isEnabled: true, name: undefined, url: undefined })
    expect(on?.isEnabled).toBe(1)
    expect(on?.name).toBe('browser')
    expect(lastPersisted().find((s) => s.id === BUILTIN_ID)?.isEnabled).toBe(1)
  })

  it.each<[string, Partial<McpServerUpdateParams>]>([
    ['name（自己的名字也不行）', { name: 'browser' }],
    ['name', { name: 'web' }],
    ['url', { url: 'https://x/mcp' }],
    ['headers', { headers: { A: '1' } }],
    ['env', { env: { A: '1' } }],
    ['type', { type: 'http' }]
  ])('MS-7c 内置行改 %s → undefined，行不变、不落盘', async (_label, patch) => {
    const { mcpStore } = await load()
    const before = structuredClone(mcpStore.findById(BUILTIN_ID))
    const writes = set.mock.calls.length
    expect(mcpStore.update({ id: BUILTIN_ID, isEnabled: false, ...patch })).toBeUndefined()
    expect(mcpStore.findById(BUILTIN_ID)).toEqual(before)
    expect(set.mock.calls.length).toBe(writes)
  })

  it('MS-8 delete：内置行删不掉（false、还在、不落盘）；用户的行删掉（true、落盘）', async () => {
    const { mcpStore } = await load([userRow({ name: 'mine' })])
    const writes = set.mock.calls.length
    expect(mcpStore.delete(BUILTIN_ID)).toBe(false)
    expect(mcpStore.findById(BUILTIN_ID)).toBeDefined()
    expect(set.mock.calls.length).toBe(writes)

    expect(mcpStore.delete('u1')).toBe(true)
    expect(mcpStore.findById('u1')).toBeUndefined()
    expect(lastPersisted().map((s) => s.id)).toEqual([BUILTIN_ID])
  })
})
