/**
 * 单行摘要截断（utils/clipLine.ts）：
 *   CL-1 不超长原样；超长切到 max-3 补 `...`
 *   CL-2 切口落在自动脱敏的占位符中间 → 退到占位符之前；切口正好在占位符之后 → 照常
 */
import { describe, expect, it } from 'vitest'
import { clipLine } from './clipLine'

const KEY = '{{API_KEY_k3v7x2mq}}'

describe('clipLine', () => {
  it('CL-1 照常截断', () => {
    expect(clipLine('short', 10)).toBe('short')
    expect(clipLine('0123456789abc', 10)).toBe('0123456...')
  })

  it('CL-2 不把占位符切成两半', () => {
    const text = `curl -H ${KEY} https://api`
    expect(clipLine(text, 20)).toBe('curl -H ...')
    const exact = `ab ${KEY}`
    expect(clipLine(`${exact} and more`, exact.length + 3)).toBe(`${exact}...`)
  })
})
