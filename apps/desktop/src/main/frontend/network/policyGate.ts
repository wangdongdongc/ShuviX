/**
 * 远程访问的策略点位（2026-10-19，docs/network-policy/design.md）—— 网络服务在四个地方问安全策略：
 *
 *  - **socket**：TCP 连接刚建立、HTTP 还没解析 → `{type:'socket'}` × `connect`；拒绝 = 直接断开；
 *  - **request**：每个 HTTP 请求（含 WebSocket 升级）→ `{type:'request', method, path, query, route, scope, access}`
 *    × `request`；拒绝 = 403，正文是规则的 prompt；
 *  - **channel**：WebSocket 上的每条 RPC → `{type:'channel', channel, group, scope, kind, access, size, args}` ×
 *    `invoke`；拒绝 = invoke 回 `ok:false`（`code:'denied'`），send 丢掉；
 *  - **path**：文件路由（`/files/*`）与几条文件通道（`files:read` / `files:write` / `fs:listDirectories`）真正
 *    读写的位置 → `{type:'path', path, requestedPath, displayPath, scope, access}` × `read` / `write`，
 *    tool = `files` / `fs`。
 *
 * request / channel / path 三处都带 `scope` 与 `access`（2026-10-23，docs/network-scope/design.md）：同一条
 * 「scope × 访问级别」的规则在三处意思一致。词表与归类在 shared/channelAccess.ts。
 *
 * 主体恒是 `{kind:'network'}`，开放属性（`subject.<键>`）在每个阶段都给齐（还拿不到的给空值），见 networkSubject。
 * 判定走 judgeGate：**先完整结算，再把 ask 降级为拒绝** —— 网络点位没有人可问。guards.ts 的三道写死的门在这些
 * 点位之前，策略放不开它们。判定本身抛错（内置策略 md 缺了之类的开发期错误）→ 按拒绝处置（fail closed）并记日志。
 *
 * 拒绝记进 NetworkDenialLog（放行不记）：同一个（地址、设备、胜出规则、对象摘要）一分钟内合并成一条，日志行每个
 * 窗口只写一次 —— 局域网里的扫描器刷不满它。请求头、cookie、RPC 参数不进记录。
 *
 * 设备 cookie（`shuvix_device`）：浏览器第一次来时由服务端发一个随机 ID，之后对同一地址的每个请求（含 WebSocket
 * 升级）浏览器自动带上 —— 是识别，不是认证（明文 HTTP 上谁拿到值谁就能冒充）。
 */
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import {
  parseIp,
  type GateVerdict,
  type SecurityContext,
  type SecurityObject,
  type SecuritySubject
} from '@shuvix/agent-runtime'
import {
  channelCallFactsOf,
  channelGroupOf,
  type CallFacts,
  type ChannelScope
} from '../../../shared/channelAccess'
import { NETWORK_WS_PATH } from '../../../shared/networkEnvelope'
import { NETWORK_WIDGET_PREFIX } from '../../../shared/networkRoutes'
import type {
  HttpFacts,
  NetworkCallFacts,
  NetworkDenialInfo,
  PeerFacts
} from '../../../shared/network'
import { displayPeerAddress } from './guards'
import { fileRouteOf } from './fileRoutes'
import { WEB_ENTRY_FILE } from './staticFiles'

// ─────────────────────────── 设备 cookie ───────────────────────────

export const DEVICE_COOKIE = 'shuvix_device'

/** 设备 ID：16 个随机字节的 base64url（22 个字符） */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{22}$/

export function newDeviceId(): string {
  return randomBytes(16).toString('base64url')
}

/** 发设备 ID 的 `Set-Cookie`：只给本服务的页面用（HttpOnly：页面脚本与 widget 读不到），十年有效 */
export function deviceCookieHeader(id: string): string {
  return `${DEVICE_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=315360000`
}

/** `Cookie` 头 → 名字 → 值（同名取第一个；值按 URI 编码解开，解不开留原样） */
export function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (!name || Object.hasOwn(out, name)) continue
    let value = part.slice(eq + 1).trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      value = value.slice(1, -1)
    try {
      value = decodeURIComponent(value)
    } catch {
      /* 留原样 */
    }
    out[name] = value
  }
  return out
}

/** 请求带来的设备 ID；没有或格式不对 → 空串 */
export function deviceOfCookieHeader(header: string | undefined): string {
  const value = header ? parseCookies(header)[DEVICE_COOKIE] : undefined
  return value !== undefined && DEVICE_ID_RE.test(value) ? value : ''
}

// ─────────────────────────── 事实 ───────────────────────────

export type { HttpFacts, NetworkCallFacts, PeerFacts }

