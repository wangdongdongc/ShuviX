/**
 * browserDataHandlers —— 浏览器设置页的网站数据、站点信息气泡与「证书」一节用到的通道（2026-10-16）。
 *
 *   SD-U20 list-sites 原样转给 listSites()；site-details 只回应桌面窗口：窗口客户端 → siteDetails(site) 的结果，
 *          网络客户端（服务器模式的局域网浏览器，没有鉴权）→ null、连服务都不调（Cookie 的值是登录令牌）；
 *          不合法的 site（空串 / 非字符串）→ null、不调；
 *   SD-U21 删除通道的校验：clear-site 只收非空字符串；clear-site-category 只收六个类别（别的串、原型上的键、
 *          非字符串都忽略）且网站要是非空字符串；clear-origin 只收字符串；remove-cookie 只收对象；
 *   SD-U22 site-info 对网页地址多回一个 `site`（siteOfUrl 给出分组键时；给不出就没有这个键）；非网页照旧
 *          `{0, false}`、连 siteOfUrl 都不问；
 *   BS-U22 site-info(url)：只认 http(s) —— 取浏览器分区里**这个地址会带上的** cookie（`cookies.get({url})`），
 *          回 `{cookieCount, certException}`；certException 按地址的主机名（不含端口）比对 certExceptionHosts()；
 *          about: / file: / shuvix:// / 不合法 / 空串 / 非字符串一律回 `{0, false}`，连 cookie 都不碰；
 *          cert-exceptions 原样回 certExceptionHosts()；
 *   BS-U23 clear-site-data(url)：`cookies.get({url})` 回的每一个 cookie 都删掉（删除地址按 secure / 去掉前导点的
 *          domain / path 拼：`.github.com` → `https://github.com/`），再 `clearStorageData({origin})` 一次；删某一个
 *          失败不影响其余、也不让整个调用失败；非网页地址什么也不做。
 *
 * electron 是替身（handle 收进 Map；session.fromPartition 回一个带间谍的假分区），services/browser 换成
 * 替身（BROWSER_PARTITION、certExceptionHosts 与网站数据的七个函数都是间谍）。窗口客户端经 IPC 适配器调，
 * 网络客户端直接取注册表里的定义、带一个 network 上下文调。
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
    certExceptionHosts: vi.fn<() => string[]>(() => []),
    listSites: vi.fn(async () => [] as unknown[]),
    siteDetails: vi.fn(async (_site: string) => null as unknown),
    clearSite: vi.fn(async (_site: string) => undefined),
    clearSiteCategory: vi.fn(async (_site: string, _category: string) => undefined),
    clearOrigin: vi.fn(async (_origin: string) => undefined),
    removeCookie: vi.fn(async (_cookie: unknown) => undefined),
    siteOfUrl: vi.fn((_url: string): string | null => null)
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
  certExceptionHosts: () => state.certExceptionHosts(),
  listSites: () => state.listSites(),
  siteDetails: (site: string) => state.siteDetails(site),
  clearSite: (site: string) => state.clearSite(site),
  clearSiteCategory: (site: string, category: string) => state.clearSiteCategory(site, category),
  clearOrigin: (origin: string) => state.clearOrigin(origin),
  removeCookie: (cookie: unknown) => state.removeCookie(cookie),
  siteOfUrl: (url: string) => state.siteOfUrl(url)
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} })
}))

import { registerBrowserDataHandlers } from '../browserDataHandlers'
import { attachIpcAdapter } from '../ipcAdapter'
import { listDefinitions, type ClientContext } from '../registry'

const IPC_EVENT = { sender: { id: 1 } }
const call = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const fn = state.handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(fn(IPC_EVENT, ...args))
}

/** 网络客户端（服务器模式）：不经 IPC 适配器，直接调注册表里的定义 */
const NET_CTX: ClientContext = {
  client: { kind: 'network', id: 'ws:1', remoteAddress: '192.168.1.20', userAgent: 'UA/1' },
  transport: 'network'
}
const callAs = (ctx: ClientContext, channel: string, ...args: unknown[]): Promise<unknown> => {
  const definition = listDefinitions().find((d) => d.channel === channel)
  if (!definition) throw new Error(`no definition for ${channel}`)
  return Promise.resolve(definition.fn(ctx, ...args))
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
  for (const fn of [
    state.listSites,
    state.siteDetails,
    state.clearSite,
    state.clearSiteCategory,
    state.clearOrigin,
    state.removeCookie,
    state.siteOfUrl
  ]) {
    // 回到 vi.fn 时给的缺省实现（排着的 mockResolvedValueOnce 一并清掉）
    fn.mockReset()
  }
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

describe('网站列表与站点详情（SD-U20）', () => {
  const SITES = [
    {
      site: 'github.com',
      cookieCount: 2,
      cookieBytes: 20,
      usageBytes: 1000,
      localStorage: true,
      originCount: 2,
      lastAccessed: 1_760_000_000_000
    },
    {
      site: '127.0.0.1',
      cookieCount: 1,
      cookieBytes: 9,
      usageBytes: 0,
      localStorage: false,
      originCount: 0
    }
  ]

  it('SD-U20 list-sites：原样回 listSites() 的结果，不带参数调一次', async () => {
    state.listSites.mockResolvedValueOnce(SITES)
    expect(await call('browser-data:list-sites')).toEqual(SITES)
    expect(state.listSites.mock.calls).toEqual([[]])
  })

  it('SD-U20 site-details 从桌面窗口来：转给 siteDetails(site)，原样回它的结果（含 null）', async () => {
    const details = {
      ...SITES[0],
      origins: [],
      cookies: [{ name: 'sid', value: 'secret-token', domain: '.github.com', path: '/' }]
    }
    state.siteDetails.mockResolvedValueOnce(details)
    expect(await call('browser-data:site-details', 'github.com')).toEqual(details)
    expect(state.siteDetails.mock.calls).toEqual([['github.com']])

    state.siteDetails.mockResolvedValueOnce(null)
    expect(await call('browser-data:site-details', 'nope.test')).toBeNull()
    expect(state.siteDetails.mock.calls.at(-1)).toEqual(['nope.test'])
  })

  it('SD-U20 site-details 从网络客户端来：null，连 siteDetails 都不调（Cookie 的值是登录令牌）', async () => {
    state.siteDetails.mockResolvedValue({ site: 'github.com', cookies: [{ value: 'secret' }] })
    expect(await callAs(NET_CTX, 'browser-data:site-details', 'github.com')).toBeNull()
    expect(state.siteDetails).not.toHaveBeenCalled()
  })

  it('SD-U20 网络客户端照样能列网站（列表里没有 Cookie 的值）', async () => {
    state.listSites.mockResolvedValueOnce(SITES)
    expect(await callAs(NET_CTX, 'browser-data:list-sites')).toEqual(SITES)
  })

  it.each([[''], [42], [null], [undefined], [{ site: 'github.com' }], [['github.com']]])(
    'SD-U20 site-details(%j)：不合法 → null，不调',
    async (site) => {
      expect(await call('browser-data:site-details', site)).toBeNull()
      expect(state.siteDetails).not.toHaveBeenCalled()
    }
  )
})

describe('删除通道的校验（SD-U21）', () => {
  it('SD-U21 clear-site：非空字符串 → clearSite(site)；别的忽略', async () => {
    await call('browser-data:clear-site', 'github.com')
    expect(state.clearSite.mock.calls).toEqual([['github.com']])
    for (const bad of ['', 42, null, undefined, { site: 'x' }]) {
      await call('browser-data:clear-site', bad)
    }
    expect(state.clearSite).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['cookies'],
    ['localStorage'],
    ['indexedDB'],
    ['cacheStorage'],
    ['serviceWorkers'],
    ['other']
  ])('SD-U21 clear-site-category(github.com, %s) → clearSiteCategory', async (category) => {
    await call('browser-data:clear-site-category', 'github.com', category)
    expect(state.clearSiteCategory.mock.calls).toEqual([['github.com', category]])
  })

  it.each([
    ['github.com', 'toString'],
    ['github.com', 'constructor'],
    ['github.com', 'cache'],
    ['github.com', 'Cookies'],
    ['github.com', ''],
    ['github.com', 42],
    ['github.com', undefined],
    ['', 'cookies'],
    [42, 'cookies'],
    [null, 'indexedDB']
  ])('SD-U21 clear-site-category(%j, %j)：忽略', async (site, category) => {
    await call('browser-data:clear-site-category', site, category)
    expect(state.clearSiteCategory).not.toHaveBeenCalled()
  })

  it('SD-U21 clear-origin：字符串原样转给 clearOrigin（是不是一个来源由它判断）；非字符串忽略', async () => {
    await call('browser-data:clear-origin', 'https://www.github.com')
    await call('browser-data:clear-origin', 'garbage')
    expect(state.clearOrigin.mock.calls).toEqual([['https://www.github.com'], ['garbage']])
    for (const bad of [42, null, undefined, { origin: 'https://a.test' }]) {
      await call('browser-data:clear-origin', bad)
    }
    expect(state.clearOrigin).toHaveBeenCalledTimes(2)
  })

  it('SD-U21 remove-cookie：对象原样转给 removeCookie；非对象忽略', async () => {
    const cookie = { name: 'sid', domain: '.github.com', path: '/', secure: true }
    await call('browser-data:remove-cookie', cookie)
    expect(state.removeCookie.mock.calls).toEqual([[cookie]])
    for (const bad of [null, undefined, 'sid', 42]) {
      await call('browser-data:remove-cookie', bad)
    }
    expect(state.removeCookie).toHaveBeenCalledTimes(1)
  })
})

describe('site-info 的 site（SD-U22）', () => {
  it('SD-U22 siteOfUrl 给出分组键：回包多一个 site；按地址的 href 问', async () => {
    state.cookies = [cookie({ name: 'a', domain: '.github.com', path: '/', secure: true })]
    state.siteOfUrl.mockReturnValue('github.com')
    expect(await call('browser-data:site-info', 'https://www.github.com/x')).toEqual({
      cookieCount: 1,
      certException: false,
      site: 'github.com'
    })
    expect(state.siteOfUrl.mock.calls).toEqual([['https://www.github.com/x']])
  })

  it('SD-U22 siteOfUrl 给不出（null）：没有 site 这个键', async () => {
    const info = await call('browser-data:site-info', 'http://127.0.0.1:5173/')
    expect(info).toEqual({ cookieCount: 0, certException: false })
    expect(info).not.toHaveProperty('site')
    expect(state.siteOfUrl).toHaveBeenCalledTimes(1)
  })

  it.each([['about:blank'], ['file:///a.html'], ['shuvix://settings'], [''], [42]])(
    'SD-U22 site-info(%j)：不是网页 → {0, false}，没有 site，不问 siteOfUrl',
    async (url) => {
      state.siteOfUrl.mockReturnValue('should-not-be-used')
      expect(await call('browser-data:site-info', url)).toEqual({
        cookieCount: 0,
        certException: false
      })
      expect(state.siteOfUrl).not.toHaveBeenCalled()
    }
  )
})
