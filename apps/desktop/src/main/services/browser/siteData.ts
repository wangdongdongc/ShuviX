/**
 * 内置浏览器的网站数据 —— 设置页里的网站列表、站点详情与删除（照 Chrome 的 chrome://settings/content/all）。
 *
 * Electron 没有「列出存过数据的来源」这个 API，这里把能拿到的三处拼起来（2026-10-16 实测，Electron 39）：
 *  - **Cookie**：`session.cookies.get({})`，逐条可读可删；
 *  - **配额存储**（IndexedDB、Cache Storage、Service Worker、文件系统）：Chromium 自己的配额库
 *    `<分区>/WebStorage/QuotaManager`（SQLite）里每个用过的来源一行 `buckets`，浏览器开着也能只读打开；
 *    旧布局下的 `IndexedDB/<scheme>_<host>_<port>.indexeddb.*` 目录名兜底；
 *  - **本地存储**（localStorage）：不计入配额、配额库里没有，只能从 `Local Storage/leveldb` 的文件里认出
 *    键前缀里的来源（尽力而为：压实后的 .ldb 里前缀可能被压缩，认不全）；大小拿不到。
 * 占用大小用 CDP `Storage.getUsageAndQuota` 按来源查 —— 浏览器级的命令，借一个不挂任何窗口、只装着
 * about:blank 的临时 webContents 发（实测可用），查完就关。它不是 tab：不进 tab 表，agent 与界面都看不见。
 *
 * 分组键是可注册域名（eTLD+1，tldts，含 github.io 这类私有后缀 —— 与 Chrome 的站点分组一致）；
 * IP 与 localhost 就是主机名本身。
 *
 * 删除一律走 Electron 自己的 `clearData`（按类别、按来源，实测各类别都只删到指定来源）与逐条
 * `cookies.remove`（Cookie 按域名而不是按来源存，www.github.com 的登录态常记在 github.com 上）。
 */

import { session, WebContentsView, type Cookie } from 'electron'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { getDomain } from 'tldts'
import { createLogger } from '../../logger'
import { BROWSER_PARTITION } from './browserViewService'
import type {
  SiteCookie,
  SiteDataCategory,
  SiteDetails,
  SiteOriginData,
  SiteSummary,
  SiteUsage
} from '../../../shared/browserSiteData'

const log = createLogger('BrowserSiteData')

/** 一次 CDP 查询的上限：查不到就当 0，列表不因为一个来源卡住 */
const USAGE_TIMEOUT_MS = 3000
/** 同时查几个来源 */
const USAGE_CONCURRENCY = 6
/** Chromium 的时间（1601-01-01 起的微秒）→ Unix 毫秒 */
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000

/** 主机名 → 分组键（可注册域名；IP / localhost / 认不出的就是主机名本身） */
export function siteOfHost(host: string): string {
  const h = host.replace(/^\./, '').toLowerCase()
  return getDomain(h, { allowPrivateDomains: true }) ?? h
}

/** 一个地址 → 分组键；不是网页地址回 null */
export function siteOfUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname
      ? siteOfHost(u.hostname)
      : null
  } catch {
    return null
  }
}

function sess(): Electron.Session {
  return session.fromPartition(BROWSER_PARTITION)
}

/** 合法的 http(s) 来源（`https://host[:port]`）；别的回 null */
function originOf(raw: string): string | null {
  try {
    const u = new URL(raw)
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname) return null
    return u.origin
  } catch {
    return null
  }
}

interface OriginSeen {
  localStorage: boolean
  lastAccessed?: number
}