export function peerFactsOf(socket: {
  readonly remoteAddress?: string
  readonly remotePort?: number
  readonly localAddress?: string
  readonly localPort?: number
}): PeerFacts {
  const address = displayPeerAddress(socket.remoteAddress)
  return {
    address,
    port: socket.remotePort ?? 0,
    localAddress: displayPeerAddress(socket.localAddress),
    localPort: socket.localPort ?? 0,
    family: parseIp(address)?.family === 6 ? 'ipv6' : 'ipv4'
  }
}

export function httpFactsOf(req: {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
}): HttpFacts {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return {
    headers,
    device: deviceOfCookieHeader(headers.cookie),
    userAgent: headers['user-agent'] ?? ''
  }
}

type Interfaces = ReturnType<typeof networkInterfaces>

/** 本机地址落在哪块网卡上（按地址值比；查不到 → 空串） */
export function interfaceNameOf(localAddress: string, interfaces: Interfaces): string {
  const target = parseIp(localAddress)
  if (!target) return ''
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      const parsed = parseIp(entry.address)
      if (parsed && parsed.family === target.family && parsed.bits === target.bits) return name
    }
  }
  return ''
}

/**
 * 网络主体：每个阶段都给齐全部键（socket 阶段还没有请求头 → `{}` / 空串）。网卡名与 cookie 是惰性的
 * （非枚举 getter，没有规则引用就不计算、不进任何序列化）
 */
export function networkSubject(
  peer: PeerFacts,
  http: HttpFacts | undefined,
  connection: string,
  interfaces: () => Interfaces
): SecuritySubject {
  const attrs: Record<string, unknown> = {
    address: peer.address,
    port: peer.port,
    localAddress: peer.localAddress,
    localPort: peer.localPort,
    family: peer.family,
    headers: http?.headers ?? {},
    device: http?.device ?? '',
    userAgent: http?.userAgent ?? '',
    connection
  }
  let iface: string | undefined
  Object.defineProperty(attrs, 'interface', {
    enumerable: false,
    get: () => (iface ??= interfaceNameOf(peer.localAddress, interfaces()))
  })
  let cookies: Record<string, string> | undefined
  Object.defineProperty(attrs, 'cookies', {
    enumerable: false,
    get: () => (cookies ??= parseCookies(http?.headers.cookie ?? ''))
  })
  return { kind: 'network', sessionId: '', attrs }
}

/** HTTP 请求的去处 */
export type RequestRoute =
  | 'page'
  | 'asset'
  | 'media'
  | 'preview'
  | 'download'
  | 'lib'
  | 'widget'
  | 'socket'

/** 路径（不含查询串）→ 去处。`upgrade`：这是一次 WebSocket 升级 */
export function requestRouteOf(pathname: string, upgrade: boolean): RequestRoute {
  if (upgrade || pathname === NETWORK_WS_PATH) return 'socket'
  if (pathname.startsWith(NETWORK_WIDGET_PREFIX)) return 'widget'
  const file = fileRouteOf(pathname)
  if (file !== undefined) return file
  if (pathname === '/' || pathname === `/${WEB_ENTRY_FILE}`) return 'page'
  return 'asset'
}

/** 请求地址 → 路径与查询（同名参数取第一个）；解析不了 → 路径原样、查询为空 */
export function requestTarget(rawUrl: string | undefined): {
  path: string
  query: Record<string, string>
} {
  const raw = typeof rawUrl === 'string' && rawUrl.length > 0 ? rawUrl : '/'
  try {
    const url = new URL(raw, 'http://shuvix.invalid')
    const query: Record<string, string> = {}
    for (const [key, value] of url.searchParams) if (!Object.hasOwn(query, key)) query[key] = value
    return { path: url.pathname, query }
  } catch {
    return { path: raw.split('?')[0].split('#')[0], query: {} }
  }
}

/**
 * 一个 HTTP 请求的 scope 与访问级别（`object.scope` / `object.access`，与 channel 点位同一套词）：页面、脚本样式、
 * 图表库与 /ws 升级是界面本身（app），文件路由是 files，`/w/…` 是 widgets；GET / HEAD / OPTIONS 是读，别的方法是写
 */
export function requestFactsOf(route: RequestRoute, method: string): CallFacts {
  const scope: ChannelScope =
    route === 'media' || route === 'preview' || route === 'download'
      ? 'files'
      : route === 'widget'
        ? 'widgets'
        : 'app'
  const reading = ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
  return { scope, access: reading ? 'read' : 'write' }
}

// ─────────────────────────── 拒绝记录 ───────────────────────────

/** 内存里最多留几条 */
export const MAX_NETWORK_DENIALS = 200
/** 同一条拒绝在这么长的窗口内合并 */
export const NETWORK_DENIAL_WINDOW_MS = 60_000

