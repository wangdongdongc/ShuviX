/**
 * IP 地址与网段 —— 策略里 `inCidr(ip, cidrs)` 的底层（远程访问的网络策略按对端地址判，见 celMatch.ts）。
 *
 * 安全模块宿主无关、不依赖 Node，所以这里自己解析，不借 `node:net`：
 *  - IPv4 只认严格的点分四段（每段 0–255、十进制、不带前导零以外的花样 —— `010` 按 10 读，与浏览器和
 *    Node 的 `isIPv4` 一样不认八进制）；
 *  - IPv6 认 `::` 缩写、末尾嵌 IPv4（`::ffff:1.2.3.4`），去掉 zone（`fe80::1%en0`）；
 *  - **IPv4 映射的 IPv6（`::ffff:a.b.c.d`）一律按 IPv4 比**：双栈监听时 IPv4 对端常以这种形式出现，
 *    写 `192.168.1.0/24` 的人理应也匹配到它。
 *
 * 网段写法：`地址/前缀`，或不带前缀的单个地址（= 全长前缀，等值比较）。格式不对的网段**永不命中**，
 * 不报错 —— 一份策略里一个手误的网段不该让整条规则 fail-safe 成命中（deny 的 fail-safe 是全拒）。
 */

export interface ParsedIp {
  readonly family: 4 | 6
  readonly bits: bigint
}

function parseIPv4(text: string): bigint | undefined {
  const parts = text.split('.')
  if (parts.length !== 4) return undefined
  let bits = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const value = Number(part)
    if (value > 255) return undefined
    bits = (bits << 8n) | BigInt(value)
  }
  return bits
}

function parseIPv6(text: string): bigint | undefined {
  let rest = text
  // 末尾嵌 IPv4：换成两个十六进制组
  let tail: string[] = []
  const lastColon = rest.lastIndexOf(':')
  if (lastColon >= 0 && rest.slice(lastColon + 1).includes('.')) {
    const v4 = parseIPv4(rest.slice(lastColon + 1))
    if (v4 === undefined) return undefined
    tail = [(v4 >> 16n).toString(16), (v4 & 0xffffn).toString(16)]
    rest = rest.slice(0, lastColon + 1)
    // `::1.2.3.4` 去掉末段后剩 `::`，`1::1.2.3.4` 剩 `1::`，`1:2:3:4:5:6:1.2.3.4` 剩 `1:…:6:`
    if (rest.endsWith(':') && !rest.endsWith('::')) rest = rest.slice(0, -1)
  }
  const doubleColon = rest.indexOf('::')
  if (doubleColon !== rest.lastIndexOf('::')) return undefined
  const splitGroups = (s: string): string[] | undefined => {
    if (s === '') return []
    const groups = s.split(':')
    return groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g)) ? groups : undefined
  }
  let groups: string[]
  if (doubleColon >= 0) {
    const head = splitGroups(rest.slice(0, doubleColon))
    const tailGroups = splitGroups(rest.slice(doubleColon + 2))
    if (!head || !tailGroups) return undefined
    const fill = 8 - head.length - tailGroups.length - tail.length
    // `::` 至少代表一个零组
    if (fill < 1) return undefined
    groups = [...head, ...Array<string>(fill).fill('0'), ...tailGroups, ...tail]
  } else {
    const all = splitGroups(rest)
    if (!all) return undefined
    groups = [...all, ...tail]
  }
  if (groups.length !== 8) return undefined
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n)
}

const MAPPED_PREFIX = 0xffffn << 32n

/**
 * 文本 → 地址（IPv4 映射的 IPv6 落成 IPv4；去掉 zone；IPv6 可带方括号）。不是地址 → undefined
 */
export function parseIp(text: unknown): ParsedIp | undefined {
  if (typeof text !== 'string') return undefined
  let s = text.trim()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  if (s === '' || s.length > 64) return undefined
  if (!s.includes(':')) {
    const v4 = parseIPv4(s)
    return v4 === undefined ? undefined : { family: 4, bits: v4 }
  }
  const percent = s.indexOf('%')
  if (percent >= 0) s = s.slice(0, percent)
  const v6 = parseIPv6(s)
  if (v6 === undefined) return undefined
  if (v6 >> 32n === MAPPED_PREFIX >> 32n) return { family: 4, bits: v6 & 0xffffffffn }
  return { family: 6, bits: v6 }
}

/** 网段：地址 + 前缀长度（不带前缀 = 全长）。格式不对 → undefined */
export function parseCidr(text: unknown): { ip: ParsedIp; prefix: number } | undefined {
  if (typeof text !== 'string') return undefined
  const slash = text.indexOf('/')
  const addressText = slash >= 0 ? text.slice(0, slash) : text
  const ip = parseIp(addressText)
  if (!ip) return undefined
  // 写成 `::ffff:10.0.0.0/104` 的映射网段：前缀按 IPv6 的 128 位算，落成 IPv4 后减去 96
  const mappedWritten = ip.family === 4 && addressText.includes(':')
  const width = ip.family === 4 ? 32 : 128
  if (slash < 0) return { ip, prefix: width }
  const prefixText = text.slice(slash + 1).trim()
  if (!/^\d{1,3}$/.test(prefixText)) return undefined
  let prefix = Number(prefixText)
  if (mappedWritten) {
    if (prefix < 96 || prefix > 128) return undefined
    prefix -= 96
  }
  if (prefix > width) return undefined
  return { ip, prefix }
}

/** ip 是否落在 cidrs（一个或一组网段）里的任一个。ip 不是地址、网段不是字符串或格式不对 → 不命中 */
export function ipInCidrs(ip: unknown, cidrs: unknown): boolean {
  const address = parseIp(ip)
  if (!address) return false
  const list = Array.isArray(cidrs) ? cidrs : [cidrs]
  return list.some((entry) => {
    const cidr = parseCidr(entry)
    if (!cidr || cidr.ip.family !== address.family) return false
    const width = address.family === 4 ? 32 : 128
    const shift = BigInt(width - cidr.prefix)
    return address.bits >> shift === cidr.ip.bits >> shift
  })
}