/** 配额库里用过存储的来源（与最近使用时间）；库打不开就回空（不让列表失败） */
function quotaOrigins(storagePath: string, into: Map<string, OriginSeen>): void {
  const file = join(storagePath, 'WebStorage', 'QuotaManager')
  if (!existsSync(file)) return
  let db: Database.Database | null = null
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 300 })
    const rows = db.prepare('SELECT storage_key, last_accessed FROM buckets').all() as Array<{
      storage_key: string
      last_accessed: number | null
    }>
    for (const row of rows) {
      // 第三方分区存储的键是 `https://embed/^0https://top`：只认前面那个来源
      const origin = originOf(String(row.storage_key).split('^')[0])
      if (!origin) continue
      const seen = into.get(origin) ?? { localStorage: false }
      const at = row.last_accessed
        ? Math.round(row.last_accessed / 1000 - CHROME_EPOCH_OFFSET_MS)
        : 0
      if (at > 0 && at > (seen.lastAccessed ?? 0)) seen.lastAccessed = at
      into.set(origin, seen)
    }
  } catch (err) {
    log.warn(`Reading the quota database failed: ${err}`)
  } finally {
    db?.close()
  }
}

/** IndexedDB 目录名里的来源（`https_www.x.com_0.indexeddb.leveldb`，端口 0 = 缺省端口） */
function indexedDbOrigins(storagePath: string, into: Map<string, OriginSeen>): void {
  const dir = join(storagePath, 'IndexedDB')
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const m = /^(https?)_(.+)_(\d+)\.indexeddb\.(?:leveldb|blob)$/.exec(name)
    if (!m) continue
    const origin = originOf(`${m[1]}://${m[2]}${m[3] === '0' ? '' : `:${m[3]}`}`)
    if (origin && !into.has(origin)) into.set(origin, { localStorage: false })
  }
}

/** 本地存储的数据键：`_<origin>\0\x01<键>`（值、别的键里恰好出现的 `_https://…` 后面不会紧跟 \0\x01） */
const LOCAL_STORAGE_KEY = new RegExp(
  `_(https?://[A-Za-z0-9.\\-[\\]:]+)${String.fromCharCode(0, 1)}`,
  'g'
)

/**
 * 写前日志（.log）里键 p 处那条操作：键前面是 varint 键长，再前面是类型字节（1 = 写入、0 = 删除）。
 * 认不出（不是一条操作的键 —— 比如出现在值里）回 null。
 */
function logOpAt(text: string, p: number, minLen: number): { type: 0 | 1; len: number } | null {
  const b1 = text.charCodeAt(p - 1)
  if (p >= 2 && b1 < 0x80) {
    const type = text.charCodeAt(p - 2)
    if ((type === 0 || type === 1) && b1 >= minLen) return { type, len: b1 }
  }
  if (p >= 3 && b1 < 0x80) {
    const lo = text.charCodeAt(p - 2)
    const type = text.charCodeAt(p - 3)
    const len = (lo & 0x7f) | (b1 << 7)
    if (lo & 0x80 && (type === 0 || type === 1) && len >= minLen) return { type, len }
  }
  return null
}

/**
 * Local Storage（leveldb）里存着数据的来源。尽力而为：
 *  - 写前日志 .log 按文件编号、文件内按出现顺序重放每个键的写入 / 删除，删光了的来源不算；
 *  - 压实后的 .ldb 表里键可能被前缀压缩、类型不在键前，只能按「出现过 = 有」算 —— 删掉的要等下一次压实
 *    才从这里消失；
 *  - Chromium 攒几秒才落盘，刚写的认不出来。
 */
function localStorageOrigins(storagePath: string, into: Map<string, OriginSeen>): void {
  const dir = join(storagePath, 'Local Storage', 'leveldb')
  if (!existsSync(dir)) return
  const fileNo = (name: string): number => Number(/^(\d+)/.exec(name)?.[1] ?? 0)
  const files = readdirSync(dir)
    .filter((name) => /\.(log|ldb)$/.test(name))
    .sort((a, b) => fileNo(a) - fileNo(b))
  const fromTables = new Set<string>()
  /** .log 里最后一次是写入的键 → 它的来源 */
  const liveKeys = new Map<string, string>()
  for (const name of files) {
    let text: string
    try {
      text = readFileSync(join(dir, name)).toString('latin1')
    } catch {
      continue
    }
    const isLog = name.endsWith('.log')
    for (const m of text.matchAll(LOCAL_STORAGE_KEY)) {
      const origin = originOf(m[1])
      if (!origin) continue
      if (!isLog) {
        fromTables.add(origin)
        continue
      }
      const op = logOpAt(text, m.index, m[0].length)
      if (!op) continue
      const key = text.slice(m.index, m.index + op.len)
      if (op.type === 1) liveKeys.set(key, origin)
      else liveKeys.delete(key)
    }
  }
  for (const origin of new Set([...fromTables, ...liveKeys.values()])) {
    const seen = into.get(origin) ?? { localStorage: false }
    seen.localStorage = true
    into.set(origin, seen)
  }
}