export interface NetworkDenialEntry {
  /** 哪个阶段（object.type） */
  readonly stage: 'socket' | 'request' | 'channel' | 'path'
  /** 对象摘要：`GET /`、`session:prompt`、文件路径 */
  readonly summary: string
  /** 这次请求的 scope（socket 阶段没有 → 空串） */
  readonly scope: string
  readonly address: string
  /** 设备 ID（请求带来的；第一次来、刚发了新 ID 的给新 ID） */
  readonly device: string
  readonly verdict: GateVerdict
}

/**
 * 网络点位的拒绝记录：只在内存里，最多 MAX_NETWORK_DENIALS 条；同一个（地址、设备、胜出规则、摘要）在
 * NETWORK_DENIAL_WINDOW_MS 内合并成一条（count 递增），日志行每个窗口只写一次。有新条目时调 onChange
 * （网络服务据此发 `network.changed`，自己再节流）
 */
export class NetworkDenialLog {
  private readonly entries: NetworkDenialInfo[] = []
  private readonly windows = new Map<string, { at: number; info: NetworkDenialInfo }>()

  constructor(
    private readonly deps: {
      readonly now?: () => number
      readonly logger?: { warn(message: string): void }
      readonly onChange?: () => void
    } = {}
  ) {}

  record(entry: NetworkDenialEntry): void {
    const now = (this.deps.now ?? Date.now)()
    const rule = entry.verdict.decision.winning
    const key = `${entry.address}\u0000${entry.device}\u0000${rule}\u0000${entry.summary}`
    const open = this.windows.get(key)
    if (open && now - open.at < NETWORK_DENIAL_WINDOW_MS) {
      open.info.count++
      open.info.lastAt = now
      return
    }
    const info: NetworkDenialInfo = {
      at: now,
      lastAt: now,
      count: 1,
      stage: entry.stage,
      summary: entry.summary.slice(0, 300),
      scope: entry.scope,
      address: entry.address,
      device: entry.device,
      rule,
      policies: entry.verdict.decision.prompt?.policies ?? [],
      downgraded: entry.verdict.downgraded
    }
    this.windows.set(key, { at: now, info })
    this.entries.push(info)
    if (this.entries.length > MAX_NETWORK_DENIALS) {
      const dropped = this.entries.splice(0, this.entries.length - MAX_NETWORK_DENIALS)
      for (const old of dropped) {
        for (const [k, w] of this.windows) if (w.info === old) this.windows.delete(k)
      }
    }
    // 过期的窗口顺手清掉（窗口表只为合并用，不该比条目活得久）
    for (const [k, w] of this.windows)
      if (now - w.at >= NETWORK_DENIAL_WINDOW_MS) this.windows.delete(k)
    this.deps.logger?.warn(
      `network_denial ${entry.stage} ${JSON.stringify(info.summary)} from ${entry.address}` +
        `${entry.device ? ` device ${entry.device.slice(0, 8)}` : ''} by ${rule}` +
        `${entry.verdict.downgraded ? ' (ask treated as deny)' : ''}`
    )
    this.deps.onChange?.()
  }

  /** 最近的拒绝（新 → 旧），各条是副本 */
  recent(limit = 20): NetworkDenialInfo[] {
    return this.entries
      .slice(-limit)
      .reverse()
      .map((info) => ({ ...info, policies: [...info.policies] }))
  }

  clear(): void {
    this.entries.length = 0
    this.windows.clear()
  }
}

// ─────────────────────────── 判定 ───────────────────────────

/** 给一个网络主体建 SecurityContext（桌面：toolContext.getDesktopNetworkSecurityContext） */
export type NetworkSecurityContextFor = (
  subject: SecuritySubject
) => Pick<SecurityContext, 'judgeGate'>

/** 一条 RPC 调用（channel 点位的输入） */
export interface ChannelCall {
  readonly channel: string
  readonly kind: 'invoke' | 'send'
  /** 消息的字节数 */
  readonly size: number
  readonly args: readonly unknown[]
}

/** 拿不到判定（没接上 / 抛错）时的拒绝 */
function failClosed(reason: string): GateVerdict {
  return {
    allowed: false,
    downgraded: false,
    message: 'The security check for this request failed, so it is refused.',
    decision: { effect: 'deny', matched: [], winning: 'error', reason }
  }
}

const ALLOW_UNWIRED: GateVerdict = {
  allowed: true,
  downgraded: false,
  decision: { effect: 'allow', tier: 'default', matched: [], winning: 'unwired' }
}

