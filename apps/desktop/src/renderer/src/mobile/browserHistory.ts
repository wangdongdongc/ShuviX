/**
 * 手机布局里「浏览器」那几页在浏览器历史里的记号（2026-11-17：设置页的「浏览器」一行整屏推入，管理运行 ShuviX 的那台
 * 电脑上内置浏览器的标签页与数据）。
 *
 * 记的是一摞页面（从设置页往上数），每往里进一层压一条历史、带着更长的那一摞；返回键 / 返回手势退一条就是退一页：
 *
 *   ['tabs']                                        标签页列表
 *   ['tabs', 'tab:<标签页 id>']                      一个标签页
 *   ['tabs', 'settings']                            浏览器设置
 *   ['tabs', 'settings', 'sites']                   网站数据
 *   ['tabs', 'settings', 'sites', 'site:<网站>']     一个网站的数据
 */

export const BROWSER_HISTORY_MARK = 'shuvixMobileBrowser'

const TAB_PREFIX = 'tab:'
const SITE_PREFIX = 'site:'

export const browserTabPage = (tabId: string): string => `${TAB_PREFIX}${tabId}`
export const browserSitePage = (site: string): string => `${SITE_PREFIX}${site}`

/** 标签页那一页是哪个标签页；不是 → null */
export function browserTabIdOf(page: string): string | null {
  return page.startsWith(TAB_PREFIX) && page.length > TAB_PREFIX.length
    ? page.slice(TAB_PREFIX.length)
    : null
}

/** 网站那一页是哪个网站；不是 → null */
export function browserSiteOf(page: string): string | null {
  return page.startsWith(SITE_PREFIX) && page.length > SITE_PREFIX.length
    ? page.slice(SITE_PREFIX.length)
    : null
}

/** 这一摞是不是上面那五种之一 */
function validStack(stack: unknown[]): stack is string[] {
  if (stack.some((page) => typeof page !== 'string')) return false
  const pages = stack as string[]
  if (pages[0] !== 'tabs') return false
  if (pages.length === 1) return true
  if (pages.length === 2) return pages[1] === 'settings' || browserTabIdOf(pages[1]) !== null
  if (pages[1] !== 'settings' || pages[2] !== 'sites') return false
  if (pages.length === 3) return true
  return pages.length === 4 && browserSiteOf(pages[3]) !== null
}

/** 一条历史条目的 state 说的那一摞页面；不是这几页的条目（或记号坏了）→ 空 */
export function browserStackOf(state: unknown): string[] {
  const value = (state as Record<string, unknown> | null)?.[BROWSER_HISTORY_MARK]
  if (!Array.isArray(value) || value.length === 0) return []
  return validStack(value) ? value : []
}

/** 能不能从这一摞的顶上再推入 `page`（推入后还是上面那五种之一） */
export function canPushBrowserPage(stack: readonly string[], page: string): boolean {
  return validStack([...stack, page])
}
