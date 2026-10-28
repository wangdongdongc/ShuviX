/**
 * widget 路由的令牌 —— `/w/<id>/` 下的每个请求（页面本身、bundle、tailwind、sse、`db/`、`fs/`）都要带上**这个
 * widget 的**签名令牌，否则 403。
 *
 * 为什么要：widget 服务只绑 127.0.0.1，从前只靠 Host 与「文件路由不带 CORS 头」两道门。挡得住网页，挡不住本机的
 * 进程 —— 沙箱里的命令被关在会话目录里，却能 `curl` 这台服务（沙箱放行 IP 出站），经 `fs/` 读家目录里的任何
 * 文件、经 `db/` 读写任何一个 widget 的数据。
 *
 * 令牌：JWT（HS256）形状的 `header.payload.signature`，载荷 `{ w: <widgetId>, s: 'ui' | 'preview', sid? }`。密钥是
 * 本进程启动时生成、只在主进程内存里的随机串（不设过期：重启后密钥与端口都会换，旧令牌自然作废）。两种范围：
 *   - `ui`：widget 的界面（面板里的 iframe、独立窗口、远程 web 客户端），调用方是用户，全部路由可用；
 *   - `preview`：`widget` 工具的 `preview` 在看不见的窗口里渲染组件时用的那一个，载荷带发起预览的会话（`sid`）。
 *     页面里调 `/api` 的调用方是那条会话的 agent、按它的授权判；`fs/` 按它的权限表判（只判不问，见 widgetServer）。
 *     从前预览带 `ui` 令牌：改过界面再预览，就能以用户的身份写数据、经 `fs/` 读家目录的任何文件。
 * （从前还有 `cli`：`shuvix widget init / build` 交给 agent 在 shell 里 curl 用。CLI 的组件命令删掉了，组件的操作
 * 全部经 `widget` 工具 —— 它带着会话、过同一道授权；令牌本身不知道是哪条会话。）
 *
 * **令牌由宿主加在请求头上，从不进 URL**：widget 代码写的是绝对路径（`fetch('/w/<id>/db/…')`、
 * `<img src="/w/<id>/fs/file?…">`，见内置 widget 技能），令牌放进路径或 `<base>` 会让现有的 widget 全部失效。
 * 于是 widget 代码一行不用改，也看不到这个头：
 *   - 桌面：主进程经 Electron 的 webRequest 给 widget 页面自己的请求补上（{@link installWidgetTokens}），按发起请求
 *     的页面认 widget —— A 的页面打 B 的路由拿不到 B 的令牌；
 *   - 远程：网络服务的转发补上（frontend/network/widgetProxy.ts；谁能用网络服务由网络策略管）；
 *   - 预览：预览分区装的钩子补 `preview` 令牌（只补给正在预览的那个组件，见 widgetPreviewService）。
 *
 * 已知的边界：同一扇窗里同时开着的几个 widget 同源（都在 127.0.0.1:<端口>），一个能把手伸进另一个的 frame；
 * widget 自己的代码本来就能经 `fs/` 读任意文件（不限路径是裁决过的），令牌不改变这一点；网络服务的转发按路径给
 * 任何 widget 补令牌（远程浏览器那头没有可认的发起页面：沙箱 iframe 是不透明源），谁能走到转发由网络策略管 ——
 * 本机进程经回环连网络服务这件事留给网络权限的重做。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import type { Session } from 'electron'

/** 令牌所在的请求头（小写：node:http 的请求头一律小写） */
export const WIDGET_TOKEN_HEADER = 'x-shuvix-widget-token'

export type WidgetTokenScope = 'ui' | 'preview'

/** 令牌验出来的身份：范围，`preview` 还有发起预览的会话 */
export interface WidgetTokenClaims {
  scope: WidgetTokenScope
  /** `preview` 令牌里发起预览的会话；`ui` 没有 */
  sessionId?: string
}

const secret = randomBytes(32)

const base64url = (data: string | Buffer): string => Buffer.from(data).toString('base64url')

/** JWT 头：恒定，只签 HS256 */
const JWT_HEADER = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))

function sign(input: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url')
}

/** 给一个 widget 签发令牌（`preview` 带上发起预览的会话） */
export function issueWidgetToken(
  widgetId: string,
  scope: WidgetTokenScope,
  sessionId?: string
): string {
  const claims =
    sessionId === undefined ? { w: widgetId, s: scope } : { w: widgetId, s: scope, sid: sessionId }
  const payload = base64url(JSON.stringify(claims))
  const body = `${JWT_HEADER}.${payload}`
  return `${body}.${sign(body)}`
}

/**
 * 请求带的令牌对这个 widget 有效吗：有效 → 它的范围；签名不对、格式不对、是别的 widget 的 → null
 */
export function widgetTokenScope(
  value: string | string[] | undefined,
  widgetId: string
): WidgetTokenScope | null {
  return verifyWidgetToken(value, widgetId)?.scope ?? null
}