export class NetworkPolicyGate {
  constructor(
    private readonly deps: {
      /** 现取：没接上（单测、主入口还没 init）→ 一律放行（没有策略 = 放行） */
      readonly contextFor: () => NetworkSecurityContextFor | undefined
      readonly interfaces?: () => Interfaces
      readonly denials?: NetworkDenialLog
      readonly logger?: { warn(message: string): void }
    }
  ) {}

  private interfaces = (): Interfaces => (this.deps.interfaces ?? networkInterfaces)()

  private judge(
    subject: SecuritySubject,
    action: string,
    object: SecurityObject,
    denial: Omit<NetworkDenialEntry, 'verdict' | 'address' | 'device'> & { device?: string },
    tool?: { name: string; operation?: string }
  ): GateVerdict {
    const contextFor = this.deps.contextFor()
    if (!contextFor) return ALLOW_UNWIRED
    let verdict: GateVerdict
    try {
      verdict = contextFor(subject).judgeGate(action, object, tool ? { tool } : undefined)
    } catch (error) {
      this.deps.logger?.warn(`network: security check failed (${String(error)}); refusing`)
      verdict = failClosed(String(error))
    }
    if (!verdict.allowed) {
      const attrs = subject.attrs ?? {}
      this.deps.denials?.record({
        ...denial,
        address: String(attrs.address ?? ''),
        device: denial.device ?? String(attrs.device ?? ''),
        verdict
      })
    }
    return verdict
  }

  /** TCP 连接刚建立（HTTP 还没解析） */
  judgeSocket(peer: PeerFacts): GateVerdict {
    return this.judge(
      networkSubject(peer, undefined, '', this.interfaces),
      'connect',
      { type: 'socket' },
      { stage: 'socket', summary: `${peer.localAddress}:${peer.localPort}`, scope: '' }
    )
  }

  /**
   * 一个 HTTP 请求（含 WebSocket 升级）。`issuedDevice`：这次回应刚给它发了新的设备 ID —— 记进拒绝记录，
   * 让用户在设置页看得到这台设备的 ID（主体里的 device 仍是请求带来的，空串）
   */
  judgeRequest(
    peer: PeerFacts,
    http: HttpFacts,
    request: { method: string; path: string; query: Record<string, string>; route: RequestRoute },
    issuedDevice?: string
  ): GateVerdict {
    const facts = requestFactsOf(request.route, request.method)
    return this.judge(
      networkSubject(peer, http, '', this.interfaces),
      'request',
      {
        type: 'request',
        method: request.method,
        path: request.path,
        query: request.query,
        route: request.route,
        scope: facts.scope,
        access: facts.access
      },
      {
        stage: 'request',
        summary: `${request.method} ${request.path}`,
        scope: facts.scope,
        ...(issuedDevice && !http.device ? { device: issuedDevice } : {})
      }
    )
  }

  /** WebSocket 上的一条 RPC。`args` 是惰性的（非枚举 getter）：没有规则引用就不碰 */
  judgeChannel(
    peer: PeerFacts,
    http: HttpFacts,
    connection: string,
    call: ChannelCall
  ): GateVerdict {
    const facts = channelCallFactsOf(call.channel, call.args)
    const object: SecurityObject = {
      type: 'channel',
      channel: call.channel,
      group: channelGroupOf(call.channel),
      scope: facts.scope,
      kind: call.kind,
      access: facts.access,
      size: call.size
    }
    Object.defineProperty(object, 'args', { enumerable: false, get: () => call.args })
    // settings:set 按 key 定 scope：拒绝记录里带上 key，用户才看得出被拒的是哪一项
    const key = (call.args[0] as { key?: unknown } | null | undefined)?.key
    const summary =
      call.channel === 'settings:set' && typeof key === 'string'
        ? `${call.channel} ${key}`
        : call.channel
    return this.judge(networkSubject(peer, http, connection, this.interfaces), 'invoke', object, {
      stage: 'channel',
      summary,
      scope: facts.scope
    })
  }

  /**
   * 网络客户端要读 / 写的一个位置（绝对路径；judgeGate 会先解析成它真正通向的地方）。`tool`：经由哪条路
   * （`files` + `media` / `preview` / `download` / `read` / `write`，或 `fs` + `listDirectories`）
   */
  judgePath(
    peer: PeerFacts,
    http: HttpFacts,
    connection: string,
    mode: 'read' | 'write',
    path: string,
    tool: { name: string; operation: string }
  ): GateVerdict {
    return this.judge(
      networkSubject(peer, http, connection, this.interfaces),
      mode,
      { type: 'path', path, displayPath: path, scope: 'files', access: mode },
      { stage: 'path', summary: `${mode} ${path}`, scope: 'files' },
      tool
    )
  }
}
