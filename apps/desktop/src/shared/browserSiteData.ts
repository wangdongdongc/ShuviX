/**
 * 内置浏览器的「网站数据」—— 设置页（shuvix://settings）的网站列表与站点详情用的数据形状，主进程
 * （services/browser/siteData.ts）与渲染端共用。纯类型 + 一个纯函数。
 *
 * 照 Chrome 的 chrome://settings/content/all：按**网站**（可注册域名，eTLD+1，含 github.io 这类私有后缀；
 * IP 与 localhost 就是主机名本身）分组，一组下面是用过存储的各个来源（origin）。
 */

/** 详情页里按类别删除的那几类（Cookie 按网站删；其余按这个网站的全部来源删） */
export type SiteDataCategory =
  | 'cookies'
  | 'localStorage'
  | 'indexedDB'
  | 'cacheStorage'
  | 'serviceWorkers'
  | 'other'

/** 一个来源的配额存储占用（字节；来自 CDP Storage.getUsageAndQuota） */
export interface SiteUsage {
  indexedDB: number
  cacheStorage: number
  serviceWorkers: number
  /** 文件系统、WebSQL 与其余配额存储 */
  other: number
}

/** 一个来源（https://www.github.com）用了哪些存储 */
export interface SiteOriginData {
  origin: string
  /** 配额存储合计（字节；不含 Cookie 与本地存储 —— 后者 Chromium 不计入配额，拿不到大小） */
  usageBytes: number
  usage: SiteUsage
  /** 存过本地存储（localStorage）；大小不详 */
  localStorage: boolean
  /** 最近一次用到配额存储的时间（ms；Chromium 配额库的 last_accessed，没有就不给） */
  lastAccessed?: number
}

/** 网站列表里的一行 */
export interface SiteSummary {
  /** 分组键：可注册域名，或 IP / localhost 这类主机名本身 */
  site: string
  cookieCount: number
  /** Cookie 的名字加值的字节数（Chrome 的算法） */
  cookieBytes: number
  /** 各来源配额存储合计 */
  usageBytes: number
  localStorage: boolean
  originCount: number
  lastAccessed?: number
}

/** 详情页里的一条 Cookie */
export interface SiteCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  hostOnly: boolean
  sameSite: string
  /** 过期时间（ms）；会话 Cookie 没有 */
  expires?: number
  size: number
}

export interface SiteDetails extends SiteSummary {
  origins: SiteOriginData[]
  cookies: SiteCookie[]
}

/** 字节数 → 人读的大小（1 KB = 1024 B，一位小数，整数时不带小数） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  // 先按一位小数取整再决定写法：99.96 KB 写 100 KB、1.04 KB 写 1 KB（而不是 100.0 / 1.0）
  const rounded = Math.round(n * 10) / 10
  const text =
    i === 0 || rounded >= 100 || Number.isInteger(rounded)
      ? String(Math.round(n))
      : rounded.toFixed(1)
  return `${text} ${units[i]}`
}
