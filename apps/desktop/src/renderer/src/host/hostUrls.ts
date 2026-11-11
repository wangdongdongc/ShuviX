/**
 * 桌面窗口与浏览器里的 web 客户端拼地址的差别（server mode phase D，docs/server/phase-d-web-fallbacks.md）——
 * 桌面有自定义协议（`shuvix-preview:` / `shuvix-lib:`）、widget 服务的 127.0.0.1 地址、能开新窗口；
 * web 客户端只有它自己那台网络服务（同源的 HTTP 路由，见 `shared/networkRoutes.ts`）和浏览器标签页。
 *
 * 纯函数（平台、页面地址都由调用方交进来），桌面那一支一律原样 / undefined —— 桌面行为不因此改变。
 */
import { shownImageFileOfRef } from '@shuvix/chat-protocol/shownImages'
import { libraryItemIdOfRef } from '@shuvix/chat-protocol/fileLibrary'
import {
  networkLibBase,
  networkPreviewUrl,
  networkShownImageUrl,
  networkLibraryFileUrl,
  networkWidgetUrl
} from '../../../shared/networkRoutes'

/** 页面地址里要的那一点（`window.location` 满足它） */
export interface PageLocation {
  readonly origin: string
  readonly pathname: string
}

/** `window.api.app.platform` 是不是浏览器里的 web 客户端 */
export function isWebPlatform(platform: string | undefined): boolean {
  return platform === 'web'
}

/**
 * web 客户端的预览资源地址（`shuvix-preview://` 的等价物；桌面用 chat-ui 的 `shuvixPreviewResolver`）。
 * 摆给用户看的图（`shown:` 引用）走会话自己的那条路由：它是会话内容，能读这个会话就能看（不归 `files`）
 */
export function webPreviewUrl(sessionId: string, path: string): string {
  // 文件库里的一件（`library:` 引用）：按 id 走库的路由，与会话无关
  const libraryId = libraryItemIdOfRef(path)
  if (libraryId) return networkLibraryFileUrl(libraryId)
  const shown = shownImageFileOfRef(path)
  return shown ? networkShownImageUrl(sessionId, shown) : networkPreviewUrl(sessionId, path)
}

/** 交互图沙箱的库基址：web 客户端 `<origin>/lib/`；桌面 undefined（沿用 `shuvix-lib:`） */
export function sandboxLibBaseFor(
  platform: string | undefined,
  origin: string
): string | undefined {
  return isWebPlatform(platform) ? networkLibBase(origin) : undefined
}

/** widget 服务给的地址 → iframe 用的地址：web 客户端经网络服务转发（`<origin>/w/…`）；桌面原样 */
export function widgetFrameUrl(platform: string | undefined, url: string, origin: string): string {
  return isWebPlatform(platform) ? networkWidgetUrl(url, origin) : url
}

/** 同一个 web 页面换一个 hash 的地址（新标签页里开另一种窗口的那一屏） */
export function webPageUrl(location: PageLocation, hash: string): string {
  return `${location.origin}${location.pathname}#${hash.replace(/^#/, '')}`
}

/** 文件预览那一屏（`#file-preview?sessionId=&path=&openedBy=`，与桌面的预览窗口同一个 hash） */
export function filePreviewPageUrl(
  location: PageLocation,
  params: { sessionId: string; path: string; openedBy?: 'agent' | 'user' }
): string {
  const query = new URLSearchParams({
    sessionId: params.sessionId,
    path: params.path,
    openedBy: params.openedBy ?? 'user'
  })
  return webPageUrl(location, `file-preview?${query.toString()}`)
}

/** widget 那一屏（`#widget-window?widgetId=`，与桌面的 widget 窗口同一个 hash） */
export function widgetPageUrl(location: PageLocation, widgetId: string): string {
  return webPageUrl(location, `widget-window?${new URLSearchParams({ widgetId }).toString()}`)
}

/** 浏览器管理页的两节 */
export type BrowserManagerSection = 'tabs' | 'settings'

/** web 客户端的浏览器管理页（`#browser-manager[?section=settings]`）：别的设备上管理那台电脑的内置浏览器 */
export function browserManagerPageUrl(
  location: PageLocation,
  section: BrowserManagerSection = 'tabs'
): string {
  return webPageUrl(
    location,
    section === 'tabs' ? 'browser-manager' : `browser-manager?section=${section}`
  )
}

/** `#browser-manager?section=…` → 那一节（认不出 → 标签页） */
export function browserManagerSectionOf(hash: string): BrowserManagerSection {
  const query = hash.split('?')[1] ?? ''
  return new URLSearchParams(query).get('section') === 'settings' ? 'settings' : 'tabs'
}
