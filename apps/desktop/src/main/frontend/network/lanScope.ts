/**
 * 「只开放给一个网络」（用户需求 2026-10-15：一台机器连着几个局域网，只想在其中一个上开放）—— 纯函数，单测直接引。
 *
 * 用户给的是一个网卡名（`eth1`、`en0`）或这台电脑上的一个地址（`192.168.50.10`）：
 *  - `resolveLanNetwork` 把它落到一块网卡上的一个地址 + 网段（网卡名 → 它的第一个 IPv4 地址，没有 IPv4 才用
 *    非链路本地的 IPv6）。网络服务**只在这个地址上监听**，别的网卡上的局域网连不到这个端口；
 *  - `isInLanNetwork` 是第二道：对端地址必须落在这个网段里。只监听一个地址挡不住一台在几个局域网之间转发的机器
 *    （Linux 收发往本机任何地址的包，不论从哪块网卡进来），所以再按对端地址核一遍。
 * 两道都叠在原有的「对端必须是私有地址」之上，不替代它。
 */
import { isIP } from 'node:net'
import type { NetworkInterfaceInfo } from 'node:os'
import { isValidLanInterfaceSpec } from '../../../shared/network'

/** 开放给的那个网络：网卡、监听的地址、网段 */
export interface LanNetwork {
  /** 网卡名 */
  readonly interface: string
  /** 监听的地址（IPv6 不带方括号、不带 zone） */
  readonly address: string
  /** 网段（`192.168.50.10/24`） */
  readonly cidr: string
  readonly family: 4 | 6
  /** 前缀长度 */
  readonly prefix: number
}

type Interfaces = Readonly<Record<string, readonly NetworkInterfaceInfo[] | undefined>>

function familyOf(entry: NetworkInterfaceInfo): 4 | 6 | undefined {
  // Node 18 起 family 是 'IPv4' / 'IPv6'；更早的版本是数字
  const family = entry.family as unknown
  if (family === 'IPv4' || family === 4) return 4
  if (family === 'IPv6' || family === 6) return 6
  return undefined
}

function stripZone(address: string): string {
  const percent = address.indexOf('%')
  return percent === -1 ? address : address.slice(0, percent)
}

/** 掩码 → 前缀长度（不连续的掩码 → undefined） */
function prefixFromNetmask(netmask: string, family: 4 | 6): number | undefined {
  const bits = family === 4 ? ipv4Bits(netmask) : ipv6Bits(netmask)
  if (bits === undefined) return undefined
  const width = family === 4 ? 32 : 128
  const binary = bits.toString(2).padStart(width, '0')
  const prefix = binary.indexOf('0') === -1 ? width : binary.indexOf('0')
  return /^1*0*$/.test(binary) ? prefix : undefined
}

function ipv4Bits(address: string): bigint | undefined {
  if (isIP(address) !== 4) return undefined
  return address.split('.').reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n)
}

function ipv6Bits(address: string): bigint | undefined {
  const plain = stripZone(address)
  if (isIP(plain) !== 6) return undefined
  let text = plain
  // 末尾的点分 IPv4（::ffff:1.2.3.4）先换成两个十六进制段
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const v4 = ipv4Bits(dotted[1])
    if (v4 === undefined) return undefined
    text = `${text.slice(0, -dotted[1].length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`
  }
  const [head, tail] = text.split('::')
  const headParts = head === '' ? [] : head.split(':')
  const tailParts = tail === undefined || tail === '' ? [] : tail.split(':')
  const fill = tail === undefined ? 0 : 8 - headParts.length - tailParts.length
  const parts = [...headParts, ...Array<string>(fill).fill('0'), ...tailParts]
  if (parts.length !== 8) return undefined
  return parts.reduce((acc, part) => (acc << 16n) | BigInt(parseInt(part, 16)), 0n)
}

/** `::ffff:a.b.c.d` → `a.b.c.d`；别的原样 */
function unwrapMapped(address: string): string {
  const m = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  return m ? m[1] : address
}

