/**
 * capDiffString 封顶单测 —— diff 既进询问请求（IPC）又落 JSONL，必须一次算成、一次封顶。
 *
 * 覆盖三条截断路径：未超限原样返回、行数超限（保留前 1200 行）、字符超限
 * （优先退到最后一个完整行；首行自身就超限时只能腰斩）。腰斩优先报告：
 * 一旦发生腰斩，标记必须以 "line too long" 打头，同时丢了行才追加 ", N more lines"。
 */

import { describe, it, expect } from 'vitest'
import { capDiffString } from '../editDiff'

/** 与实现内的私有常量对齐 —— 改动实现时这里必须同步（故意重复声明，作为契约锚点） */
const DIFF_MAX_LINES = 1200
const DIFF_MAX_CHARS = 256 * 1024

/**
 * 解析尾部截断标记。无标记返回 null；否则拆成「是否腰斩」与「丢了几行」两维，
 * 避免用子串匹配把 "line too long, N more lines" 误读成纯行数截断。
 */
function marker(diff: string): { lineTooLong: boolean; omitted: number | null } | null {
  const lines = diff.split('\n')
  const m = /^\[diff truncated — (.+)\]$/.exec(lines[lines.length - 1])
  if (!m) return null
  const more = /(?:^|, )(\d+) more lines$/.exec(m[1])
  return { lineTooLong: m[1].startsWith('line too long'), omitted: more ? Number(more[1]) : null }
}

/** 去掉尾部截断标记后的正文行 */
function bodyLines(diff: string): string[] {
  const lines = diff.split('\n')
  if (/^\[diff truncated — /.test(lines[lines.length - 1])) lines.pop()
  return lines
}

describe('capDiffString', () => {
  it('CAP-1: returns short diffs verbatim — no marker, trailing newline untouched', () => {
    const plain = '+1 added\n-2 removed\n 3 context'
    expect(capDiffString(plain)).toBe(plain)

    const trailingNewline = '+1 a\n+2 b\n'
    expect(capDiffString(trailingNewline)).toBe(trailingNewline)

    // 恰好等于行数上限：仍原样返回
    const exactlyAtLimit = Array.from({ length: DIFF_MAX_LINES }, (_, i) => `+${i} x`).join('\n')
    expect(capDiffString(exactlyAtLimit)).toBe(exactlyAtLimit)
    expect(marker(capDiffString(exactlyAtLimit))).toBeNull()
  })

  it('CAP-2: line cap keeps the first 1200 lines and reports the exact remainder', () => {
    const total = 1500
    const raw = Array.from({ length: total }, (_, i) => `+${i} line`).join('\n')
    // 前提：只触发行数上限，字符数没超
    expect(raw.length).toBeLessThan(DIFF_MAX_CHARS)

    const out = capDiffString(raw)
    const body = bodyLines(out)
    expect(body).toHaveLength(DIFF_MAX_LINES)
    expect(body[0]).toBe('+0 line')
    expect(body[DIFF_MAX_LINES - 1]).toBe(`+${DIFF_MAX_LINES - 1} line`)
    expect(marker(out)).toEqual({ lineTooLong: false, omitted: total - DIFF_MAX_LINES })
    expect(out.split('\n')).toHaveLength(DIFF_MAX_LINES + 1)
  })

  it('CAP-3: char cap falls back to the last complete line — no half line, N matches what was dropped', () => {
    const total = 1000
    const lineBody = 'x'.repeat(500)
    const raw = Array.from({ length: total }, () => lineBody).join('\n')
    // 前提：行数没超，只触发字符上限
    expect(raw.split('\n')).toHaveLength(total)
    expect(total).toBeLessThanOrEqual(DIFF_MAX_LINES)
    expect(raw.length).toBeGreaterThan(DIFF_MAX_CHARS)

    const out = capDiffString(raw)
    const body = bodyLines(out)
    // 每一行都是完整的 500 字符 —— 没有被腰斩的半行
    expect(body.every((l) => l.length === lineBody.length)).toBe(true)
    // 没有腰斩 → 标记只报行数
    expect(marker(out)).toEqual({ lineTooLong: false, omitted: total - body.length })
    // 正文确实被字符上限砍过（含标记的总长不会离上限太远）
    expect(body.join('\n').length).toBeLessThanOrEqual(DIFF_MAX_CHARS)
  })

  it('CAP-4: a single line over the char cap is cut mid-line and marked "line too long"', () => {
    const raw = 'x'.repeat(DIFF_MAX_CHARS + 10_000)
    const out = capDiffString(raw)

    expect(out.endsWith('\n[diff truncated — line too long]')).toBe(true)
    expect(marker(out)).toEqual({ lineTooLong: true, omitted: null })
    const body = bodyLines(out)
    expect(body).toHaveLength(1)
    expect(body[0]).toHaveLength(DIFF_MAX_CHARS)
    expect(raw.startsWith(body[0])).toBe(true)
  })

  it('CAP-5: an oversized first line followed by more lines reports the mid-line cut first', () => {
    const first = 'x'.repeat(DIFF_MAX_CHARS + 10_000)
    const raw = `${first}\nsecond\nthird`
    const out = capDiffString(raw)

    // 腰斩优先：只报 "2 more lines" 会让人以为留下的行都是完整的，而首行恰恰被砍了一半
    expect(out.endsWith('\n[diff truncated — line too long, 2 more lines]')).toBe(true)
    expect(marker(out)).toEqual({ lineTooLong: true, omitted: 2 })
    const body = bodyLines(out)
    expect(body).toHaveLength(1)
    expect(body[0]).toHaveLength(DIFF_MAX_CHARS)
    expect(first.startsWith(body[0])).toBe(true)
  })

  it('CAP-5: 行数与字符双双超限且首行超长时同样是腰斩优先', () => {
    const first = 'x'.repeat(DIFF_MAX_CHARS + 10_000)
    const total = DIFF_MAX_LINES + 300
    const raw = [first, ...Array.from({ length: total - 1 }, (_, i) => `line ${i}`)].join('\n')

    const out = capDiffString(raw)

    // 先按行数砍到 1200 行，再因首行超限腰斩 → 只剩首行的前半段，其余 1199 行一并丢失
    expect(marker(out)).toEqual({ lineTooLong: true, omitted: total - 1 })
    expect(bodyLines(out)).toHaveLength(1)
  })
})
