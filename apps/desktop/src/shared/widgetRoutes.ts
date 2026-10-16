/**
 * widget 服务的文件路由 —— widget 代码读本机文件的唯一写法，桌面与远程（浏览器经网络服务）同一个地址：
 *
 *  - `GET|HEAD /w/<id>/fs/file?path=<路径>`   回文件字节（按扩展名给 MIME，支持 Range）
 *  - `GET|HEAD /w/<id>/fs/list?path=<目录>`   回目录列表（JSON）
 *
 * 为什么挂在 `/w/<id>/` 下：widget 页面在两种模式下都能用同一个字符串够到的只有这个前缀 —— 桌面直接连
 * 127.0.0.1 的 widget 服务，远程由网络服务把 `/w/…` 原样转过去（frontend/network/widgetProxy.ts）。
 * `shuvix-media://` 是 Electron 协议，浏览器不认；网络服务的 `/files/media` 在 127.0.0.1 的 widget 服务上没有。
 *
 * `path` 是绝对路径，或以 `~` 开头（宿主展开成用户主目录）；不限路径（与 `shuvix-media://`、`/files/media` 一致）。
 * 谁能调由两道门管（widgetServer.ts）：Host 必须是 widget 服务自己的；应答不带 `Access-Control-Allow-Origin`，
 * 只有转发到局域网的那一面由 widgetProxy 补上（那一面的 `/files/media` 本来就不限路径、不认证）。
 *
 * 纯字符串：主进程（路由匹配）与渲染端都可以引。
 */

/** widget 文件路由在 `/w/<id>` 之后的段 */
export const WIDGET_FILES_SEGMENT = '/fs/'

/** 读文件 */
export const WIDGET_FILE_ROUTE = '/fs/file'

/** 列目录 */
export const WIDGET_LIST_ROUTE = '/fs/list'

/** 一次列目录最多回多少条（再多就截断并标 `truncated`） */
export const WIDGET_LIST_LIMIT = 10_000

/** 列目录的一条 */
export interface WidgetDirEntry {
  readonly name: string
  /** 跟随符号链接后的类型；读不到（断链、没权限）→ `other` */
  readonly kind: 'file' | 'directory' | 'other'
  readonly size: number
  readonly mtimeMs: number
}

/** `/fs/list` 的应答 */
export interface WidgetDirListing {
  /** 展开、归一后的绝对路径 */
  readonly path: string
  readonly entries: readonly WidgetDirEntry[]
  /** 超过 WIDGET_LIST_LIMIT 条时为 true，`entries` 只有前 WIDGET_LIST_LIMIT 条 */
  readonly truncated: boolean
}

/** 请求路径（不含查询串）是不是某个 widget 的文件路由（`/w/<id>/fs/…`） */
export function isWidgetFilesPath(pathname: string): boolean {
  return /^\/w\/[^/]+\/fs\//.test(pathname)
}

/** widget 读一个文件的地址 */
export function widgetFileUrl(widgetId: string, path: string): string {
  return `/w/${widgetId}${WIDGET_FILE_ROUTE}?path=${encodeURIComponent(path)}`
}

/** widget 列一个目录的地址 */
export function widgetListUrl(widgetId: string, path: string): string {
  return `/w/${widgetId}${WIDGET_LIST_ROUTE}?path=${encodeURIComponent(path)}`
}
