/**
 * 内置浏览器的网站数据（2026-10-16，设置页 shuvix://settings → 隐私和安全 → 网站数据）：按网站分组的列表、
 * 站点详情与各种删除，对着真的浏览器分区。数据都是夹具页自己写的（经 DevTools 直连 tab 的页面 target 跑页面里的
 * 脚本：document.cookie、IndexedDB、Cache Storage、localStorage —— 写进去的字节是随机的，不会被 leveldb /
 * 缓存压缩掉）；「删掉了」一律回到页面里读、或看夹具服务器收到的下一个请求带没带那个 Cookie。
 *
 * 夹具：两台夹具服务器（127.0.0.1 上两个端口 = 同一个网站 127.0.0.1 的两个来源 A / B）+ 一个 localhost 的 tab
 * （另一个网站，只写 Cache Storage —— 它没有 Cookie、没有 IndexedDB 目录、没有本地存储，只能从 Chromium 的配额库
 * 里认出来）。一个实例按顺序走：
 *
 *   SD-E3  分组：127.0.0.1 一行 —— 5 个 Cookie（含同名的 sd_dup 在 / 与 /sub 上各一条）、2 个来源、占用 > 200 KB；
 *          网站名里没有端口；localhost 只有 Cache Storage 也列出来（配额库）；查占用借的临时 view 从不出现在
 *          tab 列表里，调用前后 about:blank 的页面 target 一样多；
 *   SD-E4  lastAccessed 落在本 spec 运行的时间窗里（配额库读对了的金丝雀）；
 *   SD-E5  IPC siteDetails：每个来源的占用分项（A 有 IndexedDB + Cache Storage，B 只有 IndexedDB）；Cookie 的各个字段；
 *          不认识的网站 → null；
 *   SD-E6  界面：列表按大小排（localhost 更大，排到前面）、合计一行；进 127.0.0.1 的详情：头部、类别、来源、
 *          Cookie 的值一次只展开一条；
 *   SD-E7  在界面上删一条 Cookie（sd_a）：页面的 document.cookie 与下一个请求的 Cookie 头里都没了，别的照带；
 *   SD-E8  删 /sub 上的 sd_dup：/ 上的 sd_dup 还在（精确删一条，不连带同名的）；
 *   SD-E9  删 Cache Storage 一类：A 的 caches 空了，A 的 IndexedDB 还在，另一个网站（localhost）的 caches 没动；
 *   SD-E10 删来源 B：B 的 IndexedDB 没了、B 那一行从详情里消失，Cookie 没动；
 *   SD-E11 删除全部 Cookie：详情里没有 Cookie 了、页面的 document.cookie 空了，网站因为 A 的 IndexedDB 还在列表里；
 *   SD-E12 删除这个网站的全部数据：详情变空态、siteDetails → null、列表里没了它；localhost 不受影响；
 *   SD-E13 本地存储（尽力而为 —— Chromium 攒几秒才落盘）：写一条之后网站以「本地存储」重新出现、类别写「有数据」；
 *          删这一类 → 页面的 localStorage 空了。删完之后它从列表里消失**不断**：压实后的 .ldb 里那个键要等下一次
 *          压实才没（产品注释写明的尽力而为），不是确定的事实。
 *
 * 断言优先走 IPC（`browserData.*`）；DOM 一律经 pages.ts 的 browserSettingsPagePane / browserSiteDetailsPane。
 * 文案随界面语言变 —— 需要比对文字的地方按三语候选认。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listTargets, until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { waitRendererReady } from '../../harness/seed'
import {
  browserSettingsPagePane,
  browserShellPane,
  browserSiteDetailsPane,
  browserWallPane,
  type BrowserSettingsPagePane,
  type BrowserShellPane,
  type BrowserSiteDetailsPane,
  type BrowserSiteDetailsShot
} from '../../harness/pages'
import {
  connectTabPage,
  startFixtureServer,
  type FixtureServer
} from '../../harness/browserFixtures'
import type { SiteDetails, SiteSummary } from '../../../src/shared/browserSiteData'

interface TabRow {
  id: string
  url: string
  active: boolean
  internalPage?: string
}

const KB = 1024
/** 写进各处的随机字节数 */
const IDB_A = 160 * KB
const IDB_B = 100 * KB
const CACHE_A = 80 * KB
/** localhost 的 Cache Storage 比 127.0.0.1 的全部加起来还大：按大小排时它在前面 */
const CACHE_L = 1536 * KB