/**
 * 请求带的令牌对这个 widget 有效吗：有效 → 范围（与 `preview` 的会话）；签名不对、格式不对、是别的 widget 的、
 * 范围认不得（含旧的 `cli`）→ null。签名按常数时间比较
 */
export function verifyWidgetToken(
  value: string | string[] | undefined,
  widgetId: string
): WidgetTokenClaims | null {
  if (typeof value !== 'string') return null
  const parts = value.split('.')
  if (parts.length !== 3 || parts[0] !== JWT_HEADER) return null
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`))
  const given = Buffer.from(parts[2])
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const { w, s, sid } = (claims ?? {}) as { w?: unknown; s?: unknown; sid?: unknown }
  if (w !== widgetId) return null
  if (s === 'ui') return { scope: 'ui' }
  if (s === 'preview')
    return typeof sid === 'string' && sid
      ? { scope: 'preview', sessionId: sid }
      : { scope: 'preview' }
  return null
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])
const WIDGET_PATH = /^\/w\/([^/]+)(?:\/|$)/

/** 一个地址是不是这台 widget 服务（本机、这个端口）上某个 widget 的路由：是 → widget id */
export function widgetIdOf(url: string | undefined, port: number): string | null {
  if (!url || !port) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) return null
  if (Number(parsed.port) !== port) return null
  return parsed.pathname.match(WIDGET_PATH)?.[1] ?? null
}

/** Electron webRequest 交来的那一份请求里，补头要看的几样 */
export interface WidgetRequestFacts {
  url: string
  /** 'mainFrame' / 'subFrame' 是文档加载，其余是页面里发出的子资源（脚本、fetch、图片、sse …） */
  resourceType?: string
  /** 发起请求的 frame 的地址（文档加载时是被加载的那个 frame；读不到为 undefined） */
  frameUrl?: string
  /** 文档加载时，被加载的 frame 的父 frame 的地址（嵌入它的页面） */
  parentFrameUrl?: string
  referrer?: string
}

/**
 * 这次请求该不该补令牌、补哪个 widget 的：
 *   - 子资源：发起它的页面就在**同一个** widget 的 `/w/<id>/` 下（frame 地址，没有就看 Referer）；
 *   - 文档加载（iframe / 窗口打开 widget 页面）：嵌入它的页面或 Referer 不是**别的** widget 的页面 ——
 *     ShuviX 自己的界面（面板、独立窗口、预览）打开 widget 照常补；widget A 在自己页面里嵌 / 跳 widget B 不补。
 * 不该补 → null。
 */
export function widgetToInject(req: WidgetRequestFacts, port: number): string | null {
  const id = widgetIdOf(req.url, port)
  if (!id) return null
  const isDocument = req.resourceType === 'mainFrame' || req.resourceType === 'subFrame'
  if (isDocument) {
    for (const from of [req.parentFrameUrl, req.referrer]) {
      const other = widgetIdOf(from, port)
      if (other && other !== id) return null
    }
    return id
  }
  const initiator = req.frameUrl || req.referrer || undefined
  return widgetIdOf(initiator, port) === id ? id : null
}

/** 发起请求的 frame（与它的父 frame）的地址 —— frame 已销毁时访问会抛，当作没有 */
function frameUrls(details: { frame?: { url: string; parent?: { url: string } | null } | null }): {
  frameUrl?: string
  parentFrameUrl?: string
} {
  const read = (get: () => string | undefined): string | undefined => {
    try {
      return get() || undefined
    } catch {
      return undefined
    }
  }
  return {
    frameUrl: read(() => details.frame?.url),
    parentFrameUrl: read(() => details.frame?.parent?.url)
  }
}

/**
 * 给一个 Electron 会话装上补头钩子：widget 页面（以及 ShuviX 自己的界面打开 widget 页面）的请求带上那个 widget
 * 的令牌（缺省 `ui`；`issue` 给别的 —— 预览分区给 `preview`，交回 null 就不补），其余请求里冒充的同名头一律去掉。
 * 一个会话的 onBeforeSendHeaders 只能有一个监听者 —— 装在没有别人用它的会话上（默认会话、预览分区；内置浏览器在
 * 自己的分区里，拿不到令牌）。`port` 现取：widget 服务懒启动。
 */
export function installWidgetTokens(
  ses: Pick<Session, 'webRequest'>,
  port: () => number,
  issue: (widgetId: string) => string | null = (id) => issueWidgetToken(id, 'ui')
): void {
  ses.webRequest.onBeforeSendHeaders(
    { urls: ['http://127.0.0.1/*', 'http://localhost/*'] },
    (details, callback) => {
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(details.requestHeaders)) {
        if (name.toLowerCase() !== WIDGET_TOKEN_HEADER) headers[name] = value
      }
      const id = widgetToInject(
        {
          url: details.url,
          resourceType: details.resourceType,
          referrer: details.referrer,
          ...frameUrls(details)
        },
        port()
      )
      const token = id ? issue(id) : null
      if (token) headers[WIDGET_TOKEN_HEADER] = token
      callback({ requestHeaders: headers })
    }
  )
}
