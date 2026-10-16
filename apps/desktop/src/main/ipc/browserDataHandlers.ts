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
import { BROWSER_PARTITION, certExceptionHosts } from '../services/browser'
import { createLogger } from '../logger'

const log = createLogger('BrowserData')

export interface SavedSite {
  host: string
  cookieCount: number
}

/** 地址栏站点信息气泡里关于当前这页的几件事 */
export interface SiteInfo {
  /** 这个地址会带上的 cookie 数（含父域上的，比如 www.github.com 带着 .github.com 的） */
  cookieCount: number
  /** 用户在证书警告页上放行过这个站点（直到退出） */
  certException: boolean
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
  defineHandler('browser-data:list-sites', async (): Promise<SavedSite[]> => {
    const sess = session.fromPartition(BROWSER_PARTITION)
    const cookies = await sess.cookies.get({})
    const counts = new Map<string, number>()
    for (const c of cookies) {
      const host = (c.domain ?? '').replace(/^\./, '')
      if (!host) continue
      counts.set(host, (counts.get(host) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([host, cookieCount]) => ({ host, cookieCount }))
      .sort((a, b) => a.host.localeCompare(b.host))
  })

  defineHandler('browser-data:clear-site', async (_ctx, host: string): Promise<void> => {
    if (!host || typeof host !== 'string') return
    const sess = session.fromPartition(BROWSER_PARTITION)

    // 1) 显式按 cookie 维度删除：origin-based clearStorageData 不会清掉
    //    domain=.host 这种 wildcard-domain cookie，必须用 cookies.remove。
    const cookies = await sess.cookies.get({})
    let removed = 0
    for (const c of cookies) {
      const cookieHost = (c.domain ?? '').replace(/^\./, '')
      if (cookieHost !== host) continue
      const scheme = c.secure ? 'https' : 'http'
      const url = `${scheme}://${cookieHost}${c.path ?? '/'}`
      try {
        await sess.cookies.remove(url, c.name)
        removed++
      } catch (e) {
        log.warn(`Failed to remove cookie ${c.name}@${c.domain}`, e)
      }
    }

    // 2) localStorage / IndexedDB / cache：同 origin 在 https / http 下是不同 bucket，分别清
    await sess.clearStorageData({ origin: `https://${host}` })
    await sess.clearStorageData({ origin: `http://${host}` })

    log.info(`Cleared ${removed} cookies and storage data for ${host}`)
  })

  /** 站点信息气泡：这页的 cookie 数与证书放行状态（非网页回 0 / false） */
  defineHandler('browser-data:site-info', async (_ctx, url: string): Promise<SiteInfo> => {
    const u = webUrl(url)
    if (!u) return { cookieCount: 0, certException: false }
    const sess = session.fromPartition(BROWSER_PARTITION)
    const cookies = await sess.cookies.get({ url: u.href })
    return {
      cookieCount: cookies.length,
      certException: certExceptionHosts().includes(u.hostname)
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