// ─── 三语文案 ───
const cookiesText = (n: number): string[] =>
  n === 1
    ? ['1 cookie', '1 个 Cookie', 'Cookie 1 件']
    : [`${n} cookies`, `${n} 个 Cookie`, `Cookie ${n} 件`]
const originsText = (n: number): string[] =>
  n === 1
    ? ['1 origin', '1 个来源', 'オリジン 1 件']
    : [`${n} origins`, `${n} 个来源`, `オリジン ${n} 件`]
const LOCAL_STORAGE = ['Local storage', '本地存储', 'ローカルストレージ']
const HAS_DATA = ['Has data', '有数据', 'データあり']
const anyOf = (text: string, candidates: string[]): boolean =>
  candidates.some((c) => text.includes(c))

let app: E2EApp
let fxA: FixtureServer
let fxB: FixtureServer
let bw: CdpClient
let shell: BrowserShellPane
let page: BrowserSettingsPagePane
let details: BrowserSiteDetailsPane
/** spec 开始的时间（SD-E4 的时间窗下界） */
let t0 = 0
let tabA = ''
let tabB = ''
let tabL = ''
let originA = ''
let originB = ''

// ─── IPC 助手 ───

const listSites = (): Promise<SiteSummary[]> =>
  app.main.eval<SiteSummary[]>('window.api.browserData.listSites()')
const siteOf = async (site: string): Promise<SiteSummary | undefined> =>
  (await listSites()).find((s) => s.site === site)
const siteDetails = (site: string): Promise<SiteDetails | null> =>
  app.main.eval<SiteDetails | null>(`window.api.browserData.siteDetails(${JSON.stringify(site)})`)
const listTabs = (): Promise<TabRow[]> =>
  app.main.eval<TabRow[]>('window.api.browserView.listTabs()')
const createTab = (url: string): Promise<string> =>
  app.main.eval<string>(`window.api.browserView.createTab(${JSON.stringify(url)})`)
const aboutBlankTargets = async (): Promise<number> =>
  (await listTargets(app.port)).filter((t) => t.type === 'page' && t.url === 'about:blank').length

/** 在 url 以 prefix 开头的那个 tab 的页面里跑一段表达式（DevTools 直连，不经 agent 的工具） */
async function inPage<T>(prefix: string, expr: string): Promise<T> {
  const client = await until(
    () => connectTabPage(app.port, (u) => u.startsWith(prefix)),
    `tab page ${prefix}`
  )
  try {
    return await client.eval<T>(expr)
  } finally {
    client.close()
  }
}

/** 页面里：n 个随机字节（getRandomValues 一次最多 64 KB） */
const RANDOM_BYTES = `(n) => {
  const a = new Uint8Array(n)
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(a.subarray(i, Math.min(n, i + 65536)))
  return a
}`

/** 页面里：往 IndexedDB 'sd' 的 'blobs' 存一段 n 字节的随机数据，写完关掉连接 */
const writeIdb = (n: number): string => `(async () => {
  const rnd = ${RANDOM_BYTES}
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('sd', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('blobs')
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('blobs', 'readwrite')
      tx.objectStore('blobs').put(rnd(${n}), 'k')
      tx.oncomplete = () => { db.close(); resolve(true) }
      tx.onerror = () => reject(tx.error)
    }
  })
  return true
})()`

