/**
 * `frontend/network/lanScope.ts` —— 只开放给一个网络（2026-10-15）：把网卡名 / 本机地址落到一块网卡上的一个地址 + 网段、
 * 对端是否在那个网段里、设置页能挑的网络、打开它的地址。纯函数，网卡表是假的（`IF`）。
 *
 *   LS-1  resolveLanNetwork('eth0') 恰是 {interface, address, cidr, family:4, prefix:24}（网段取自 cidr）
 *   LS-2  网卡名取第一个 IPv4（IPv6 排在前面也一样），cidr 缺 → 按掩码算前缀；数字 family 也认
 *   LS-3  没有 IPv4 → 第一个非链路本地的 IPv6；只有链路本地 / 只有内部 / 网卡缺值 / 掩码不连续 / 不存在 / 大小写不同 → undefined
 *   LS-4  地址：必须恰是某块非内部网卡上的地址（IPv6 的不同写法也认，回的是网卡上的写法）；内部、不存在、IPv4 映射的
 *         IPv6、带 `%` 的写法 → undefined；地址可以是链路本地（只有网卡名才跳过它）
 *   LS-5  首尾空白去掉；空串、带 shell 元字符、`-` 开头 → undefined
 *   LS-6  isInLanNetwork（10.0.0.5/24）：网段内（含网络地址与广播地址、IPv4 映射的点分写法）真；网段外、地址族不同、
 *         非地址、缺失假；十六进制写法的映射地址假（服务器先把它拆成点分 —— 见 guards 的 NG-9c）
 *   LS-7  IPv6 网段（fd00::10/64）：同前缀（含展开写法、带 zone）真；别的前缀、IPv4 假
 *   LS-8  前缀 0 → 同地址族的任何地址都在；/32 → 只有它自己
 *   LS-9  lanCandidates：每块非内部网卡的第一个私有 IPv4，按网卡名排序；内部、公网、CGNAT、只有 IPv6、掩码不连续、
 *         网卡缺值的不列
 *   LS-10 lanNetworkUrl：IPv4 原样，IPv6 加方括号
 */
import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { isPrivatePeerAddress } from '../guards'
import {
  isInLanNetwork,
  lanCandidates,
  lanNetworkUrl,
  resolveLanNetwork,
  type LanNetwork
} from '../lanScope'

function entry(
  address: string,
  family: string | number,
  netmask: string,
  cidr: string | null,
  internal = false
): NetworkInterfaceInfo {
  return { address, family, netmask, cidr, internal, mac: '' } as unknown as NetworkInterfaceInfo
}

const V6_MASK = 'ffff:ffff:ffff:ffff::'

const IF: Record<string, NetworkInterfaceInfo[] | undefined> = {
  eth0: [
    entry('10.0.0.5', 'IPv4', '255.255.255.0', '10.0.0.5/24'),
    entry('fe80::1', 'IPv6', V6_MASK, 'fe80::1/64')
  ],
  eth1: [
    entry('fe80::2', 'IPv6', V6_MASK, 'fe80::2/64'),
    entry('192.168.50.10', 'IPv4', '255.255.255.0', null)
  ],
  v6: [
    entry('fe80::3', 'IPv6', V6_MASK, 'fe80::3/64'),
    entry('fd00::10', 'IPv6', V6_MASK, 'fd00::10/64')
  ],
  ll: [entry('fe80::4', 'IPv6', V6_MASK, 'fe80::4/64')],
  lo: [entry('127.0.0.1', 'IPv4', '255.0.0.0', '127.0.0.1/8', true)],
  num: [entry('172.16.5.5', 4, '255.255.0.0', null)],
  bad: [entry('192.168.9.9', 'IPv4', '255.0.255.0', null)],
  wan: [entry('8.8.8.8', 'IPv4', '255.255.255.0', '8.8.8.8/24')],
  cgnat: [entry('100.64.1.2', 'IPv4', '255.192.0.0', '100.64.1.2/10')],
  none: undefined
}

const ETH0: LanNetwork = {
  interface: 'eth0',
  address: '10.0.0.5',
  cidr: '10.0.0.5/24',
  family: 4,
  prefix: 24
}
const ETH1: LanNetwork = {
  interface: 'eth1',
  address: '192.168.50.10',
  cidr: '192.168.50.10/24',
  family: 4,
  prefix: 24
}
const NUM: LanNetwork = {
  interface: 'num',
  address: '172.16.5.5',
  cidr: '172.16.5.5/16',
  family: 4,
  prefix: 16
}
const V6: LanNetwork = {
  interface: 'v6',
  address: 'fd00::10',
  cidr: 'fd00::10/64',
  family: 6,
  prefix: 64
}

