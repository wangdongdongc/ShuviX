/**
 * widget 文件路由的密钥 —— `/w/<id>/fs/…` 不限路径地读本机文件，原本只靠 Host 与「不带 CORS 头」两道门。
 * 这两道挡得住网页，挡不住本机的进程：沙箱里的命令被关在会话目录里，却能 `curl` 127.0.0.1 上的 widget
 * 服务（沙箱放行 IP 出站），把家目录里的任何文件读出来 —— 会话权限表与沙箱划的线就白划了。
 *
 * 现在文件路由还要一个请求头 `x-shuvix-widget-key`，值是本进程启动时生成、只在主进程内存里的随机串：
 *   - 桌面里 widget 页面自己发出的请求（独立窗口 / 面板里的 iframe、预览的离屏窗口）由主进程经 Electron 的
 *     webRequest 补上（{@link installWidgetFsKey}）—— 只补给「从同一个 widget 的页面发出、打到它自己的文件
 *     路由」的请求，页面的代码看不到这个头；
 *   - 远程模式由网络服务的转发补上（widgetProxy.ts；谁能用网络服务由网络策略管）；
 *   - 其余一律 403。命令、别的进程、别的网页都不知道这个值。
 */
import { randomBytes, timingSafeEqual } from 'crypto'
import type { Session } from 'electron'

/** 文件路由的密钥头（小写：node:http 的请求头一律小写） */
export const WIDGET_FS_KEY_HEADER = 'x-shuvix-widget-key'

const key = randomBytes(32).toString('hex')

/** 本进程的密钥（只给补头的两处用） */
export function widgetFsKey(): string {
  return key
}

/** 请求带的密钥对不对 */
export function hasWidgetFsKey(value: string | string[] | undefined): boolean {
  if (typeof value !== 'string') return false
  const given = Buffer.from(value)
  const expected = Buffer.from(key)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])
const FILES_PATH = /^\/w\/([^/]+)\/fs\//

/**
 * 这次请求是不是某个 widget 页面在读**它自己的**文件路由：目标是 widget 服务（本机、这个端口）的
 * `/w/<id>/fs/…`，发起它的页面（frame 地址，没有就看 Referer）在同一个服务的 `/w/<id>/` 下。
 */
export function isOwnWidgetFilesRequest(
  url: string,
  initiator: string | undefined,
  port: number
): boolean {
  if (!port || !initiator) return false
  let target: URL
  let from: URL
  try {
    target = new URL(url)
    from = new URL(initiator)
  } catch {
    return false
  }
  if (target.protocol !== 'http:' || !LOOPBACK_HOSTS.has(target.hostname)) return false
  if (Number(target.port) !== port) return false
  const match = target.pathname.match(FILES_PATH)
  if (!match) return false
  return from.origin === target.origin && from.pathname.startsWith(`/w/${match[1]}/`)
}

/** 发起请求的那个 frame 的地址（frame 已销毁时访问会抛 —— 当作没有） */
function frameUrlOf(details: { frame?: { url: string } | null }): string | undefined {
  try {
    return details.frame?.url || undefined
  } catch {
    return undefined
  }
}

/**
 * 给一个 Electron 会话装上补头钩子：widget 页面读它自己的文件路由时带上密钥，其余请求里冒充的这个头
 * 一律去掉。一个会话的 onBeforeSendHeaders 只能有一个监听者 —— 装在没有别人用它的会话上（默认会话、
 * 预览分区）。`port` 现取：widget 服务懒启动，端口启动后才有。
 */
export function installWidgetFsKey(ses: Pick<Session, 'webRequest'>, port: () => number): void {
  ses.webRequest.onBeforeSendHeaders(
    { urls: ['http://127.0.0.1/*', 'http://localhost/*'] },
    (details, callback) => {
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(details.requestHeaders)) {
        if (name.toLowerCase() !== WIDGET_FS_KEY_HEADER) headers[name] = value
      }
      const initiator = frameUrlOf(details) || details.referrer || undefined
      if (isOwnWidgetFilesRequest(details.url, initiator, port())) {
        headers[WIDGET_FS_KEY_HEADER] = key
      }
      callback({ requestHeaders: headers })
    }
  )
}
