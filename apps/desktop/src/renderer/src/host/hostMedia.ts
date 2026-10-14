import { shuvixPreviewResolver, type ResolveMediaUrl } from '@shuvix/chat-ui'
import { isWebPlatform, sandboxLibBaseFor, webPreviewUrl } from './hostUrls'

/**
 * 本窗口用的媒体地址解析器（交给 `MediaUrlProvider`）：桌面是 `shuvix-preview://`（main 注册的协议），
 * 浏览器里的 web 客户端是网络服务的 `/files/preview`（server mode phase D）。`window.api` 在 App 求值之前
 * 就装好了（桌面 preload、web 的 main.tsx），所以模块求值时定一次就够。
 */
export const hostMediaResolver: ResolveMediaUrl = isWebPlatform(window.api.app.platform)
  ? ({ sessionId, path }) => ({ url: webPreviewUrl(sessionId, path) })
  : shuvixPreviewResolver

/** 本窗口是不是浏览器里的 web 客户端 */
export const isWebHost: boolean = isWebPlatform(window.api.app.platform)

/** 交互图沙箱的库基址（web 客户端 `<origin>/lib/`；桌面 undefined） */
export const hostSandboxLibBase: string | undefined = sandboxLibBaseFor(
  window.api.app.platform,
  window.location.origin
)