/** 用过存储的全部来源（配额库 + IndexedDB 目录 + 本地存储） */
function storedOrigins(): Map<string, OriginSeen> {
  const origins = new Map<string, OriginSeen>()
  const storagePath = sess().getStoragePath()
  if (!storagePath) return origins
  quotaOrigins(storagePath, origins)
  indexedDbOrigins(storagePath, origins)
  localStorageOrigins(storagePath, origins)
  return origins
}

const EMPTY_USAGE: SiteUsage = { indexedDB: 0, cacheStorage: 0, serviceWorkers: 0, other: 0 }

/**
 * 按来源查配额存储占用：借一个临时的、不挂窗口的 about:blank webContents 接上调试器发
 * `Storage.getUsageAndQuota`（浏览器级命令，与它显示什么无关），查完关掉。
 */
async function usageOf(
  origins: string[]
): Promise<Map<string, { total: number; usage: SiteUsage }>> {
  const result = new Map<string, { total: number; usage: SiteUsage }>()
  if (origins.length === 0) return result
  const view = new WebContentsView({
    webPreferences: {
      partition: BROWSER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  const wc = view.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  /** 一个来源：查到就记，超时 / 失败当 0（计时器用完就清） */
  const queryOne = async (origin: string): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const r = (await Promise.race([
        wc.debugger.sendCommand('Storage.getUsageAndQuota', { origin }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), USAGE_TIMEOUT_MS)
        })
      ])) as { usage: number; usageBreakdown: Array<{ storageType: string; usage: number }> }
      const usage: SiteUsage = { ...EMPTY_USAGE }
      for (const b of r.usageBreakdown ?? []) {
        if (!b.usage) continue
        if (b.storageType === 'indexeddb') usage.indexedDB += b.usage
        else if (b.storageType === 'cache_storage') usage.cacheStorage += b.usage
        else if (b.storageType === 'service_workers') usage.serviceWorkers += b.usage
        else usage.other += b.usage
      }
      result.set(origin, { total: r.usage || 0, usage })
    } catch (err) {
      log.warn(`Storage usage for ${origin} failed: ${err}`)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  try {
    await wc.loadURL('about:blank')
    wc.debugger.attach('1.3')
    // 几个一起查：浏览器级命令，互不相干；一个慢的不拖住整张列表
    for (let i = 0; i < origins.length; i += USAGE_CONCURRENCY) {
      await Promise.all(origins.slice(i, i + USAGE_CONCURRENCY).map(queryOne))
    }
  } catch (err) {
    log.warn(`Storage usage helper failed: ${err}`)
  } finally {
    try {
      if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
    } catch {
      // 已经断开
    }
    if (!wc.isDestroyed()) wc.close()
  }
  return result
}

function cookieHost(c: Cookie): string {
  return (c.domain ?? '').replace(/^\./, '').toLowerCase()
}

function toSiteCookie(c: Cookie): SiteCookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain ?? '',
    path: c.path ?? '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    hostOnly: !!c.hostOnly,
    sameSite: c.sameSite ?? 'unspecified',
    ...(c.session || !c.expirationDate ? {} : { expires: Math.round(c.expirationDate * 1000) }),
    size: c.name.length + c.value.length
  }
}

/** 一条 Cookie 的删除地址（cookies.remove 按 url + 名字认） */
function cookieUrl(c: { domain?: string; path?: string; secure?: boolean }): string {
  const host = (c.domain ?? '').replace(/^\./, '')
  return `${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`
}

interface Collected {
  cookies: Cookie[]
  origins: Map<string, OriginSeen>
}

async function collect(): Promise<Collected> {
  const cookies = await sess().cookies.get({})
  return { cookies, origins: storedOrigins() }
}

