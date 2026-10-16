/**
 * `shared/network.ts` —— 网络访问的两个设置键与端口的取值规则（server mode phase B §B1）：缺省关，只有字面量 `'true'` 开；
 * 端口缺省 7766、必须是 1024–65535 的整数，读到不合法的值一律按缺省。
 *
 *   NN-1 键名 `network.enabled` / `network.port`；缺省 7766、下限 1024、上限 65535
 *   NN-2 isNetworkEnabledValue：只有 `'true'` 为真（大小写、'1'、'yes'、带空白、空、null、undefined 都是假）
 *   NN-3 isValidNetworkPort：1024 / 7766 / 65535 真；越界、小数、NaN、Infinity、字符串、null、undefined 假
 *   NN-4 parseNetworkPort：十进制整数串（可带首尾空白、前导零）→ 数；越界、小数、十六进制、科学计数、负数、
 *        带尾巴、空、null、undefined → 7766
 *   NN-5 只开放给一个网络：键名 `network.lanInterface`、错误码 `ENOINTERFACE`
 *   NN-6 isValidLanInterfaceSpec：网卡名 / IP 字面量（ASCII 字母数字 `_ . : -`，1–64 字符，不以 `-` 开头）真；
 *        空、超长、`-` 开头、空白、换行、shell 元字符、`/` 与引号、`%`（zone）、非 ASCII、非字符串假
 *   NN-7 parseLanInterfaceValue：去首尾空白；空 / 空白 / null / undefined → undefined；不合法的值原样返回
 *        （落不到任何网卡上，网络服务因此不监听 —— 宁可关着）
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NETWORK_PORT,
  isNetworkEnabledValue,
  isValidLanInterfaceSpec,
  isValidNetworkPort,
  MAX_NETWORK_PORT,
  MIN_NETWORK_PORT,
  NETWORK_ENABLED_KEY,
  NETWORK_ERROR_NO_INTERFACE,
  NETWORK_LAN_INTERFACE_KEY,
  NETWORK_PORT_KEY,
  parseLanInterfaceValue,
  parseNetworkPort
} from '../network'

describe('NN-1 键与端口常量', () => {
  it('NN-1 键名与端口范围', () => {
    expect(NETWORK_ENABLED_KEY).toBe('network.enabled')
    expect(NETWORK_PORT_KEY).toBe('network.port')
    expect(DEFAULT_NETWORK_PORT).toBe(7766)
    expect(MIN_NETWORK_PORT).toBe(1024)
    expect(MAX_NETWORK_PORT).toBe(65535)
  })
})

describe('NN-2 isNetworkEnabledValue', () => {
  it("NN-2 只有 'true' 为真", () => {
    expect(isNetworkEnabledValue('true')).toBe(true)
    for (const value of ['TRUE', '1', 'yes', ' true', 'false', '', null, undefined]) {
      expect(isNetworkEnabledValue(value), String(value)).toBe(false)
    }
  })
})

describe('NN-3 isValidNetworkPort', () => {
  it('NN-3 1024–65535 的整数', () => {
    for (const port of [1024, 7766, 65535]) expect(isValidNetworkPort(port)).toBe(true)
    for (const port of [1023, 65536, 0, -1, 7766.5, NaN, Infinity, '7766', null, undefined]) {
      expect(isValidNetworkPort(port), String(port)).toBe(false)
    }
  })
})

describe('NN-4 parseNetworkPort', () => {
  it('NN-4 十进制整数串 → 数', () => {
    expect(parseNetworkPort('8080')).toBe(8080)
    expect(parseNetworkPort(' 8080 ')).toBe(8080)
    expect(parseNetworkPort('08080')).toBe(8080)
  })

  it('NN-4 不合法 / 缺失 → 7766', () => {
    for (const value of [
      '80',
      '70000',
      '8080.5',
      '0x1f90',
      '1e4',
      '-8080',
      '8080abc',
      '',
      null,
      undefined
    ]) {
      expect(parseNetworkPort(value), String(value)).toBe(7766)
    }
  })
})

describe('NN-5 只开放给一个网络的常量', () => {
  it('NN-5 键名与错误码', () => {
    expect(NETWORK_LAN_INTERFACE_KEY).toBe('network.lanInterface')
    expect(NETWORK_ERROR_NO_INTERFACE).toBe('ENOINTERFACE')
  })
})

describe('NN-6 isValidLanInterfaceSpec', () => {
  it('NN-6 网卡名与 IP 字面量为真', () => {
    for (const spec of [
      'eth1',
      'en0',
      'br-1a2b',
      'eth0.100',
      'wlan_0',
      '192.168.50.10',
      'fd00::10',
      '::1',
      'a'.repeat(64)
    ]) {
      expect(isValidLanInterfaceSpec(spec), spec).toBe(true)
    }
  })

  it('NN-6 空、超长、`-` 开头、空白、元字符、`%`、非 ASCII、非字符串为假', () => {
    for (const spec of [
      '',
      'a'.repeat(65),
      '-eth1',
      '--lan',
      'eth 1',
      ' eth1',
      'eth1\n',
      'a;b',
      '$(id)',
      'a`b',
      'a/b',
      'a"b',
      "a'b",
      'a|b',
      'fe80::1%eth0',
      'ethé',
      'eth１',
      null,
      undefined,
      1,
      {}
    ]) {
      expect(isValidLanInterfaceSpec(spec), JSON.stringify(spec) ?? String(spec)).toBe(false)
    }
  })
})

describe('NN-7 parseLanInterfaceValue', () => {
  it('NN-7 去首尾空白', () => {
    expect(parseLanInterfaceValue('eth1')).toBe('eth1')
    expect(parseLanInterfaceValue('  eth1  ')).toBe('eth1')
  })

  it('NN-7 空 / 空白 / 缺失 → undefined（所有网络）', () => {
    for (const value of ['', '   ', null, undefined]) {
      expect(parseLanInterfaceValue(value), String(value)).toBeUndefined()
    }
  })

  it('NN-7 不合法的值原样返回（不退回到所有网络）', () => {
    expect(parseLanInterfaceValue('a b')).toBe('a b')
    expect(parseLanInterfaceValue('a;b')).toBe('a;b')
  })
})
