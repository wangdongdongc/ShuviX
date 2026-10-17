/**
 * 内置浏览器网站数据的共用纯函数 `formatBytes`（shared/browserSiteData.ts，2026-10-16）。
 *
 *   SD-U1  1024 进制，B / KB / MB / GB / TB（TB 封顶）；先按一位小数取整再决定写法 —— 整数、以及 ≥ 100 的
 *          不带小数（99.96 KB → '100 KB'、1.04 KB → '1 KB'、1536 → '1.5 KB'）；0 / 负数 / NaN / ±Infinity → '0 B'。
 */
import { describe, expect, it } from 'vitest'
import { formatBytes } from '../browserSiteData'

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