function summarize(site: string, cookies: Cookie[], origins: SiteOriginData[]): SiteSummary {
  const lastAccessed = origins.reduce<number | undefined>(
    (acc, o) => (o.lastAccessed && (!acc || o.lastAccessed > acc) ? o.lastAccessed : acc),
    undefined
  )
  return {
    site,
    cookieCount: cookies.length,
    cookieBytes: cookies.reduce((n, c) => n + c.name.length + c.value.length, 0),
    usageBytes: origins.reduce((n, o) => n + o.usageBytes, 0),
    localStorage: origins.some((o) => o.localStorage),
    originCount: origins.length,
    ...(lastAccessed ? { lastAccessed } : {})
  }
}

/** 按网站分组：网站 → { cookies, 来源 } */
function group(c: Collected): Map<string, { cookies: Cookie[]; origins: string[] }> {
  const groups = new Map<string, { cookies: Cookie[]; origins: string[] }>()
  const at = (site: string): { cookies: Cookie[]; origins: string[] } => {
    let g = groups.get(site)
    if (!g) groups.set(site, (g = { cookies: [], origins: [] }))
    return g
  }
  for (const cookie of c.cookies) {
    const host = cookieHost(cookie)
    if (host) at(siteOfHost(host)).cookies.push(cookie)
  }
  for (const origin of c.origins.keys()) {
    at(siteOfHost(new URL(origin).hostname)).origins.push(origin)
  }
  return groups
}

function originData(
  origin: string,
  seen: OriginSeen | undefined,
  usage: { total: number; usage: SiteUsage } | undefined
): SiteOriginData {
  return {
    origin,
    usageBytes: usage?.total ?? 0,
    usage: usage?.usage ?? { ...EMPTY_USAGE },
    localStorage: !!seen?.localStorage,
    ...(seen?.lastAccessed ? { lastAccessed: seen.lastAccessed } : {})
  }
}

/** 这个来源还存着东西（占用不为 0，或有本地存储） */
function hasData(o: SiteOriginData): boolean {
  return o.usageBytes > 0 || o.localStorage
}

/** 设置页的网站列表（按网站名排序；界面再按用户的选择排） */
export async function listSites(): Promise<SiteSummary[]> {
  const c = await collect()
  const groups = group(c)
  const usage = await usageOf([...c.origins.keys()])
  return (
    [...groups.entries()]
      .map(([site, g]) =>
        summarize(
          site,
          g.cookies,
          g.origins.map((o) => originData(o, c.origins.get(o), usage.get(o))).filter(hasData)
        )
      )
      // 什么都不剩的网站不列（删光之后配额库、IndexedDB 目录里可能还留着它的记录）—— Chrome 也这样
      .filter((s) => s.cookieCount > 0 || s.usageBytes > 0 || s.localStorage)
      .sort((a, b) => a.site.localeCompare(b.site))
  )
}

/** 一个网站的详情：各来源的占用与本地存储、全部 Cookie；这个网站没有任何数据回 null */
export async function siteDetails(site: string): Promise<SiteDetails | null> {
  const c = await collect()
  const g = group(c).get(site)
  if (!g) return null
  const usage = await usageOf(g.origins)
  const origins = g.origins
    .map((o) => originData(o, c.origins.get(o), usage.get(o)))
    .filter(hasData)
    .sort((a, b) => a.origin.localeCompare(b.origin))
  if (origins.length === 0 && g.cookies.length === 0) return null
  return {
    ...summarize(site, g.cookies, origins),
    origins,
    cookies: g.cookies
      .map(toSiteCookie)
      .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name))
  }
}

/** 这个网站的全部来源：存过数据的来源，加上它的 Cookie 所在主机的 http / https 两个来源 */
function originsToClear(g: { cookies: Cookie[]; origins: string[] }): string[] {
  const set = new Set(g.origins)
  for (const cookie of g.cookies) {
    const host = cookieHost(cookie)
    if (!host) continue
    set.add(`https://${host}`)
    set.add(`http://${host}`)
  }
  return [...set].filter((o) => originOf(o) === o)
}

