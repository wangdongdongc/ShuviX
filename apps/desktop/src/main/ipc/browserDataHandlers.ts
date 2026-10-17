/**
 * Browser data IPC handlers
 *
 * 暴露内置浏览器分区（persist:shuvix-browser）中"已保存站点"的查询与清除能力。
 *
 * Electron 没有原生"枚举有数据的 origin" API，唯一稳定的枚举入口是 cookies。
 * 因此把"已保存站点"定义为"写过 cookie 的 host"，从 session.cookies.get({}) 聚合而来。
 */

import { session } from 'electron'
import { defineHandler } from './registry'
import {
  BROWSER_PARTITION,
  certExceptionHosts,
  clearOrigin,
  clearSite,
  clearSiteCategory,
  listSites,
  removeCookie,
  siteDetails,
  siteOfUrl
} from '../services/browser'
import type { SiteDataCategory, SiteDetails, SiteSummary } from '../../shared/browserSiteData'

const CATEGORIES: readonly SiteDataCategory[] = [
  'cookies',
  'localStorage',
  'indexedDB',
  'cacheStorage',
  'serviceWorkers',
  'other'
]
import { createLogger } from '../logger'

const log = createLogger('BrowserData')

/** 地址栏站点信息气泡里关于当前这页的几件事 */
export interface SiteInfo {
  /** 这个地址会带上的 cookie 数（含父域上的，比如 www.github.com 带着 .github.com 的） */
  cookieCount: number
  /** 用户在证书警告页上放行过这个站点（直到退出） */
  certException: boolean
  /** 这个地址所属的网站（设置页网站数据的分组键）；非网页没有 */
  site?: string
}

/** http(s) 地址 → URL；别的（about: / file: / 内部页面 / 不合法）回 null */
function webUrl(url: unknown): URL | null {
  if (typeof url !== 'string') return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null
  } catch {
    return null
  }
}

export function registerBrowserDataHandlers(): void {
  /** 设置页的网站列表：Cookie、配额存储、本地存储按网站分组（见 services/browser/siteData.ts） */
  defineHandler('browser-data:list-sites', (): Promise<SiteSummary[]> => listSites())

  /**
   * 一个网站的详情（各来源的占用、全部 Cookie —— **含 Cookie 的值**，也就是登录令牌）；没有数据回 null。
   * 只回应桌面窗口：服务器模式下局域网客户端没有鉴权，不能经它读走内置浏览器里的登录态
   * （网络客户端本来也没有浏览器窗口、用不到这张详情）。
   */
  defineHandler(
    'browser-data:site-details',
    (ctx, site: string): Promise<SiteDetails | null> =>
      ctx.client.kind === 'window' && typeof site === 'string' && site
        ? siteDetails(site)
        : Promise.resolve(null)
  )

  /** 删除一个网站的全部数据 */
  defineHandler('browser-data:clear-site', async (_ctx, site: string): Promise<void> => {
    if (typeof site === 'string' && site) await clearSite(site)
  })

  /** 按类别删除一个网站的数据 */
  defineHandler(
    'browser-data:clear-site-category',
    async (_ctx, site: string, category: SiteDataCategory): Promise<void> => {
      if (typeof site !== 'string' || !site || !CATEGORIES.includes(category)) return
      await clearSiteCategory(site, category)
    }
  )

  /** 删除一个来源的存储（不含 Cookie） */
  defineHandler('browser-data:clear-origin', async (_ctx, origin: string): Promise<void> => {
    if (typeof origin === 'string') await clearOrigin(origin)
  })

  /** 删除一条 Cookie */
  defineHandler(
    'browser-data:remove-cookie',
    async (
      _ctx,
      cookie: { name: string; domain: string; path: string; secure: boolean }
    ): Promise<void> => {
      if (cookie && typeof cookie === 'object') await removeCookie(cookie)
    }
  )

  /** 站点信息气泡：这页的 cookie 数与证书放行状态（非网页回 0 / false） */
  defineHandler('browser-data:site-info', async (_ctx, url: string): Promise<SiteInfo> => {
    const u = webUrl(url)
    if (!u) return { cookieCount: 0, certException: false }
    const sess = session.fromPartition(BROWSER_PARTITION)
    const cookies = await sess.cookies.get({ url: u.href })
    const site = siteOfUrl(u.href)
    return {
      cookieCount: cookies.length,
      certException: certExceptionHosts().includes(u.hostname),
      ...(site ? { site } : {})
    }
  })

  /**
   * 站点信息气泡里的「清除此网站的数据」：这个地址带着的全部 cookie（含父域上的）+ 这个 origin 的
   * localStorage / IndexedDB / 缓存。按 cookie 的 domain 精确匹配的 clear-site 在这里不够 —— www.x.com
   * 的登录态常写在 .x.com 上。
   */
  defineHandler('browser-data:clear-site-data', async (_ctx, url: string): Promise<void> => {
    const u = webUrl(url)
    if (!u) return
    const sess = session.fromPartition(BROWSER_PARTITION)
    const cookies = await sess.cookies.get({ url: u.href })
    for (const c of cookies) {
      const host = (c.domain ?? '').replace(/^\./, '')
      try {
        await sess.cookies.remove(
          `${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`,
          c.name
        )
      } catch (e) {
        log.warn(`Failed to remove cookie ${c.name}@${c.domain}`, e)
      }
    }
    await sess.clearStorageData({ origin: u.origin })
    log.info(`Cleared ${cookies.length} cookies and storage data for ${u.origin}`)
  })

  /** 设置页「证书」一节：用户放行过证书错误的站点（直到退出） */
  defineHandler('browser-data:cert-exceptions', (): string[] => certExceptionHosts())

  defineHandler('browser-data:clear-all', async (): Promise<void> => {
    const sess = session.fromPartition(BROWSER_PARTITION)
    // 不传 origin = 清除分区下全部 cookies / localStorage / IndexedDB / cache / Service Worker
    await sess.clearStorageData()
    log.info('Cleared all browser partition data')
  })
}
