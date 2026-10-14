/**
 * `shared/network.ts` —— 网络访问的两个设置键与端口的取值规则（server mode phase B §B1）：缺省关，只有字面量 `'true'` 开；
 * 端口缺省 7766、必须是 1024–65535 的整数，读到不合法的值一律按缺省。
 *
 *   NN-1 键名 `network.enabled` / `network.port`；缺省 7766、下限 1024、上限 65535
 *   NN-2 isNetworkEnabledValue：只有 `'true'` 为真（大小写、'1'、'yes'、带空白、空、null、undefined 都是假）
 *   NN-3 isValidNetworkPort：1024 / 7766 / 65535 真；越界、小数、NaN、Infinity、字符串、null、undefined 假
 *   NN-4 parseNetworkPort：十进制整数串（可带首尾空白、前导零）→ 数；越界、小数、十六进制、科学计数、负数、
 *        带尾巴、空、null、undefined → 7766
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NETWORK_PORT,
  isNetworkEnabledValue,
  isValidNetworkPort,
  MAX_NETWORK_PORT,
  MIN_NETWORK_PORT,
  NETWORK_ENABLED_KEY,
  NETWORK_PORT_KEY,
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