/** 页面里：往 Cache Storage 'sd' 放一条 n 字节的随机响应 */
const writeCache = (n: number): string => `(async () => {
  const rnd = ${RANDOM_BYTES}
  const cache = await caches.open('sd')
  await cache.put('/sd-cache', new Response(rnd(${n}), { headers: { 'Content-Type': 'application/octet-stream' } }))
  return true
})()`

/** 页面里：IndexedDB 'sd' 在不在（databases() 不会顺手建一个出来） */
const IDB_NAMES = `indexedDB.databases().then((dbs) => dbs.map((d) => d.name))`
/** 页面里：'sd' 里那段数据的字节数（库在才调） */
const IDB_VALUE_SIZE = `new Promise((resolve, reject) => {
  const req = indexedDB.open('sd', 1)
  req.onerror = () => reject(req.error)
  req.onsuccess = () => {
    const db = req.result
    const get = db.transaction('blobs').objectStore('blobs').get('k')
    get.onsuccess = () => { db.close(); resolve(get.result ? get.result.byteLength : -1) }
    get.onerror = () => { db.close(); reject(get.error) }
  }
})`
const CACHE_NAMES = `caches.keys()`

/** 页面里：fetch 一个地址（夹具记下它带的 Cookie 头），回 true */
const fetchPath = (path: string): string => `fetch(${JSON.stringify(path)}).then(() => true)`
/** 夹具收到的、path 恰好是 p 的最后一个请求的 Cookie 头 */
const cookieHeaderOf = (fx: FixtureServer, p: string): string | undefined =>
  fx
    .requests()
    .filter((r) => r.path === p)
    .at(-1)?.cookie

/** 等详情页挂着某个网站、读完（不是 Loading…） */
const loadedDetails = (
  site: string,
  what = `details of ${site}`
): Promise<BrowserSiteDetailsShot> =>
  until(async () => {
    const shot = await details.shot()
    return shot.site === site && !shot.loading && (shot.header !== '' || shot.empty) ? shot : null
  }, what)

beforeAll(async () => {
  t0 = Date.now()
  app = await launchApp()
  await waitRendererReady(app.main)
  fxA = await startFixtureServer()
  fxB = await startFixtureServer()
  originA = fxA.origin
  originB = fxB.origin
  await app.main.eval('window.api.browserView.openWindow()')
  await until(
    () => app.main.eval<boolean>('window.api.browserView.isWindowOpen()'),
    'browser window open'
  )
  bw = await until(() => app.browserWindow(), 'browser window page')
  shell = browserShellPane(bw)
  page = browserSettingsPagePane(bw)
  details = browserSiteDetailsPane(bw)
  await until(() => browserWallPane(bw).mounted(), 'browser window shell mounted')

  // ── 三个 tab：127.0.0.1 的 A / B 两个来源，localhost 一个 ──
  tabA = await createTab(fxA.url('/counter.html?sd=a'))
  tabB = await createTab(fxB.url('/counter.html?sd=b'))
  tabL = await createTab(fxA.localhostUrl('/counter.html?sd=lh'))
  await until(() => fxA.hits('/counter.html?sd=a') === 1, 'tab A loaded')
  await until(() => fxB.hits('/counter.html?sd=b') === 1, 'tab B loaded')
  await until(() => fxA.hits('/counter.html?sd=lh') === 1, 'localhost tab loaded')

  // ── A：四个 Cookie（同名的 sd_dup 在 / 与 /sub 上各一条，sd_sess 是会话 Cookie）+ IndexedDB + Cache Storage ──
  await inPage(
    originA,
    `(() => {
      document.cookie = 'sd_a=1; path=/; max-age=86400'
      document.cookie = 'sd_dup=root; path=/; max-age=86400'
      document.cookie = 'sd_dup=sub; path=/sub; max-age=86400'
      document.cookie = 'sd_sess=s; path=/'
      return document.cookie
    })()`
  )
  expect(await inPage<boolean>(originA, writeIdb(IDB_A))).toBe(true)
  expect(await inPage<boolean>(originA, writeCache(CACHE_A))).toBe(true)
  // ── B：一个 SameSite=Strict 的 Cookie（同一主机，端口不同也是同一份 Cookie）+ IndexedDB ──
  await inPage(
    originB,
    `(() => { document.cookie = 'sd_b=2; path=/; max-age=86400; SameSite=Strict'; return true })()`
  )
  expect(await inPage<boolean>(originB, writeIdb(IDB_B))).toBe(true)
  // ── localhost：只有 Cache Storage ──
  expect(await inPage<boolean>(fxA.localhostOrigin, writeCache(CACHE_L))).toBe(true)
}, 120_000)

