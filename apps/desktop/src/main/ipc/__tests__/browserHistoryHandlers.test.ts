/**
 * browserHistoryHandlers —— 内置浏览器的历史记录（地址栏建议、历史记录页、删除）与地址栏的搜索建议。
 * 只认浏览器窗口外壳发来的（历史里的网址可能带着登录令牌）。
 *
 *   BHI-1  外壳（宿主 webContents 7）发来的：suggest → suggestHistory(text)；list → listHistory(q, agentSessionTitle)；
 *          remove → removeHistoryItems(keys)；remove-url → removeHistoryUrl(url)；clear → clearHistory()；
 *          search-suggest → fetchSearchSuggestions(text, engine)，各自原样回服务的值
 *   BHI-2  别的窗口（9）：suggest / search-suggest 回 []、list 回 {items:[], next:null}，删除类什么也不做，
 *          一个服务都不调
 *   BHI-3  网络客户端（服务器模式的局域网浏览器）：同 BHI-2
 *   BHI-4  外壳发来的参数校验：suggest(42) → []；search-suggest(42) → []；search-suggest('x', 42) → 引擎 ''；
 *          list(null) / list('x') → listHistory({})；remove-url(42) → 不调；remove 的参数原样交给服务（由它挑）
 *
 * electron 是替身（handle 收进 Map）；services/browser 整个换成间谍 —— 宿主判断固定为「webContents id 7 是宿主」。
 * 窗口客户端经 IPC 适配器调，网络客户端直接取注册表里的定义、带一个 network 上下文调。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  handle: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  suggestHistory: vi.fn((_text: string) => [{ url: 'https://a.test/', score: 1 }] as unknown[]),
  listHistory: vi.fn((_q: unknown, _title: unknown) => ({ items: [{ key: 'k' }], next: 7 })),
  removeHistoryItems: vi.fn((_keys: unknown) => {}),
  removeHistoryUrl: vi.fn((_url: string) => {}),
  clearHistory: vi.fn(() => {}),
  fetchSearchSuggestions: vi.fn(async (_text: string, _engine: string) => ['suggested']),
  agentSessionTitle: vi.fn((_sid: string) => 'Session title')
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: () => undefined,
    handle: (channel: string, handler: Handler) => void state.handle.set(channel, handler)
  }
}))
// mock 路径按**测试文件**解析：被测模块 import 的 '../services/browser' 在这里是 '../../services/browser'
vi.mock('../../services/browser', () => ({
  isHostWebContents: (id: number) => id === 7,
  agentSessionTitle: (sid: string) => state.agentSessionTitle(sid),
  suggestHistory: (text: string) => state.suggestHistory(text),
  listHistory: (q: unknown, title: unknown) => state.listHistory(q, title),
  removeHistoryItems: (keys: unknown) => state.removeHistoryItems(keys),
  removeHistoryUrl: (url: string) => state.removeHistoryUrl(url),
  clearHistory: () => state.clearHistory(),
  fetchSearchSuggestions: (text: string, engine: string) =>
    state.fetchSearchSuggestions(text, engine)
}))

import { registerBrowserHistoryHandlers } from '../browserHistoryHandlers'
import { attachIpcAdapter } from '../ipcAdapter'
import { listDefinitions } from '../registry'
import { netCtx } from '../../frontend/network/__tests__/support/fakeNetworkConnection'

registerBrowserHistoryHandlers()
// 注册表经 IPC 适配器挂到（替身）ipcMain 上：handle 里收的是适配器包过的处理函数
attachIpcAdapter()

const HOST = 7
const OTHER = 9

/** 像渲染端 invoke 那样调一个已注册的 handle（sender 的 webContents id 由参数给） */
const invoke = (channel: string, senderId: number, ...args: unknown[]): Promise<unknown> => {
  const handler = state.handle.get(channel)
  if (!handler) throw new Error(`no ipcMain.handle handler for ${channel}`)
  return Promise.resolve(handler({ sender: { id: senderId } }, ...args))
}

/** 网络客户端：不经 IPC 适配器，直接调注册表里的定义 */
const fromNet = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const definition = listDefinitions().find((d) => d.channel === channel)
  if (!definition) throw new Error(`no definition for ${channel}`)
  return Promise.resolve(definition.fn(netCtx(1), ...args))
}

const SERVICES = [
  'suggestHistory',
  'listHistory',
  'removeHistoryItems',
  'removeHistoryUrl',
  'clearHistory',
  'fetchSearchSuggestions'
] as const

const noServiceCalled = (): void => {
  for (const name of SERVICES) expect(state[name], name).not.toHaveBeenCalled()
}

beforeEach(() => {
  for (const name of SERVICES) state[name].mockClear()
  state.agentSessionTitle.mockClear()
})