async function removeCookies(cookies: Cookie[]): Promise<void> {
  for (const c of cookies) {
    try {
      await sess().cookies.remove(cookieUrl(c), c.name)
    } catch (err) {
      log.warn(`Removing cookie ${c.name}@${c.domain} failed: ${err}`)
    }
  }
}

const STORAGE_TYPES: Record<
  Exclude<SiteDataCategory, 'cookies'>,
  Electron.ClearDataOptions['dataTypes']
> = {
  localStorage: ['localStorage'],
  indexedDB: ['indexedDB'],
  // Electron 的 'cache' 连 Cache Storage 一起清（实测）；这些来源的 HTTP 缓存也会随之清掉
  cacheStorage: ['cache'],
  serviceWorkers: ['serviceWorkers'],
  other: ['fileSystems', 'webSQL', 'backgroundFetch']
}
const ALL_STORAGE_TYPES: NonNullable<Electron.ClearDataOptions['dataTypes']> = [
  'localStorage',
  'indexedDB',
  'cache',
  'serviceWorkers',
  'fileSystems',
  'webSQL',
  'backgroundFetch'
]

async function findGroup(site: string): Promise<{ cookies: Cookie[]; origins: string[] } | null> {
  return group(await collect()).get(site) ?? null
}

/** 删除一个网站的全部数据：它的每一条 Cookie，与它全部来源的各类存储 */
export async function clearSite(site: string): Promise<void> {
  const g = await findGroup(site)
  if (!g) return
  await removeCookies(g.cookies)
  const origins = originsToClear(g)
  if (origins.length > 0) await sess().clearData({ dataTypes: ALL_STORAGE_TYPES, origins })
  log.info(`Cleared site data for ${site}: ${g.cookies.length} cookies, ${origins.length} origins`)
}

/** 按类别删除一个网站的数据（Cookie 逐条删；其余按它的全部来源） */
export async function clearSiteCategory(site: string, category: SiteDataCategory): Promise<void> {
  if (category !== 'cookies' && !Object.hasOwn(STORAGE_TYPES, category)) return
  const g = await findGroup(site)
  if (!g) return
  if (category === 'cookies') {
    await removeCookies(g.cookies)
    return
  }
  const dataTypes = STORAGE_TYPES[category as keyof typeof STORAGE_TYPES]
  const origins = originsToClear(g)
  if (!dataTypes || origins.length === 0) return
  await sess().clearData({ dataTypes, origins })
}

/** 删除一个来源的存储（不含 Cookie —— Cookie 按域名存，在 Cookie 那一栏删） */
export async function clearOrigin(origin: string): Promise<void> {
  const o = originOf(origin)
  if (!o || o !== origin.replace(/\/$/, '')) return
  await sess().clearData({ dataTypes: ALL_STORAGE_TYPES, origins: [o] })
}

/**
 * 删除**那一条** Cookie（名字 + 域 + 路径认）。`cookies.remove(url, name)` 会删掉所有会发往那个地址的同名
 * Cookie（www.x.com 上删一条会连带删掉 .x.com 上的同名那条、/sub 上删会连带删掉 / 上的），所以这里用一条
 * 同名、同域、同路径、已经过期的 Cookie 去覆盖 —— Chromium 删掉与它对应的那一条、不存新的。
 * 覆盖被拒（不该发生）时退回 remove。
 */
export async function removeCookie(c: {
  name: string
  domain: string
  path: string
  secure: boolean
}): Promise<void> {
  if (!c || typeof c.name !== 'string' || typeof c.domain !== 'string') return
  const url = cookieUrl(c)
  try {
    await sess().cookies.set({
      url,
      name: c.name,
      value: '',
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: true,
      // 域 Cookie（.x.com）带上域；只限主机的不带，否则会写成一条域 Cookie、对不上原来那条
      ...(c.domain.startsWith('.') ? { domain: c.domain } : {}),
      expirationDate: 1
    })
  } catch (err) {
    log.warn(`Expiring cookie ${c.name}@${c.domain}${c.path} failed, removing by url: ${err}`)
    await sess().cookies.remove(url, c.name)
  }
}