afterAll(async () => {
  bw?.close()
  await fxA?.close()
  await fxB?.close()
  await app?.stop()
})

describe('列表与 IPC（SD-E3 / SD-E4 / SD-E5）', () => {
  it('SD-E3 分组：127.0.0.1 一行（5 个 Cookie、2 个来源、> 200 KB），localhost 只有 Cache Storage 也在；网站名不带端口；临时 view 不是 tab、用完就没', async () => {
    const sites = await until(
      async () => {
        const list = await listSites()
        const ip = list.find((s) => s.site === '127.0.0.1')
        const lh = list.find((s) => s.site === 'localhost')
        return ip &&
          ip.cookieCount === 5 &&
          ip.originCount === 2 &&
          ip.usageBytes > 200 * KB &&
          lh &&
          lh.usageBytes > CACHE_L / 2
          ? list
          : null
      },
      '127.0.0.1 (5 cookies, 2 origins, > 200 KB) and localhost (cache only) listed',
      60_000
    )
    for (const s of sites) expect(s.site, s.site).not.toContain(':')
    const ip = sites.find((s) => s.site === '127.0.0.1')!
    expect(ip.cookieBytes).toBe(
      'sd_a1'.length + 'sd_duproot'.length + 'sd_dupsub'.length + 'sd_sesss'.length + 'sd_b2'.length
    )
    expect(ip.localStorage).toBe(false)
    const lh = sites.find((s) => s.site === 'localhost')!
    expect(lh).toMatchObject({
      cookieCount: 0,
      cookieBytes: 0,
      originCount: 1,
      localStorage: false
    })

    // ── 查占用借的临时 view：不是 tab，调用之后不留 ──
    const tabsBefore = (await listTabs()).map((t) => t.id)
    expect(tabsBefore).toEqual(expect.arrayContaining([tabA, tabB, tabL]))
    const blankBefore = await aboutBlankTargets()
    await listSites()
    await siteDetails('127.0.0.1')
    expect((await listTabs()).map((t) => t.id)).toEqual(tabsBefore)
    await until(
      async () => (await aboutBlankTargets()) === blankBefore,
      'no about:blank page target left behind by the usage helper',
      10_000
    )
  }, 90_000)

  it('SD-E4 lastAccessed 落在本 spec 的时间窗里（配额库读对了）', async () => {
    const ip = await until(
      async () => {
        const s = await siteOf('127.0.0.1')
        return s?.lastAccessed ? s : null
      },
      '127.0.0.1 has lastAccessed from the quota database',
      60_000
    )
    expect(ip.lastAccessed!).toBeGreaterThanOrEqual(t0 - 5_000)
    expect(ip.lastAccessed!).toBeLessThanOrEqual(Date.now() + 5_000)
    const lh = await until(
      async () => {
        const s = await siteOf('localhost')
        return s?.lastAccessed ? s : null
      },
      'localhost has lastAccessed',
      60_000
    )
    expect(lh.lastAccessed!).toBeGreaterThanOrEqual(t0 - 5_000)
  }, 150_000)

  it('SD-E5 siteDetails：每个来源的占用分项、Cookie 的各个字段；不认识的网站 → null', async () => {
    const d = (await siteDetails('127.0.0.1'))!
    expect(d).not.toBeNull()
    expect(d.site).toBe('127.0.0.1')
    expect(d.cookieCount).toBe(5)
    expect(d.originCount).toBe(2)
    expect(d.origins.map((o) => o.origin).sort()).toEqual([originA, originB].sort())
    expect(d.origins.map((o) => o.origin)).toEqual(
      [...d.origins.map((o) => o.origin)].sort((x, y) => x.localeCompare(y))
    )
    const a = d.origins.find((o) => o.origin === originA)!
    const b = d.origins.find((o) => o.origin === originB)!
    expect(a.usage.indexedDB).toBeGreaterThan(IDB_A / 2)
    expect(a.usage.cacheStorage).toBeGreaterThan(CACHE_A / 2)
    expect(b.usage.indexedDB).toBeGreaterThan(IDB_B / 2)
    expect(b.usage.cacheStorage).toBe(0)
    expect(a.localStorage).toBe(false)
    expect(d.usageBytes).toBe(a.usageBytes + b.usageBytes)

    // Cookie：按 `域|路径|名字` 认
    const byKey = new Map(d.cookies.map((c) => [`${c.domain}|${c.path}|${c.name}`, c]))
    expect([...byKey.keys()].sort()).toEqual(
      [
        '127.0.0.1|/|sd_a',
        '127.0.0.1|/|sd_b',
        '127.0.0.1|/|sd_dup',
        '127.0.0.1|/sub|sd_dup',
        '127.0.0.1|/|sd_sess'
      ].sort()
    )
    const sdA = byKey.get('127.0.0.1|/|sd_a')!
    expect(sdA).toMatchObject({
      name: 'sd_a',
      value: '1',
      domain: '127.0.0.1',
      path: '/',
      secure: false,
      httpOnly: false,
      hostOnly: true,
      size: 5
    })
    expect(sdA.expires).toBeGreaterThan(Date.now() + 86_400_000 - 300_000)
    expect(sdA.expires).toBeLessThan(Date.now() + 86_400_000 + 300_000)
    expect(byKey.get('127.0.0.1|/|sd_sess')).not.toHaveProperty('expires')
    expect(byKey.get('127.0.0.1|/|sd_b')?.sameSite).toBe('strict')
    expect(byKey.get('127.0.0.1|/|sd_dup')?.value).toBe('root')
    expect(byKey.get('127.0.0.1|/sub|sd_dup')?.value).toBe('sub')

    const lh = (await siteDetails('localhost'))!
    expect(lh.cookies).toEqual([])
    expect(lh.origins).toHaveLength(1)
    expect(lh.origins[0].origin).toBe(fxA.localhostOrigin)
    expect(lh.origins[0].usage.cacheStorage).toBeGreaterThan(CACHE_L / 2)

    expect(await siteDetails('nope.example')).toBeNull()
  }, 60_000)
})

