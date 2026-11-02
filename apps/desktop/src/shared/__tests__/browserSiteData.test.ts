/**
 * 内置浏览器网站数据的共用纯函数 `formatBytes`（shared/browserSiteData.ts，2026-10-16）。
 *
 *   SD-U1  1024 进制，B / KB / MB / GB / TB（TB 封顶）；先按一位小数取整再决定写法 —— 整数、以及 ≥ 100 的
 *          不带小数（99.96 KB → '100 KB'、1.04 KB → '1 KB'、1536 → '1.5 KB'）；0 / 负数 / NaN / ±Infinity → '0 B'。
 *   WCV-1  withoutCookieValues（给别的设备看的详情，2026-11-01）：每个 Cookie 的 value 换成 ''、带上
 *          cookieValuesHidden: true，其余字段一字不差；传进来的详情与其中的 Cookie 对象都不被改；
 *   WCV-2  没有 Cookie → cookies 是 []、照样带标记。
 */
import { describe, expect, it } from 'vitest'
import { formatBytes, withoutCookieValues, type SiteDetails } from '../browserSiteData'

const KiB = 1024
const MiB = KiB * 1024
const GiB = MiB * 1024
const TiB = GiB * 1024

describe('formatBytes（SD-U1）', () => {
  it.each([
    [1, '1 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [10 * KiB, '10 KB'],
    [99.5 * KiB, '99.5 KB'],
    [100 * KiB, '100 KB'],
    [150.4 * KiB, '150 KB'],
    [99.96 * KiB, '100 KB'],
    [1.04 * KiB, '1 KB'],
    [MiB, '1 MB'],
    [1.96 * MiB, '2 MB'],
    [1.25 * GiB, '1.3 GB'],
    [TiB, '1 TB'],
    [2 ** 50, '1024 TB']
  ])('SD-U1 formatBytes(%d) = %j', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text)
  })

  it.each([[0], [-1], [-1024], [NaN], [Infinity], [-Infinity]])(
    'SD-U1 formatBytes(%d) = "0 B"',
    (bytes) => {
      expect(formatBytes(bytes)).toBe('0 B')
    }
  )
})

describe('withoutCookieValues（WCV-1 / WCV-2）', () => {
  const details = (): SiteDetails => ({
    site: 'github.com',
    cookieCount: 2,
    cookieBytes: 30,
    usageBytes: 4096,
    localStorage: true,
    originCount: 1,
    lastAccessed: 1_760_000_000_000,
    origins: [{ origin: 'https://github.com', usageBytes: 4096 } as SiteDetails['origins'][number]],
    cookies: [
      {
        name: 'sid',
        value: 'secret-token',
        domain: '.github.com',
        path: '/',
        secure: true,
        httpOnly: true,
        hostOnly: false,
        sameSite: 'lax',
        expires: 1_800_000_000_000,
        size: 15
      },
      {
        name: 'pref',
        value: 'dark',
        domain: 'github.com',
        path: '/x',
        secure: false,
        httpOnly: false,
        hostOnly: true,
        sameSite: 'unspecified',
        size: 8
      }
    ]
  })

  it('WCV-1 每个值换成空串、带 cookieValuesHidden；其余字段不变；输入与它的 Cookie 对象都不被改', () => {
    const input = details()
    const cookieRefs = [...input.cookies]
    const out = withoutCookieValues(input)
    const expected = details()
    expect(out).toEqual({
      ...expected,
      cookies: expected.cookies.map((c) => ({ ...c, value: '' })),
      cookieValuesHidden: true
    })
    expect(out.cookies.every((c) => c.value === '')).toBe(true)
    // 输入原样
    expect(input).toEqual(details())
    expect(input).not.toHaveProperty('cookieValuesHidden')
    expect(input.cookies).toEqual(cookieRefs)
    input.cookies.forEach((c, i) => expect(c).toBe(cookieRefs[i]))
    expect(cookieRefs[0].value).toBe('secret-token')
    expect(cookieRefs[1].value).toBe('dark')
    // 输出不与输入共用 Cookie 对象
    expect(out.cookies[0]).not.toBe(input.cookies[0])
  })

  it('WCV-2 没有 Cookie → cookies: []，照样带 cookieValuesHidden', () => {
    const out = withoutCookieValues({ ...details(), cookies: [], cookieCount: 0 })
    expect(out.cookies).toEqual([])
    expect(out.cookieValuesHidden).toBe(true)
  })
})
