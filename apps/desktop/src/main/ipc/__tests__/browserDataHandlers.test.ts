/**
 * browserDataHandlers —— 站点信息气泡与浏览器设置页「证书」一节用到的三条通道（2026-10-16）。
 *
 *   BS-U22 site-info(url)：只认 http(s) —— 取浏览器分区里**这个地址会带上的** cookie（`cookies.get({url})`），
 *          回 `{cookieCount, certException}`；certException 按地址的主机名（不含端口）比对 certExceptionHosts()；
 *          about: / file: / shuvix:// / 不合法 / 空串 / 非字符串一律回 `{0, false}`，连 cookie 都不碰；
 *          cert-exceptions 原样回 certExceptionHosts()；
 *   BS-U23 clear-site-data(url)：`cookies.get({url})` 回的每一个 cookie 都删掉（删除地址按 secure / 去掉前导点的
 *          domain / path 拼：`.github.com` → `https://github.com/`），再 `clearStorageData({origin})` 一次；删某一个
 *          失败不影响其余、也不让整个调用失败；非网页地址什么也不做。
 *
 * electron 是替身（handle 收进 Map；session.fromPartition 回一个带间谍的假分区），services/browser 换成
 * 只有 BROWSER_PARTITION 与 certExceptionHosts 的替身。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

interface FakeCookie {
  name: string
  domain?: string
  path?: string
  secure?: boolean
}

const state = vi.hoisted(() => {
  const s = {
    handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
    cookies: [] as Array<{ name: string; domain?: string; path?: string; secure?: boolean }>,
    get: vi.fn(),
    remove: vi.fn(),
    clearStorageData: vi.fn(),
    fromPartition: vi.fn(),
    certExceptionHosts: vi.fn<() => string[]>(() => [])
  }
  s.get.mockImplementation(async () => s.cookies)
  s.remove.mockImplementation(async () => undefined)
  s.clearStorageData.mockImplementation(async () => undefined)
  s.fromPartition.mockImplementation(() => ({
    cookies: { get: s.get, remove: s.remove },
    clearStorageData: s.clearStorageData
  }))
  return s
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      state.handlers.set(channel, fn)
    },
    on: () => undefined
  },
  session: { fromPartition: (partition: string) => state.fromPartition(partition) }
}))
// mock 路径按**测试文件**解析：被测模块 import 的 '../services/browser' 在这里是 '../../services/browser'
vi.mock('../../services/browser', () => ({
  BROWSER_PARTITION: 'persist:shuvix-browser',
  certExceptionHosts: () => state.certExceptionHosts()
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} })
}))

import { registerBrowserDataHandlers } from '../browserDataHandlers'
import { attachIpcAdapter } from '../ipcAdapter'

const IPC_EVENT = { sender: { id: 1 } }
const call = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const fn = state.handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(fn(IPC_EVENT, ...args))
}

// 注册一次（同一通道再定义会抛错），经 IPC 适配器挂到替身 ipcMain 上
registerBrowserDataHandlers()
attachIpcAdapter()

beforeEach(() => {
  state.cookies = []
  state.get.mockClear()
  state.remove.mockReset()
  state.remove.mockImplementation(async () => undefined)
  state.clearStorageData.mockClear()
  state.fromPartition.mockClear()
  state.certExceptionHosts.mockReset()
  state.certExceptionHosts.mockReturnValue([])
})

const cookie = (over: FakeCookie): FakeCookie => over

describe('site-info / cert-exceptions（BS-U22）', () => {
  it('BS-U22 site-info(https://www.github.com/x)：按地址取 cookie（浏览器分区），回 {cookieCount, certException:false}', async () => {
    state.cookies = [
      cookie({ name: 'a', domain: '.github.com', path: '/', secure: true }),
      cookie({ name: 'b', domain: 'www.github.com', path: '/', secure: true }),
      cookie({ name: 'c', domain: 'www.github.com', path: '/x', secure: false })
    ]
    expect(await call('browser-data:site-info', 'https://www.github.com/x')).toEqual({
      cookieCount: 3,
      certException: false
    })
    expect(state.fromPartition.mock.calls).toEqual([['persist:shuvix-browser']])
    expect(state.get.mock.calls).toEqual([[{ url: 'https://www.github.com/x' }]])
    expect(state.remove).not.toHaveBeenCalled()
    expect(state.clearStorageData).not.toHaveBeenCalled()
  })

  it('BS-U22 没有 cookie：0', async () => {
    expect(await call('browser-data:site-info', 'http://plain.test/')).toEqual({
      cookieCount: 0,
      certException: false
    })
    expect(state.get.mock.calls).toEqual([[{ url: 'http://plain.test/' }]])
  })

  it('BS-U22 certException 按主机名（不含端口）比对：放行过 a.test → https://a.test:8443/ 为真，别的主机为假', async () => {
    state.certExceptionHosts.mockReturnValue(['a.test'])
    expect(await call('browser-data:site-info', 'https://a.test:8443/')).toEqual({
      cookieCount: 0,
      certException: true
    })
    expect(await call('browser-data:site-info', 'https://a.test/page')).toMatchObject({
      certException: true
    })
    expect(await call('browser-data:site-info', 'https://b.test:8443/')).toMatchObject({
      certException: false
    })
    expect(await call('browser-data:site-info', 'https://sub.a.test/')).toMatchObject({
      certException: false
    })
  })

  it.each([
    ['about:blank'],
    ['file:///Users/me/a.html'],
    ['shuvix://settings'],
    ['data:text/html,hi'],
    ['not a url'],
    [''],
    [undefined],
    [42],
    [{ url: 'https://a.test/' }]
  ])('BS-U22 site-info(%j)：不是网页 → {0, false}，不碰 cookie', async (url) => {
    state.certExceptionHosts.mockReturnValue(['a.test'])
    expect(await call('browser-data:site-info', url)).toEqual({
      cookieCount: 0,
      certException: false
    })
    expect(state.get).not.toHaveBeenCalled()
    expect(state.fromPartition).not.toHaveBeenCalled()
  })

  it('BS-U22 cert-exceptions 原样回 certExceptionHosts()', async () => {
    expect(await call('browser-data:cert-exceptions')).toEqual([])
    state.certExceptionHosts.mockReturnValue(['127.0.0.1', 'a.test'])
    expect(await call('browser-data:cert-exceptions')).toEqual(['127.0.0.1', 'a.test'])
  })
})

describe('clear-site-data（BS-U23）', () => {
  it('BS-U23 删掉这个地址带着的每一个 cookie（删除地址按 secure / 去点的 domain / path 拼），再按 origin 清存储一次', async () => {
    state.cookies = [
      cookie({ name: 'sid', domain: '.github.com', path: '/', secure: true }),
      cookie({ name: 'pref', domain: 'www.github.com', path: '/x', secure: false }),
      cookie({ name: 'nopath', domain: 'www.github.com', secure: true })
    ]
    await call('browser-data:clear-site-data', 'https://www.github.com/x?y=1')

    expect(state.fromPartition).toHaveBeenCalledWith('persist:shuvix-browser')
    expect(state.get.mock.calls).toEqual([[{ url: 'https://www.github.com/x?y=1' }]])
    expect(state.remove.mock.calls).toEqual([
      ['https://github.com/', 'sid'],
      ['http://www.github.com/x', 'pref'],
      ['https://www.github.com/', 'nopath']
    ])
    expect(state.clearStorageData.mock.calls).toEqual([[{ origin: 'https://www.github.com' }]])
    // 先删 cookie，最后清存储
    const lastRemove = Math.max(...state.remove.mock.invocationCallOrder)
    expect(state.clearStorageData.mock.invocationCallOrder[0]).toBeGreaterThan(lastRemove)
  })

  it('BS-U23 origin 带端口：clearStorageData 的 origin 原样带端口', async () => {
    await call('browser-data:clear-site-data', 'http://127.0.0.1:5173/app')
    expect(state.clearStorageData.mock.calls).toEqual([[{ origin: 'http://127.0.0.1:5173' }]])
  })

  it('BS-U23 删某一个失败：其余照删、存储照清，整个调用不失败', async () => {
    state.cookies = [
      cookie({ name: 'one', domain: 'a.test', path: '/', secure: true }),
      cookie({ name: 'two', domain: 'a.test', path: '/', secure: true }),
      cookie({ name: 'three', domain: '.a.test', path: '/p', secure: false })
    ]
    state.remove.mockImplementation(async (_url: string, name: string) => {
      if (name === 'one') throw new Error('locked')
    })
    await expect(call('browser-data:clear-site-data', 'https://a.test/')).resolves.toBeUndefined()
    expect(state.remove.mock.calls.map(([, name]) => name)).toEqual(['one', 'two', 'three'])
    expect(state.clearStorageData.mock.calls).toEqual([[{ origin: 'https://a.test' }]])
  })

  it.each([['about:blank'], ['file:///a.html'], ['shuvix://settings'], ['garbage'], [''], [42]])(
    'BS-U23 clear-site-data(%j)：不是网页 → 什么也不做',
    async (url) => {
      state.cookies = [cookie({ name: 'x', domain: 'a.test', path: '/', secure: true })]
      await call('browser-data:clear-site-data', url)
      expect(state.fromPartition).not.toHaveBeenCalled()
      expect(state.get).not.toHaveBeenCalled()
      expect(state.remove).not.toHaveBeenCalled()
      expect(state.clearStorageData).not.toHaveBeenCalled()
    }
  )
})