describe('设置页里的列表与详情（SD-E6）', () => {
  it('SD-E6 列表按大小排、合计一行；127.0.0.1 的详情：头部、类别、来源、Cookie 的值一次展开一条', async () => {
    await shell.moreMenu('settings')
    await until(async () => {
      const row = (await listTabs()).find((t) => t.active)
      return row?.internalPage === 'settings'
    }, 'settings tab selected')
    const listed = await until(async () => {
      const x = await page.shot()
      const names = x.sites.map((r) => r.site)
      return names.includes('127.0.0.1') && names.includes('localhost') ? x : null
    }, 'settings page lists both sites')
    expect(listed.siteSort).toBe('name')
    expect(listed.sites.map((r) => r.site)).toEqual(['127.0.0.1', 'localhost'])
    // 合计一行：两个网站
    expect(listed.siteTotal).toMatch(/(^2 sites, )|(共 2 个网站)|(^2 サイト)/)
    const ipRow = listed.sites.find((r) => r.site === '127.0.0.1')!
    expect(anyOf(ipRow.subtitle, cookiesText(5)), ipRow.subtitle).toBe(true)
    expect(ipRow.subtitle).toMatch(/^\d+(\.\d)? (KB|MB) · /)
    const lhRow = listed.sites.find((r) => r.site === 'localhost')!
    expect(anyOf(lhRow.subtitle, cookiesText(0)), lhRow.subtitle).toBe(true)
    expect(lhRow.subtitle).toMatch(/^\d+(\.\d)? MB · /)

    // ── 按大小排：localhost 的 Cache Storage 更大 ──
    await page.chooseSiteSort('size')
    await until(async () => {
      const x = await page.shot()
      return x.siteSort === 'size' && x.sites.map((r) => r.site).join() === 'localhost,127.0.0.1'
        ? x
        : null
    }, 'sorted by size: localhost first')
    await page.chooseSiteSort('name')

    // ── 进 127.0.0.1 的详情 ──
    await page.openSite('127.0.0.1')
    const d = await loadedDetails('127.0.0.1')
    expect(anyOf(d.header, cookiesText(5)), d.header).toBe(true)
    expect(anyOf(d.header, originsText(2)), d.header).toBe(true)
    expect(d.header).toMatch(/^\d+(\.\d)? KB · /)
    expect(d.categories.map((c) => c.category)).toEqual(['indexedDB', 'cacheStorage'])
    for (const c of d.categories) expect(c.value, c.category).toMatch(/^\d+(\.\d)? KB$/)
    expect(d.origins.map((o) => o.origin).sort()).toEqual([originA, originB].sort())
    for (const o of d.origins) expect(o.subtitle, o.origin).toMatch(/^\d+(\.\d)? KB/)
    expect(d.cookies.map((c) => c.key).sort()).toEqual(
      [
        '127.0.0.1|/|sd_a',
        '127.0.0.1|/|sd_b',
        '127.0.0.1|/|sd_dup',
        '127.0.0.1|/sub|sd_dup',
        '127.0.0.1|/|sd_sess'
      ].sort()
    )
    expect(d.cookies.every((c) => c.value === null)).toBe(true)

    // ── Cookie 的值：一次只展开一条 ──
    await details.toggleCookie('127.0.0.1|/|sd_a')
    let shot = await details.shot()
    expect(shot.cookies.filter((c) => c.value !== null).map((c) => [c.key, c.value])).toEqual([
      ['127.0.0.1|/|sd_a', '1']
    ])
    await details.toggleCookie('127.0.0.1|/sub|sd_dup')
    shot = await details.shot()
    expect(shot.cookies.filter((c) => c.value !== null).map((c) => [c.key, c.value])).toEqual([
      ['127.0.0.1|/sub|sd_dup', 'sub']
    ])
    await details.toggleCookie('127.0.0.1|/sub|sd_dup')
    shot = await details.shot()
    expect(shot.cookies.every((c) => c.value === null)).toBe(true)
  }, 90_000)
})

