/**
 * Browser data IPC handlers
 *
 * 暴露内置浏览器分区（persist:shuvix-browser）中"已保存站点"的查询与清除能力。
 *
 * Electron 没有原生"枚举有数据的 origin" API，唯一稳定的枚举入口是 cookies。
 * 因此把"已保存站点"定义为"写过 cookie 的 host"，从 session.cookies.get({}) 聚合而来。
 */

import { ipcMain, session } from 'electron'
import { BROWSER_PARTITION } from '../services/browser'
import { createLogger } from '../logger'

const log = createLogger('BrowserData')

export interface SavedSite {
  host: string
  cookieCount: number
}

export function registerBrowserDataHandlers(): void {
  ipcMain.handle('browser-data:list-sites', async (): Promise<SavedSite[]> => {
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

  ipcMain.handle('browser-data:clear-site', async (_event, host: string): Promise<void> => {
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

  ipcMain.handle('browser-data:clear-all', async (): Promise<void> => {
    const sess = session.fromPartition(BROWSER_PARTITION)
    // 不传 origin = 清除分区下全部 cookies / localStorage / IndexedDB / cache / Service Worker
    await sess.clearStorageData()
    log.info('Cleared all browser partition data')
  })
}
