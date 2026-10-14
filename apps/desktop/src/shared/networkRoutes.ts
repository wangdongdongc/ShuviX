/**
 * 网络服务的 HTTP 路由（server mode phase D，docs/server/phase-d-web-fallbacks.md §D1 / §D2）—— 浏览器里的
 * web 客户端拿不到桌面的自定义协议（`shuvix-media://` / `shuvix-preview://` / `shuvix-lib://`），也够不着只绑
 * 127.0.0.1 的 widget 服务，这几条路由是它们在网络服务上的等价物：
 *
 *  - `GET /files/media?path=<绝对路径>`              ≈ `shuvix-media://`（流式、按扩展名给 MIME、支持 Range）
 *  - `GET /files/preview?session=<id>&path=<路径>`   ≈ `shuvix-preview://`（相对路径按会话的工作目录解析）
 *  - `GET /files/download?path=<绝对路径>`           附件下载（`Content-Disposition: attachment`）
 *  - `GET /lib/<名字>`                               ≈ `shuvix-lib://<名字>`（同一张白名单）
 *  - `/w/<widget id>/…`（任意方法）                   转发给本机的 widget 服务
 *
 * 用户裁决：**文件路由不限路径**（与那几个自定义协议一样，给什么路径就读什么）—— 网络访问本来就没有认证。
 *
 * 纯字符串：主进程（路由匹配）与渲染端（拼地址）两头都引它。渲染端拼的是**以 `/` 开头的相对地址**（页面就是
 * 从这台服务上来的）；只有沙箱里的库地址要绝对地址（srcdoc 的 CSP 要写源）。
 */

/** 文件路由的前缀 */
export const NETWORK_FILES_PREFIX = '/files/'

/** `shuvix-media://` 的等价物 */
export const NETWORK_MEDIA_PATH = '/files/media'

/** `shuvix-preview://` 的等价物 */
export const NETWORK_PREVIEW_PATH = '/files/preview'

/** 附件下载 */
export const NETWORK_DOWNLOAD_PATH = '/files/download'

/** 交互图沙箱的库（`/lib/<名字>`） */
export const NETWORK_LIB_PREFIX = '/lib/'

/** widget 服务的转发前缀（widget 页面自己的地址都在 `/w/<id>/` 下：`<base href>`、bundle、sse、db） */
export const NETWORK_WIDGET_PREFIX = '/w/'

/** 本机文件 → 媒体地址（TTS 音频这类「路径可信」的文件） */
export function networkMediaUrl(absolutePath: string): string {
  return `${NETWORK_MEDIA_PATH}?path=${encodeURIComponent(absolutePath)}`
}

/** 会话里的文件 → 预览资源地址（PDF / 图片 / 音视频；相对路径按会话的工作目录解析） */
export function networkPreviewUrl(sessionId: string, path: string): string {
  return `${NETWORK_PREVIEW_PATH}?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
}

/** 服务端的文件 → 附件下载地址 */
export function networkDownloadUrl(absolutePath: string): string {
  return `${NETWORK_DOWNLOAD_PATH}?path=${encodeURIComponent(absolutePath)}`
}

/** 页面的 origin → 沙箱库的基址（`<origin>/lib/`，后面直接接库名） */
export function networkLibBase(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${NETWORK_LIB_PREFIX}`
}

/**
 * widget 服务给的地址（`http://127.0.0.1:<端口>/w/<id>/…`）→ 经网络服务转发的地址（`<origin>/w/<id>/…`）。
 * 不是 `/w/` 下的地址（不该发生）原样返回。
 */
export function networkWidgetUrl(widgetServerUrl: string, origin: string): string {
  let parsed: URL
  try {
    parsed = new URL(widgetServerUrl)
  } catch {
    return widgetServerUrl
  }
  if (!parsed.pathname.startsWith(NETWORK_WIDGET_PREFIX)) return widgetServerUrl
  return `${origin.replace(/\/+$/, '')}${parsed.pathname}${parsed.search}${parsed.hash}`
}