describe('删除（SD-E7 … SD-E12）', () => {
  it('SD-E7 删一条 Cookie（sd_a）：页面的 document.cookie 与下一个请求里都没了，别的照带', async () => {
    await details.deleteCookie('127.0.0.1|/|sd_a')
    await until(
      async () => !(await details.shot()).cookies.some((c) => c.key === '127.0.0.1|/|sd_a'),
      'sd_a row gone from the details page'
    )
    const d = (await siteDetails('127.0.0.1'))!
    expect(d.cookies.map((c) => c.name)).not.toContain('sd_a')
    expect(d.cookieCount).toBe(4)

    const jar = await inPage<string>(originA, 'document.cookie')
    expect(jar).not.toContain('sd_a=')
    expect(jar).toContain('sd_dup=root')
    expect(await inPage<boolean>(originA, fetchPath('/report?sd=e7'))).toBe(true)
    const header = await until(() => cookieHeaderOf(fxA, '/report?sd=e7'), 'e7 request recorded')
    expect(header).not.toContain('sd_a=')
    expect(header).toContain('sd_dup=root')
    expect(header).toContain('sd_b=2')
  }, 60_000)

  it('SD-E8 删 /sub 上的 sd_dup：/ 上的 sd_dup 还在（只删那一条）', async () => {
    // 对照：此刻 /sub 下的请求两条 sd_dup 都带
    expect(await inPage<boolean>(originA, fetchPath('/sub/x?sd=e8-before'))).toBe(true)
    const before = await until(
      () => cookieHeaderOf(fxA, '/sub/x?sd=e8-before'),
      'e8-before request recorded'
    )
    expect(before).toContain('sd_dup=sub')
    expect(before).toContain('sd_dup=root')

    await details.deleteCookie('127.0.0.1|/sub|sd_dup')
    await until(
      async () => !(await details.shot()).cookies.some((c) => c.key === '127.0.0.1|/sub|sd_dup'),
      '/sub sd_dup row gone'
    )
    const shot = await details.shot()
    expect(shot.cookies.map((c) => c.key)).toContain('127.0.0.1|/|sd_dup')
    const d = (await siteDetails('127.0.0.1'))!
    expect(d.cookies.filter((c) => c.name === 'sd_dup').map((c) => [c.path, c.value])).toEqual([
      ['/', 'root']
    ])

    expect(await inPage<boolean>(originA, fetchPath('/sub/x?sd=e8-after'))).toBe(true)
    const after = await until(() => cookieHeaderOf(fxA, '/sub/x?sd=e8-after'), 'e8-after request')
    expect(after).not.toContain('sd_dup=sub')
    expect(after).toContain('sd_dup=root')
  }, 60_000)

  it('SD-E9 删 Cache Storage 一类：A 的 caches 空了、A 的 IndexedDB 还在，localhost 的 caches 没动', async () => {
    expect(await inPage<string[]>(originA, CACHE_NAMES)).toEqual(['sd'])
    await details.deleteConfirmed('cacheStorage')
    await until(
      async () => (await inPage<string[]>(originA, CACHE_NAMES)).length === 0,
      "A's Cache Storage emptied"
    )
    await until(
      async () => !(await details.shot()).categories.some((c) => c.category === 'cacheStorage'),
      'cache storage category gone from the details page'
    )
    // IndexedDB 没动（值还在、字节数一样）
    expect(await inPage<string[]>(originA, IDB_NAMES)).toContain('sd')
    expect(await inPage<number>(originA, IDB_VALUE_SIZE)).toBe(IDB_A)
    expect((await details.shot()).categories.map((c) => c.category)).toContain('indexedDB')
    // 另一个网站的 Cache Storage 没动
    expect(await inPage<string[]>(fxA.localhostOrigin, CACHE_NAMES)).toEqual(['sd'])
    expect((await siteOf('localhost'))?.usageBytes).toBeGreaterThan(CACHE_L / 2)
  }, 60_000)

  it('SD-E10 删来源 B：B 的 IndexedDB 没了、那一行从详情里消失，Cookie 没动', async () => {
    const cookiesBefore = (await siteDetails('127.0.0.1'))!.cookies.length
    await details.deleteConfirmed(`origin:${originB}`)
    await until(
      async () => !(await details.shot()).origins.some((o) => o.origin === originB),
      'origin B row gone from the details page'
    )
    const d = (await siteDetails('127.0.0.1'))!
    expect(d.origins.map((o) => o.origin)).toEqual([originA])
    expect(d.cookies).toHaveLength(cookiesBefore)
    expect(await inPage<string[]>(originB, IDB_NAMES)).not.toContain('sd')
    // A 的没动
    expect(await inPage<number>(originA, IDB_VALUE_SIZE)).toBe(IDB_A)
  }, 60_000)

  it('SD-E11 删除全部 Cookie：详情里没有 Cookie、页面的 document.cookie 空了；网站因为 A 的 IndexedDB 还在', async () => {
    await details.deleteConfirmed('cookies')
    await until(async () => (await details.shot()).cookies.length === 0, 'no cookie rows left')
    const d = (await siteDetails('127.0.0.1'))!
    expect(d.cookies).toEqual([])
    expect(d.cookieCount).toBe(0)
    expect(await inPage<string>(originA, 'document.cookie')).toBe('')
    expect(await inPage<string>(originB, 'document.cookie')).toBe('')
    const ip = await siteOf('127.0.0.1')
    expect(ip).toMatchObject({ cookieCount: 0, originCount: 1 })
    expect(ip!.usageBytes).toBeGreaterThan(IDB_A / 2)
  }, 60_000)

  it('SD-E12 删除这个网站的全部数据：详情变空态、siteDetails → null、列表里没了；localhost 不受影响', async () => {
    await details.deleteConfirmed('site')
    await until(async () => (await details.shot()).empty, 'details page shows the empty state')
    expect(await siteDetails('127.0.0.1')).toBeNull()
    const sites = await listSites()
    expect(sites.map((s) => s.site)).not.toContain('127.0.0.1')
    expect(sites.find((s) => s.site === 'localhost')?.usageBytes).toBeGreaterThan(CACHE_L / 2)
    expect(await inPage<string[]>(originA, IDB_NAMES)).not.toContain('sd')
    expect(await inPage<string[]>(fxA.localhostOrigin, CACHE_NAMES)).toEqual(['sd'])

    // 返回列表：只剩 localhost
    await details.back()
    await until(async () => {
      const x = await page.shot()
      return x.sites.map((r) => r.site).join() === 'localhost'
    }, 'list shows only localhost')
  }, 60_000)
})

