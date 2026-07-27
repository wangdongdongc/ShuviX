import { describe, it, expect } from 'vitest'
import { BROWSER_OPS, BROWSER_ACTIONS, opsForCaps } from '../ops'
import type { BrowserCaps } from '../backend'

const ALL_CAPS: BrowserCaps = {
  pdf: true,
  fullPageScreenshot: true,
  elementScreenshot: true,
  screenshotToFile: true,
  evaluate: true,
  network: true,
  console: true,
  rawCdp: true
}

const EXTENSION_CAPS: BrowserCaps = {
  pdf: false,
  fullPageScreenshot: false,
  elementScreenshot: false,
  screenshotToFile: false,
  evaluate: true,
  network: true,
  console: true,
  rawCdp: true
}

describe('BROWSER_OPS', () => {
  it('目录覆盖全部 action 且一一对应', () => {
    expect(BROWSER_OPS.map((op) => op.name).sort()).toEqual([...BROWSER_ACTIONS].sort())
  })

  it('全 caps 下不过滤', () => {
    expect(opsForCaps(ALL_CAPS)).toHaveLength(BROWSER_OPS.length)
  })

  it('扩展 caps 下剔除 pdf，保留 evaluate/network/console', () => {
    const names = opsForCaps(EXTENSION_CAPS).map((op) => op.name)
    expect(names).not.toContain('pdf')
    expect(names).toContain('evaluate')
    expect(names).toContain('network')
    expect(names).toContain('console')
  })

  it('每个 op 都有非空 usage 与 description', () => {
    for (const op of BROWSER_OPS) {
      expect(op.usage.length).toBeGreaterThan(0)
      expect(op.description.length).toBeGreaterThan(0)
    }
  })
})
