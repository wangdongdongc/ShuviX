import { describe, it, expect } from 'vitest'
import {
  truncateLine,
  MAX_LINE_LENGTH,
  truncateHead,
  truncateTail,
  formatSize
} from '../utils/truncate'

describe('truncateLine', () => {
  it('短行不截断', () => {
    const line = 'a'.repeat(100)
    expect(truncateLine(line)).toBe(line)
  })

  it('刚好 MAX_LINE_LENGTH 字符不截断', () => {
    const line = 'x'.repeat(MAX_LINE_LENGTH)
    expect(truncateLine(line)).toBe(line)
    expect(truncateLine(line).length).toBe(MAX_LINE_LENGTH)
  })

  it('超长行截断到 MAX_LINE_LENGTH + 后缀', () => {
    const line = 'a'.repeat(3000)
    const result = truncateLine(line)
    expect(result.startsWith('a'.repeat(MAX_LINE_LENGTH))).toBe(true)
    expect(result).toContain('line truncated to')
    expect(result.length).toBeLessThan(line.length)
  })

  it('空字符串不截断', () => {
    expect(truncateLine('')).toBe('')
  })
})

describe('truncateHead', () => {
  it('不超限时原样返回', () => {
    const text = 'line1\nline2\nline3'
    const result = truncateHead(text, 10, 1024)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe(text)
  })

  it('超行数时保留尾部', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`)
    const text = lines.join('\n')
    const result = truncateHead(text, 3, 100000)
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('line8\nline9\nline10')
  })

  it('超字节数时进一步缩减', () => {
    // 每行约 100 字节，总共 10 行 ≈ 1000 字节
    const lines = Array.from({ length: 10 }, (_, i) => `${'x'.repeat(90)}-${i}`)
    const text = lines.join('\n')
    // 限制 300 字节，应该只保留最后几行
    const result = truncateHead(text, 10, 300)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text, 'utf-8')).toBeLessThanOrEqual(300)
  })
})

describe('truncateTail', () => {
  it('不超限时原样返回', () => {
    const text = 'line1\nline2\nline3'
    const result = truncateTail(text, 10, 1024)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe(text)
  })

  it('超行数时保留头部', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`)
    const text = lines.join('\n')
    const result = truncateTail(text, 3, 100000)
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('line1\nline2\nline3')
  })
})

describe('formatSize', () => {
  it('字节', () => expect(formatSize(512)).toBe('512B'))
  it('KB', () => expect(formatSize(2048)).toBe('2.0KB'))
  it('MB', () => expect(formatSize(1048576)).toBe('1.0MB'))
})