function toLanNetwork(name: string, entry: NetworkInterfaceInfo): LanNetwork | undefined {
  const family = familyOf(entry)
  if (family === undefined) return undefined
  const address = stripZone(entry.address)
  const fromCidr = entry.cidr ? Number(entry.cidr.slice(entry.cidr.lastIndexOf('/') + 1)) : NaN
  const prefix = Number.isInteger(fromCidr) ? fromCidr : prefixFromNetmask(entry.netmask, family)
  if (prefix === undefined) return undefined
  return { interface: name, address, cidr: `${address}/${prefix}`, family, prefix }
}

function isLinkLocalIPv6(address: string): boolean {
  const bits = ipv6Bits(address)
  return bits !== undefined && bits >> 118n === 0x3fan // fe80::/10
}

/**
 * 网卡名或本机地址 → 那块网卡上的一个地址 + 网段。地址（IPv4 / IPv6 字面量）必须恰是某块非内部网卡的地址；
 * 网卡名取它的第一个 IPv4 地址，没有 IPv4 取第一个非链路本地的 IPv6。找不到 → undefined
 */
export function resolveLanNetwork(spec: string, interfaces: Interfaces): LanNetwork | undefined {
  const wanted = spec.trim()
  if (!isValidLanInterfaceSpec(wanted)) return undefined
  const literal = stripZone(wanted)
  if (isIP(literal) !== 0) {
    const family = isIP(literal) === 4 ? 4 : 6
    const bits = family === 4 ? ipv4Bits(literal) : ipv6Bits(literal)
    for (const [name, entries] of Object.entries(interfaces)) {
      for (const entry of entries ?? []) {
        if (entry.internal || familyOf(entry) !== family) continue
        const entryBits = family === 4 ? ipv4Bits(entry.address) : ipv6Bits(entry.address)
        if (entryBits === bits) return toLanNetwork(name, entry)
      }
    }
    return undefined
  }
  const entries = (interfaces[wanted] ?? []).filter((entry) => !entry.internal)
  const v4 = entries.find((entry) => familyOf(entry) === 4)
  if (v4) return toLanNetwork(wanted, v4)
  const v6 = entries.find((entry) => familyOf(entry) === 6 && !isLinkLocalIPv6(entry.address))
  return v6 ? toLanNetwork(wanted, v6) : undefined
}

/** 对端地址落不落在这个网络的网段里（IPv4 映射的 IPv6 按 IPv4 算；地址族不同 → 不在） */
export function isInLanNetwork(peer: string | undefined | null, network: LanNetwork): boolean {
  if (typeof peer !== 'string') return false
  const address = unwrapMapped(stripZone(peer))
  const family = isIP(address)
  if (family !== network.family) return false
  const width = family === 4 ? 32 : 128
  const a = family === 4 ? ipv4Bits(address) : ipv6Bits(address)
  const b = family === 4 ? ipv4Bits(network.address) : ipv6Bits(network.address)
  if (a === undefined || b === undefined) return false
  const shift = BigInt(width - network.prefix)
  return a >> shift === b >> shift
}

/**
 * 设置页能挑的网络：每块非内部网卡的第一个 IPv4 地址（`isPrivate` 过滤掉对端那道门本来就不放的公网地址），
 * 按网卡名排序。IPv6 与其余地址照样能用网卡名 / 地址写进启动参数，这里只列最常用的那一种
 */
export function lanCandidates(
  interfaces: Interfaces,
  isPrivate: (address: string) => boolean
): LanNetwork[] {
  const out: LanNetwork[] = []
  for (const name of Object.keys(interfaces).sort()) {
    const entry = (interfaces[name] ?? []).find(
      (e) => !e.internal && familyOf(e) === 4 && isPrivate(e.address)
    )
    const network = entry ? toLanNetwork(name, entry) : undefined
    if (network) out.push(network)
  }
  return out
}

/** 浏览器里打开它的地址（IPv6 加方括号） */
export function lanNetworkUrl(network: LanNetwork, port: number): string {
  return network.family === 6
    ? `http://[${network.address}]:${port}`
    : `http://${network.address}:${port}`
}