describe('本地存储（SD-E13，尽力而为）', () => {
  it('SD-E13 写一条 localStorage → 网站以「本地存储」重新出现、类别写「有数据」；删这一类 → 页面的 localStorage 空了', async () => {
    await inPage(
      originA,
      `(() => { localStorage.setItem('sd_ls', 'x'.repeat(2048)); return localStorage.length })()`
    )
    // Chromium 攒几秒才把本地存储落盘：等它出现在列表里
    const ip = await until(
      async () => {
        const s = await siteOf('127.0.0.1')
        return s?.localStorage ? s : null
      },
      '127.0.0.1 listed again with local storage',
      30_000
    )
    expect(ip).toMatchObject({ cookieCount: 0, localStorage: true, originCount: 1 })

    // 设置页的列表不会自己刷新：选一下别的 tab 再选回设置页（单页视图里设置页重新挂载、重新列）
    const settingsTab = (await listTabs()).find((t) => t.internalPage === 'settings')!.id
    await shell.clickTab(tabA)
    await until(async () => !(await page.shot()).present, 'settings page off screen')
    await shell.clickTab(settingsTab)
    const row = await until(async () => {
      const x = await page.shot()
      return x.sites.find((r) => r.site === '127.0.0.1') ?? null
    }, 'settings list shows 127.0.0.1 again')
    expect(anyOf(row.subtitle, LOCAL_STORAGE), row.subtitle).toBe(true)

    await page.openSite('127.0.0.1')
    const d = await loadedDetails('127.0.0.1')
    const ls = d.categories.find((c) => c.category === 'localStorage')
    expect(ls && anyOf(ls.value, HAS_DATA), JSON.stringify(d.categories)).toBe(true)
    const a = d.origins.find((o) => o.origin === originA)
    expect(a && anyOf(a.subtitle, LOCAL_STORAGE), JSON.stringify(d.origins)).toBe(true)

    await details.deleteConfirmed('localStorage')
    // 确定的那一半：后端清掉了，活着的页面看得见
    await until(
      async () => (await inPage<number>(originA, 'localStorage.length')) === 0,
      "A's localStorage emptied",
      10_000
    )
    expect(await inPage<string | null>(originA, `localStorage.getItem('sd_ls')`)).toBeNull()
    // 删完之后它从列表 / 详情里消失不断：压实后的 .ldb 里那个键要等下一次压实（尽力而为，见文件头）
  }, 90_000)
})
