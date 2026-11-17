/** 手机布局「浏览器」那几页里不画东西的小函数（组件文件只导出组件） */
import type { SiteSummary } from '../../../shared/browserSiteData'

/** 标签页那一行第二排的网站名：网页是主机名；内部页面与空白页不写；别的（data:、解析不了的）写协议或原样 */
export function hostOfTab(tab: { url: string; internalPage?: string }): string {
  if (tab.internalPage !== undefined) return ''
  const url = tab.url.trim()
  if (!url || url === 'about:blank') return ''
  try {
    const parsed = new URL(url)
    return parsed.host || parsed.protocol.replace(/:$/, '')
  } catch {
    return url
  }
}

/** 一个网站在列表里显示的占用：配额存储 + Cookie */
export const siteBytes = (site: SiteSummary): number => site.usageBytes + site.cookieBytes

export type SiteSort = 'name' | 'size'

/** 网站列表：名字包含搜索词，或搜索词是它下面的一个主机（www.github.com → github.com）；按名称或占用排 */
export function shownSites(
  sites: readonly SiteSummary[],
  query: string,
  sort: SiteSort
): SiteSummary[] {
  const needle = query.trim().toLowerCase()
  return sites
    .filter((entry) => {
      const site = entry.site.toLowerCase()
      return !needle || site.includes(needle) || needle.endsWith(`.${site}`)
    })
    .sort((a, b) =>
      sort === 'size'
        ? siteBytes(b) - siteBytes(a) || a.site.localeCompare(b.site)
        : a.site.localeCompare(b.site)
    )
}
