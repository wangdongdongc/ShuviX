/**
 * `frontend/network/guards.ts` —— 网络服务的三道门（server mode phase B §B2）：对端地址必须私有、Host 必须是 IP 字面量或
 * localhost 带我们的端口、升级的 Origin 必须恰是 `http://<Host>`。纯函数；`requestRejection`（前两道门的状态码）取自 server.ts。
 *
 *   NG-1 isPrivatePeerAddress 为真：IPv4 回环 / 10 / 172.16–31 / 192.168 / 169.254；IPv6 回环（各种零的写法）、
 *        fc00::/7、fe80::/10（大写、带 zone）；IPv4 映射（点分与十六进制）指向私有地址
 *   NG-2 为假：边界外的 IPv4、CGNAT、0.0.0.0、公网、前导零；`::` / `::2` / 其它 IPv6 段；映射的公网地址；
 *        IPv4 兼容 / NAT64 / 不合规的映射写法；非地址；**带 % 的 IPv4**（zone 只属于 IPv6）
 *   NG-3 displayPeerAddress：映射地址拆成 IPv4，其余原样；拿不到 → ''
 *   NG-4 parseHostHeader：主机名 + 端口；IPv6 去方括号；无方括号的 IPv6 按最后一个冒号拆；格式不对 → undefined
 *   NG-5 isAllowedHost 为真：IPv4 字面量 / localhost（不分大小写）/ 方括号里的 IPv6，带恰好的端口
 *   NG-6 为假：缺端口 / 别的端口 / 多一段端口 / 前导零端口；名字；方括号里不是 IPv6（含 `[localhost]`）、带 zone；
 *        无方括号的 IPv6；不完整的 IPv4；空主机；缺失
 *   NG-7 isAllowedOrigin：只有逐字的 `http://<Host>`；末尾斜杠、https、'null'、缺失、换了主机名、大小写不同、空 Host → 假
 *   NG-8 requestRejection：非私有对端 → 403（先查对端）；坏 Host → 421；端口 -1（停止途中）→ 421；都过 → undefined
 */
import { describe, expect, it } from 'vitest'
import {
  displayPeerAddress,
  isAllowedHost,
  isAllowedOrigin,
  isPrivatePeerAddress,
  parseHostHeader
} from '../guards'
import { requestRejection } from '../server'

describe('NG-1 isPrivatePeerAddress 为真', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.255',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.0',
    '172.31.255.255',
    '192.168.0.0',
    '192.168.255.255',
    '169.254.0.1',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::0001',
    '0000:0000:0000:0000:0000:0000:0000:0001',
    'fc00::1',
    'fdff:ffff::1',
    'fe80::1',
    'febf::1',
    'FE80::1',
    'fe80::1%en0',
    'fe80::1%25en0',
    '::ffff:127.0.0.1',
    '::ffff:10.1.2.3',
    '::FFFF:192.168.1.1',
    '0:0:0:0:0:ffff:192.168.1.1',
    '::ffff:7f00:1',
    '::ffff:c0a8:101',
    '::ffff:a9fe:1'
  ])('NG-1 %s', (address) => {
    expect(isPrivatePeerAddress(address)).toBe(true)
  })
})

describe('NG-2 isPrivatePeerAddress 为假', () => {
  it.each([
    '126.0.0.1',
    '128.0.0.1',
    '9.255.255.255',
    '11.0.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '192.167.1.1',
    '192.169.0.1',
    '169.253.255.255',
    '169.255.0.1',
    '100.64.0.1',
    '0.0.0.0',
    '8.8.8.8',
    '255.255.255.255',
    '010.0.0.1',
    '::',
    '::2',
    'fbff::1',
    'fe00::1',
    'fec0::1',
    '2001:db8::1',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '::127.0.0.1',
    '::7f00:1',
    '64:ff9b::7f00:1',
    '1::ffff:10.0.0.1',
    '::ffff:0:10.0.0.1',
    '',
    'localhost',
    'not-an-ip',
    '[::1]',
    '10.0.0.1%en0',
    '127.0.0.1%lo0',
    '192.168.1.1%25en0'
  ])('NG-2 %s', (address) => {
    expect(isPrivatePeerAddress(address)).toBe(false)
  })

  it('NG-2 undefined / null', () => {
    expect(isPrivatePeerAddress(undefined)).toBe(false)
    expect(isPrivatePeerAddress(null)).toBe(false)
  })
})

describe('NG-3 displayPeerAddress', () => {
  it('NG-3 映射地址拆成 IPv4，其余原样，拿不到 → 空串', () => {
    expect(displayPeerAddress('::ffff:10.1.2.3')).toBe('10.1.2.3')
    expect(displayPeerAddress('::ffff:7f00:1')).toBe('127.0.0.1')
    expect(displayPeerAddress('::ffff:8.8.8.8')).toBe('8.8.8.8')
    for (const address of ['127.0.0.1', 'fe80::1%en0', '2001:db8::1']) {
      expect(displayPeerAddress(address)).toBe(address)
    }
    expect(displayPeerAddress(undefined)).toBe('')
    expect(displayPeerAddress(null)).toBe('')
  })
})

