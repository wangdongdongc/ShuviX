/**
 * 网络服务的三道门（server mode phase B，docs/server/phase-bc-network-and-web.md §B2）—— **不是认证**（这一轮按用户
 * 裁决没有认证、没有安全模型），只是几道便宜的、挡住明显误用的检查。每个 HTTP 请求与每次 WebSocket 升级都过：
 *
 *  1. **对端地址**必须是本机 / 私有 / 链路本地（IPv4 127/8、10/8、172.16/12、192.168/16、169.254/16；IPv6 `::1`、
 *     `fc00::/7`、`fe80::/10`；IPv4 映射的 IPv6 先拆开）—— 否则 403。开到公网上的端口转发 / 云主机上的服务就此挡住。
 *  2. **Host** 必须是 IP 字面量或 `localhost`，端口是我们的 —— 否则 421。挡 DNS 重绑定：恶意网页把自己的域名解析到
 *     局域网地址，浏览器发来的 Host 仍是那个域名。
 *  3. **升级**的 `Origin` 必须恰好是 `http://<Host>` —— 否则 403。挡用户自己浏览器里的任何网页经
 *     `ws://<局域网地址>:<端口>` 驱动 ShuviX（WebSocket 不受同源策略管，Origin 是唯一的线索）。
 *
 * 纯函数，不碰 Node 的网络对象：服务端把 `req.socket.remoteAddress` / `req.headers.host` / `req.headers.origin` 交进来。
 */
import { isIPv4, isIPv6 } from 'node:net'

/** IPv4 点分四段 → 四个八位数；不是严格的点分四段 → undefined */
function ipv4Octets(address: string): number[] | undefined {
  if (!isIPv4(address)) return undefined
  const parts = address.split('.').map((p) => Number(p))
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : undefined
}

function isPrivateIPv4(address: string): boolean {
  const o = ipv4Octets(address)
  if (o === undefined) return false
  const [a, b] = o
  return (
    a === 127 || // 127.0.0.0/8 回环
    a === 10 || // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) // 169.254.0.0/16 链路本地
  )
}

/** `::ffff:a.b.c.d`（以及大写 / 全写的 `0:0:0:0:0:ffff:a.b.c.d`）→ `a.b.c.d`；不是 IPv4 映射 → undefined */
function unwrapMappedIPv4(address: string): string | undefined {
  const match = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  if (match && isIPv6(address)) return match[1]
  // 十六进制形式的映射地址（`::ffff:7f00:1`）
  const hex = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address)
  if (hex && isIPv6(address)) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  }
  return undefined
}

/** IPv6 的第一个 16 位组（`::` 打头 → 0）；不是 IPv6 → undefined */
function firstHextet(address: string): number | undefined {
  if (!isIPv6(address)) return undefined
  if (address.startsWith('::')) return 0
  const head = address.split(':')[0]
  const value = parseInt(head, 16)
  return Number.isNaN(value) ? undefined : value
}

/** 是不是 IPv6 回环 `::1`（任意零的写法） */
function isIPv6Loopback(address: string): boolean {
  if (!isIPv6(address)) return false
  // 展开成 8 组再比：只有最后一组是 1、其余全 0
  const [head, tail] = address.includes('::') ? address.split('::') : [address, '']
  const headParts = head ? head.split(':') : []
  const tailParts = tail ? tail.split(':') : []
  const fill = 8 - headParts.length - tailParts.length
  if (fill < 0) return false
  const groups = [...headParts, ...Array<string>(fill).fill('0'), ...tailParts]
  return (
    groups.length === 8 &&
    groups.slice(0, 7).every((g) => parseInt(g, 16) === 0) &&
    parseInt(groups[7], 16) === 1
  )
}

/**
 * 对端地址是不是本机 / 私有 / 链路本地。去掉 IPv6 的 zone（`fe80::1%en0`）、拆开 IPv4 映射；
 * 拿不到地址 / 不是 IP → false
 */
export function isPrivatePeerAddress(address: string | undefined | null): boolean {
  if (typeof address !== 'string' || address.length === 0) return false
  if (isIPv4(address)) return isPrivateIPv4(address)
  // zone（`fe80::1%en0`）只属于 IPv6：带 % 的 IPv4 不是地址
  const bare = address.includes('%') ? address.slice(0, address.indexOf('%')) : address
  if (!isIPv6(bare)) return false
  const mapped = unwrapMappedIPv4(bare)
  if (mapped !== undefined) return isPrivateIPv4(mapped)
  if (isIPv6Loopback(bare)) return true
  const first = firstHextet(bare)
  if (first === undefined) return false
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 唯一本地
    (first & 0xffc0) === 0xfe80 // fe80::/10 链路本地
  )
}

/** 地址的显示形式：IPv4 映射的 IPv6 拆成 IPv4，其余原样（拿不到 → 空串） */
export function displayPeerAddress(address: string | undefined | null): string {
  if (typeof address !== 'string') return ''
  return unwrapMappedIPv4(address) ?? address
}

/** `Host` 头 → 主机名（IPv6 去掉方括号）与端口；格式不对 → undefined */
export function parseHostHeader(
  host: string | undefined | null
): { hostname: string; port: number | undefined } | undefined {
  if (typeof host !== 'string' || host.length === 0 || host.length > 300) return undefined
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    if (close < 0) return undefined
    const hostname = host.slice(1, close)
    const rest = host.slice(close + 1)
    if (rest === '') return { hostname, port: undefined }
    if (!/^:\d{1,5}$/.test(rest)) return undefined
    return { hostname, port: Number(rest.slice(1)) }
  }
  const colon = host.lastIndexOf(':')
  if (colon < 0) return { hostname: host, port: undefined }
  const portText = host.slice(colon + 1)
  if (!/^\d{1,5}$/.test(portText)) return undefined
  return { hostname: host.slice(0, colon), port: Number(portText) }
}

/**
 * `Host` 头能不能接受：主机是 IP 字面量（IPv4 点分四段，或方括号里的 IPv6）或 `localhost`（不分大小写），
 * 端口恰是 `port`（我们只监听 1024 以上的端口，所以不带端口的 Host 一律不认）
 */
export function isAllowedHost(host: string | undefined | null, port: number): boolean {
  const parsed = parseHostHeader(host)
  if (parsed === undefined || parsed.port !== port) return false
  // 端口逐字是我们的（`:07766` 不认：浏览器从不这么写）
  if (!host!.endsWith(`:${port}`)) return false
  const { hostname } = parsed
  // 方括号里只能是 IPv6 字面量（不带 zone）
  if (host!.startsWith('[')) return !hostname.includes('%') && isIPv6(hostname)
  if (hostname.toLowerCase() === 'localhost') return true
  return ipv4Octets(hostname) !== undefined
}

/** 升级的 `Origin` 能不能接受：恰好等于 `http://<Host>`（逐字比较，不做任何归一） */
export function isAllowedOrigin(
  origin: string | undefined | null,
  host: string | undefined | null
): boolean {
  if (typeof origin !== 'string' || typeof host !== 'string' || host.length === 0) return false
  return origin === `http://${host}`
}
