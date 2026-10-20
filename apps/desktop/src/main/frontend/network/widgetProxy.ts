/**
 * widget 的转发（server mode phase D，docs/server/phase-d-web-fallbacks.md §D2）—— widget 服务只绑 127.0.0.1
 * （`services/widget/widgetServer.ts`），局域网里的浏览器够不着它；网络服务把 `/w/…` 原样转给它：
 *
 *  - 方法、路径（含查询串）、请求体照搬；请求头去掉逐跳的那几个（Connection / Keep-Alive / Upgrade …），
 *    `Host` 换成 widget 服务自己的；
 *  - 应答的状态码与头（同样去掉逐跳的）照搬，HTML 应答另加一条沙箱 CSP（`WIDGET_DOCUMENT_CSP`），正文**流式**转回 —— widget 的 `sse`（热重载）是一条不结束的
 *    事件流，不能攒完再发；
 *  - widget 的文件路由（`/w/<id>/fs/…`，见 `shared/widgetRoutes.ts`）的应答补一个 `Access-Control-Allow-Origin: *`：
 *    widget 服务自己故意不带（不限路径的文件读，带上就是让用户浏览器里任何网页都能读本机文件），但转发过来的
 *    widget 文档是沙箱里的不透明源，它 `fetch` 同一台服务的 `/w/<id>/fs/list` 就是跨源，没有这个头读不到应答。
 *    这一面（局域网、不认证）的 `/files/media` 本来就不限路径，补这个头不比现状多放出任何东西。转发自己回的
 *    503 / 502 在文件路由上也带它，widget 才看得到 `!res.ok` 而不是一个 fetch 的 TypeError；
 *  - 文件路由补上 widget 服务要的密钥头（`services/widget/widgetFsKey.ts`），客户端自己带来的同名头一律丢掉 ——
 *    谁能走到这里由网络策略管，widget 服务那一面只认密钥；
 *  - 浏览器那头断了 → 上游请求随之断开（sse 不会在 widget 服务那头留下一个没人读的客户端）；
 *  - widget 服务没在跑（它是懒启动的：第一次打开 widget 时才监听）→ 503；上游连不上 / 中途出错 → 502。
 *
 * widget 页面自己的地址都在 `/w/<id>/` 下（`<base href="/w/<id>/">`、bundle、tailwind、sse、`db/<表>`），
 * 所以只转这一个前缀就够了。三道门（对端地址、Host）由服务端在进到这里之前就过完了。
 */
import {
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { isWidgetFilesPath } from '../../../shared/widgetRoutes'
import { WIDGET_FS_KEY_HEADER, widgetFsKey } from '../../services/widget/widgetFsKey'

/** widget 服务此刻在哪（没在跑 → undefined） */
export interface WidgetProxyTarget {
  readonly host: string
  readonly port: number
}

export interface WidgetProxyDeps {
  readonly target: () => WidgetProxyTarget | undefined
  readonly logger?: { warn(message: string): void }
}

/**
 * widget 页面（HTML）应答加的 CSP：沙箱、不给 allow-same-origin。转发之后 widget 与 web 客户端同源 —— 不加的话，
 * 有人把一个标签页直接导航到 `/w/<id>/`，widget 的代码（agent 写的）就能以 web 客户端的 Origin 连上 `/ws`。
 * 与 web 客户端给 widget iframe 的 `sandbox` 属性是同一组放行（桌面靠跨源做到同一件事）
 */
export const WIDGET_DOCUMENT_CSP =
  'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads'

/** 逐跳的头（RFC 7230 §6.1）—— 只属于一段连接，不往下一段转 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

/** 去掉逐跳的头（外加 `Connection` 里点名的那些） */
export function forwardableHeaders(
  headers: IncomingHttpHeaders,
  drop: readonly string[] = []
): Record<string, string | string[]> {
  const named = new Set(drop.map((h) => h.toLowerCase()))
  const connection = headers.connection
  if (typeof connection === 'string') {
    for (const token of connection.split(',')) named.add(token.trim().toLowerCase())
  }
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (value === undefined || HOP_BY_HOP.has(lower) || named.has(lower)) continue
    out[lower] = value
  }
  return out
}

function plain(res: ServerResponse, status: number, text: string, cors = false): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    // 文件路由的错误也要读得到：没有这个头，沙箱里的 widget 拿到的是 fetch 的 TypeError 而不是 !res.ok
    ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {})
  })
  res.end(text)
}

/** 把一次 `/w/…` 请求转给 widget 服务，应答流式转回 */
export function proxyWidgetRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WidgetProxyDeps
): void {
  const filesRoute = isWidgetFilesPath((req.url ?? '/').split('?')[0])
  const target = deps.target()
  if (target === undefined) {
    plain(res, 503, 'The ShuviX widget server is not running. Open the widget again.', filesRoute)
    return
  }
  const headers = forwardableHeaders(req.headers, ['host', WIDGET_FS_KEY_HEADER])
  headers.host = `${target.host}:${target.port}`
  if (filesRoute) headers[WIDGET_FS_KEY_HEADER] = widgetFsKey()
  let finished = false
  const upstream = request(
    {
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url ?? '/',
      headers,
      agent: false
    },
    (upstreamRes) => {
      const headers = forwardableHeaders(upstreamRes.headers)
      if (filesRoute) {
        headers['access-control-allow-origin'] = '*'
      }
      const type = headers['content-type']
      if (typeof type === 'string' && /^text\/html\b/i.test(type)) {
        const existing = headers['content-security-policy']
        headers['content-security-policy'] =
          typeof existing === 'string' && existing
            ? `${existing}, ${WIDGET_DOCUMENT_CSP}`
            : WIDGET_DOCUMENT_CSP
      }
      res.writeHead(upstreamRes.statusCode ?? 502, headers)
      // 事件流：头先出去，浏览器才开始等事件
      res.flushHeaders()
      upstreamRes.on('error', () => res.destroy())
      upstreamRes.on('end', () => {
        finished = true
      })
      upstreamRes.pipe(res)
    }
  )
  upstream.on('error', (error) => {
    // 浏览器先走了（下面那个 close 主动断的上游）、或已经转完：没人可回
    if (finished || res.destroyed) return
    deps.logger?.warn(`network: widget proxy ${req.method} ${req.url} failed: ${String(error)}`)
    plain(res, 502, 'The ShuviX widget server did not answer.', filesRoute)
  })
  // 浏览器那头走了（关了 tab、sse 断开）：上游一起断
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy()
  })
  req.pipe(upstream)
}