describe('NG-4 parseHostHeader', () => {
  it('NG-4 主机名 + 端口', () => {
    expect(parseHostHeader('127.0.0.1:7766')).toStrictEqual({ hostname: '127.0.0.1', port: 7766 })
    expect(parseHostHeader('localhost')).toStrictEqual({ hostname: 'localhost', port: undefined })
    expect(parseHostHeader('[::1]:7766')).toStrictEqual({ hostname: '::1', port: 7766 })
    expect(parseHostHeader('[::1]')).toStrictEqual({ hostname: '::1', port: undefined })
    // 按最后一个冒号拆：isAllowedHost 得把它拒掉
    expect(parseHostHeader('::1:7766')).toStrictEqual({ hostname: '::1', port: 7766 })
  })

  it('NG-4 格式不对 → undefined', () => {
    for (const host of [
      '[::1',
      '[::1]x',
      '[::1]:',
      '127.0.0.1:123456',
      'host:abc',
      '',
      undefined,
      'h'.repeat(301)
    ]) {
      expect(parseHostHeader(host), String(host)).toBeUndefined()
    }
  })
})

describe('NG-5 isAllowedHost 为真', () => {
  it.each([
    '127.0.0.1:7766',
    'localhost:7766',
    'LOCALHOST:7766',
    '[::1]:7766',
    '[::ffff:127.0.0.1]:7766',
    '1.2.3.4:7766',
    '0.0.0.0:7766'
  ])('NG-5 %s', (host) => {
    expect(isAllowedHost(host, 7766)).toBe(true)
  })
})

describe('NG-6 isAllowedHost 为假', () => {
  it.each([
    '127.0.0.1',
    '127.0.0.1:7767',
    '127.0.0.1:7766:7766',
    '127.0.0.1:07766',
    '[::1]',
    'localhost.:7766',
    'foo.localhost:7766',
    'evil.com:7766',
    '[evil.com]:7766',
    '[localhost]:7766',
    '::1:7766',
    '[fe80::1%25en0]:7766',
    '[fe80::1%en0]:7766',
    '127.1:7766',
    '256.0.0.1:7766',
    ':7766',
    ''
  ])('NG-6 %s', (host) => {
    expect(isAllowedHost(host, 7766)).toBe(false)
  })

  it('NG-6 undefined / null', () => {
    expect(isAllowedHost(undefined, 7766)).toBe(false)
    expect(isAllowedHost(null, 7766)).toBe(false)
  })
})

describe('NG-7 isAllowedOrigin', () => {
  it('NG-7 只认逐字的 http://<Host>', () => {
    const host = '127.0.0.1:7766'
    expect(isAllowedOrigin('http://127.0.0.1:7766', host)).toBe(true)
    for (const origin of ['http://127.0.0.1:7766/', 'https://127.0.0.1:7766', 'null', undefined]) {
      expect(isAllowedOrigin(origin, host), String(origin)).toBe(false)
    }
    expect(isAllowedOrigin('http://localhost:7766', '127.0.0.1:7766')).toBe(false)
    // 不做任何归一
    expect(isAllowedOrigin('http://LOCALHOST:7766', 'localhost:7766')).toBe(false)
    // 空 Host 一律不认
    expect(isAllowedOrigin('http://', '')).toBe(false)
    expect(isAllowedOrigin('http://127.0.0.1:7766', undefined)).toBe(false)
  })
})

describe('NG-8 requestRejection', () => {
  const FORBIDDEN = {
    status: 403,
    text: 'ShuviX only accepts connections from the local network.'
  }
  const MISDIRECTED = {
    status: 421,
    text: 'Use an IP address or localhost with the ShuviX port.'
  }

  it('NG-8 非私有对端 → 403；坏 Host → 421；都过 → undefined', () => {
    expect(requestRejection('8.8.8.8', '127.0.0.1:7766', 7766)).toStrictEqual(FORBIDDEN)
    expect(requestRejection('127.0.0.1', 'evil:7766', 7766)).toStrictEqual(MISDIRECTED)
    expect(requestRejection('127.0.0.1', '127.0.0.1:7766', 7766)).toBeUndefined()
    expect(requestRejection(undefined, '127.0.0.1:7766', 7766)).toStrictEqual(FORBIDDEN)
  })

  it('NG-8 先查对端：非私有对端 + 坏 Host → 403', () => {
    expect(requestRejection('8.8.8.8', 'evil', 7766)).toStrictEqual(FORBIDDEN)
  })

  it('NG-8 端口 -1（停止途中）→ 任何 Host 都是 421', () => {
    for (const host of ['127.0.0.1:7766', 'localhost:-1', '127.0.0.1:1', undefined]) {
      expect(requestRejection('127.0.0.1', host, -1), String(host)).toStrictEqual(MISDIRECTED)
    }
  })
})
