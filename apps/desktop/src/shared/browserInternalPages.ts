/**
 * 内置浏览器的内部页面（Chrome 的 chrome://settings、chrome://history 那一类）：`shuvix://<页名>`。
 *
 * 内部页面是一个标签页，但页面本身是浏览器窗口外壳里的 DOM —— 那个 tab 的 webContents 只是一张
 * about:blank 占位（主进程 browserViewService 的 internalPages 记着它是哪一页）。agent 看不到、也碰不到
 * 这些页（list_tabs 不列、工具一律当作没有这个 tab）：清浏览数据、关证书检查这类事只能用户自己点。
 *
 * 纯数据 + 两个纯函数，主进程与渲染端共用（src/shared 是叶子层）。
 */

export const INTERNAL_PAGES = ['settings', 'history'] as const
export type InternalPage = (typeof INTERNAL_PAGES)[number]

export const INTERNAL_SCHEME = 'shuvix'

/** 页名 → 地址栏里显示的地址 */
export function internalPageUrl(page: InternalPage): string {
  return `${INTERNAL_SCHEME}://${page}`
}

/** 地址 → 页名；不是内部页面（或不认识的页名）回 null。`shuvix://settings/`、带 ? / # 的都认 */
export function internalPageOf(url: string): InternalPage | null {
  const m = /^shuvix:\/\/([a-z-]+)\/?(?:[?#].*)?$/i.exec(url.trim())
  if (!m) return null
  const page = m[1].toLowerCase()
  return (INTERNAL_PAGES as readonly string[]).includes(page) ? (page as InternalPage) : null
}