describe('LS-1..LS-3 网卡名', () => {
  it('LS-1 eth0 → 它的 IPv4 与网段', () => {
    expect(resolveLanNetwork('eth0', IF)).toStrictEqual(ETH0)
  })

  it('LS-2 IPv6 排在前面也取 IPv4；cidr 缺 → 按掩码；数字 family', () => {
    expect(resolveLanNetwork('eth1', IF)).toStrictEqual(ETH1)
    expect(resolveLanNetwork('num', IF)).toStrictEqual(NUM)
  })

  it('LS-3 只有 IPv6 → 跳过链路本地；找不到 → undefined', () => {
    expect(resolveLanNetwork('v6', IF)).toStrictEqual(V6)
    for (const spec of ['ll', 'lo', 'none', 'bad', 'eth9', 'ETH0']) {
      expect(resolveLanNetwork(spec, IF), spec).toBeUndefined()
    }
  })
})

describe('LS-4 / LS-5 地址与写法', () => {
  it('LS-4 地址必须恰是某块非内部网卡上的', () => {
    expect(resolveLanNetwork('192.168.50.10', IF)).toStrictEqual(ETH1)
    expect(resolveLanNetwork('10.0.0.5', IF)).toStrictEqual(ETH0)
    expect(resolveLanNetwork('fd00:0:0:0:0:0:0:10', IF)).toStrictEqual(V6)
    for (const spec of ['127.0.0.1', '10.0.0.6', '::ffff:192.168.50.10', 'fe80::2%eth1']) {
      expect(resolveLanNetwork(spec, IF), spec).toBeUndefined()
    }
  })

  it('LS-4 地址不跳过链路本地', () => {
    expect(resolveLanNetwork('fe80::2', IF)).toStrictEqual({
      interface: 'eth1',
      address: 'fe80::2',
      cidr: 'fe80::2/64',
      family: 6,
      prefix: 64
    })
  })

  it('LS-5 去首尾空白；空串、元字符、- 开头 → undefined', () => {
    expect(resolveLanNetwork(' eth0 ', IF)).toStrictEqual(ETH0)
    for (const spec of ['', 'eth1;x', '-eth0']) {
      expect(resolveLanNetwork(spec, IF), JSON.stringify(spec)).toBeUndefined()
    }
  })
})

describe('LS-6..LS-8 isInLanNetwork', () => {
  it('LS-6 IPv4 网段', () => {
    for (const peer of ['10.0.0.200', '10.0.0.5', '10.0.0.0', '10.0.0.255', '::ffff:10.0.0.7']) {
      expect(isInLanNetwork(peer, ETH0), peer).toBe(true)
    }
    for (const peer of [
      '10.0.1.1',
      '::ffff:10.0.1.7',
      'fe80::1',
      '',
      'garbage',
      undefined,
      null,
      // 十六进制写法的映射地址：服务器先拆成点分再问（NG-9c），这里按 IPv6 算 → 不在
      '::ffff:a00:7'
    ]) {
      expect(isInLanNetwork(peer, ETH0), String(peer)).toBe(false)
    }
  })

  it('LS-7 IPv6 网段', () => {
    for (const peer of ['fd00::1', 'fd00:0:0:0:ffff::1', 'fd00::1%v6']) {
      expect(isInLanNetwork(peer, V6), peer).toBe(true)
    }
    for (const peer of ['fd01::1', '10.0.0.1']) {
      expect(isInLanNetwork(peer, V6), peer).toBe(false)
    }
  })

  it('LS-8 前缀 0 → 同地址族都在；/32 → 只有它自己', () => {
    const everything: LanNetwork = { ...ETH0, cidr: '10.0.0.5/0', prefix: 0 }
    for (const peer of ['8.8.8.8', '10.0.0.5', '192.168.1.1', '255.255.255.255', '0.0.0.0']) {
      expect(isInLanNetwork(peer, everything), peer).toBe(true)
    }
    expect(isInLanNetwork('fd00::1', everything)).toBe(false)

    const single: LanNetwork = { ...ETH0, cidr: '10.0.0.5/32', prefix: 32 }
    expect(isInLanNetwork('10.0.0.5', single)).toBe(true)
    for (const peer of ['10.0.0.4', '10.0.0.6', '10.0.0.200']) {
      expect(isInLanNetwork(peer, single), peer).toBe(false)
    }
  })
})

describe('LS-9 / LS-10 候选与地址', () => {
  it('LS-9 每块非内部网卡的第一个私有 IPv4，按网卡名排序', () => {
    expect(lanCandidates(IF, isPrivatePeerAddress)).toStrictEqual([ETH0, ETH1, NUM])
  })

  it('LS-10 lanNetworkUrl', () => {
    expect(lanNetworkUrl(ETH0, 7766)).toBe('http://10.0.0.5:7766')
    expect(lanNetworkUrl(V6, 7766)).toBe('http://[fd00::10]:7766')
  })
})