describe('外壳发来的（BHI-1）', () => {
  it('BHI-1 suggest → suggestHistory(text)，原样回', async () => {
    expect(await invoke('browser-history:suggest', HOST, 'git')).toEqual([
      { url: 'https://a.test/', score: 1 }
    ])
    expect(state.suggestHistory.mock.calls).toEqual([['git']])
  })

  it('BHI-1 list → listHistory(q, agentSessionTitle)，原样回；标题回调就是服务层那一个', async () => {
    const q = { search: 'x', actor: 'agent', cursor: 3, limit: 50 }
    expect(await invoke('browser-history:list', HOST, q)).toEqual({
      items: [{ key: 'k' }],
      next: 7
    })
    expect(state.listHistory).toHaveBeenCalledTimes(1)
    const [passed, title] = state.listHistory.mock.calls[0] as [unknown, (sid: string) => string]
    expect(passed).toEqual(q)
    expect(title('s1')).toBe('Session title')
    expect(state.agentSessionTitle.mock.calls).toEqual([['s1']])
  })

  it('BHI-1 remove / remove-url / clear → 对应的服务', async () => {
    await invoke('browser-history:remove', HOST, ['2026-10-29|1|'])
    await invoke('browser-history:remove-url', HOST, 'https://a.test/')
    await invoke('browser-history:clear', HOST)
    expect(state.removeHistoryItems.mock.calls).toEqual([[['2026-10-29|1|']]])
    expect(state.removeHistoryUrl.mock.calls).toEqual([['https://a.test/']])
    expect(state.clearHistory).toHaveBeenCalledTimes(1)
  })

  it('BHI-1 search-suggest → fetchSearchSuggestions(text, engine)，原样回', async () => {
    expect(await invoke('browser-history:search-suggest', HOST, 'git', 'bing')).toEqual([
      'suggested'
    ])
    expect(state.fetchSearchSuggestions.mock.calls).toEqual([['git', 'bing']])
  })
})

describe.each([
  ['别的窗口（BHI-2）', (channel: string, ...args: unknown[]) => invoke(channel, OTHER, ...args)],
  ['网络客户端（BHI-3）', fromNet]
] as const)('%s', (label, call) => {
  const id = label.includes('BHI-2') ? 'BHI-2' : 'BHI-3'

  it(`${id} 读：suggest / search-suggest → []，list → {items:[], next:null}`, async () => {
    expect(await call('browser-history:suggest', 'git')).toEqual([])
    expect(await call('browser-history:search-suggest', 'git', 'google')).toEqual([])
    expect(await call('browser-history:list', { search: '' })).toEqual({ items: [], next: null })
    noServiceCalled()
  })

  it(`${id} 删除类：什么也不做`, async () => {
    await call('browser-history:remove', ['2026-10-29|1|'])
    await call('browser-history:remove-url', 'https://a.test/')
    await call('browser-history:clear')
    noServiceCalled()
  })
})

describe('外壳发来的参数校验（BHI-4）', () => {
  it.each([[42], [undefined], [null], [['git']]])('BHI-4 suggest(%j) → []、不调', async (arg) => {
    expect(await invoke('browser-history:suggest', HOST, arg)).toEqual([])
    expect(state.suggestHistory).not.toHaveBeenCalled()
  })

  it('BHI-4 search-suggest(42) → []、不调；search-suggest(x, 42) → 引擎 ""', async () => {
    expect(await invoke('browser-history:search-suggest', HOST, 42, 'google')).toEqual([])
    expect(state.fetchSearchSuggestions).not.toHaveBeenCalled()
    await invoke('browser-history:search-suggest', HOST, 'x', 42)
    await invoke('browser-history:search-suggest', HOST, 'y')
    expect(state.fetchSearchSuggestions.mock.calls).toEqual([
      ['x', ''],
      ['y', '']
    ])
  })

  it.each([[null], ['x'], [undefined], [42]])('BHI-4 list(%j) → listHistory({})', async (arg) => {
    await invoke('browser-history:list', HOST, arg)
    expect(state.listHistory.mock.calls.map(([q]) => q)).toEqual([{}])
  })

  it.each([[42], [undefined], [null], [{ url: 'https://a.test/' }]])(
    'BHI-4 remove-url(%j) → 不调',
    async (arg) => {
      await invoke('browser-history:remove-url', HOST, arg)
      expect(state.removeHistoryUrl).not.toHaveBeenCalled()
    }
  )

  it('BHI-4 remove 的参数原样交给服务（挑合法的 key 是 removeHistoryItems 的事）', async () => {
    await invoke('browser-history:remove', HOST, 'not-an-array')
    expect(state.removeHistoryItems.mock.calls).toEqual([['not-an-array']])
  })
})
