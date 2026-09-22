import { describe, it, expect } from 'vitest'
import {
  truncateLine,
  MAX_LINE_LENGTH,
  truncateHead,
  truncateTail,
  truncateMiddle,
  formatSize,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES
} from '../truncate'
import { truncateMiddle as runtimeTruncateMiddle } from '@shuvix/agent-runtime'

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

// ─────────────────────────────────────────────────────────────────────────────
// TM —— truncateMiddle：两个上限内原样返回，超限则恰好「头部 + 一行省略标记 + 尾部」。
//
// 这一组钉的是**契约本身**（不是某一次实现的形状）：输出同时守住 `maxLines` 与 `maxBytes`、
// 首尾两端都还在、标记里的数字是真实省略的量、首尾不重叠不重复。行数按 `split('\n')` 数
// （与 processToolOutput 同一套，两边必须一致），字节按 UTF-8 数（不是 `.length`）。
//
// `isWellFormed` 用不了（用例按 `lib: ES2022` 类型检查），所以走 Buffer 往返判良构。
// 特殊字符一律 `String.fromCharCode` / `fromCodePoint` 构造 —— 源码里不留裸码元。
// ─────────────────────────────────────────────────────────────────────────────

/** UTF-8 字节数（TextEncoder 同款：孤立代理项按 U+FFFD 算 3 字节） */
const bytesOf = (s: string): number => Buffer.byteLength(s, 'utf8')

/** 良构文本（无孤立代理项）—— Buffer 往返不变即良构 */
const isWellFormedText = (s: string): boolean => Buffer.from(s, 'utf8').toString('utf8') === s

const LINE_MARKER = /^\.\.\. \[(\d+) lines omitted\] \.\.\.$/
const BYTE_SHAPE = /^([\s\S]*)\n\.\.\. \[(\d+) bytes omitted\] \.\.\.\n([\s\S]*)$/

/** 行模式的解析：恰好一行是标记，标记之前是头部、之后是尾部 */
function parseLineMode(out: string): { head: string[]; tail: string[]; omitted: number } {
  const lines = out.split('\n')
  const markers = lines.filter((l) => LINE_MARKER.test(l))
  expect(markers, '行模式的输出里恰好一行省略标记').toHaveLength(1)
  const idx = lines.findIndex((l) => LINE_MARKER.test(l))
  return {
    head: lines.slice(0, idx),
    tail: lines.slice(idx + 1),
    omitted: Number(LINE_MARKER.exec(lines[idx])![1])
  }
}

/** 字节模式的解析：头部 / 省略字节数 / 尾部 */
function parseByteMode(out: string): { start: string; end: string; omitted: number } {
  const m = BYTE_SHAPE.exec(out)
  expect(m, `字节模式的输出形状：${JSON.stringify(out.slice(0, 80))}`).not.toBeNull()
  return { start: m![1], end: m![3], omitted: Number(m![2]) }
}

/** 每行内容唯一、非空、纯 ASCII —— 标记两侧的空行不会与输入行混淆 */
const uniqueLines = (count: number, pad = 0, fill = 'q'): string[] =>
  Array.from({ length: count }, (_, i) => `L${String(i).padStart(4, '0')}`.padEnd(pad, fill))

describe('truncateMiddle 不超限', () => {
  it('TM-1 空串原样返回', () => {
    const r = truncateMiddle('')
    expect(r.text).toBe('')
    expect(r.truncated).toBe(false)
    expect(r.originalBytes).toBe(0)
    // split('\n') 的约定：空串也是一行
    expect(r.originalLines).toBe(1)
  })

  it('TM-2 多行中文在缺省上限内 → 原样返回，字节数按 UTF-8 数而不是 .length', () => {
    const text = ['第一行中文', '第二行中文', '第三行'].join('\n')
    const r = truncateMiddle(text)
    expect(r.text).toBe(text)
    expect(r.truncated).toBe(false)
    expect(r.originalLines).toBe(text.split('\n').length)
    expect(r.originalBytes).toBe(bytesOf(text))
    expect(r.originalBytes).not.toBe(text.length)
  })

  it('TM-3 行数边界：2000 行不截；2001 行截；2000 行加一个结尾换行按 2001 行算', () => {
    const lines = uniqueLines(DEFAULT_MAX_LINES)
    const text = lines.join('\n')
    expect(truncateMiddle(text).truncated).toBe(false)
    expect(truncateMiddle(`${text}\nLAST`).truncated).toBe(true)
    // processToolOutput 数的也是 split('\n').length —— 两边必须给同一个答案
    const trailing = `${text}\n`
    expect(trailing.split('\n').length).toBe(DEFAULT_MAX_LINES + 1)
    expect(truncateMiddle(trailing).truncated).toBe(true)
  })

  it('TM-4 字节边界：51200 不截、51201 截；中文按 UTF-8 三字节算', () => {
    expect(truncateMiddle('a'.repeat(DEFAULT_MAX_BYTES)).truncated).toBe(false)
    expect(truncateMiddle('a'.repeat(DEFAULT_MAX_BYTES + 1)).truncated).toBe(true)
    // 17066 个「中」= 51198 字节 < 51200，而 .length 只有 17066
    expect(truncateMiddle('中'.repeat(17066)).truncated).toBe(false)
    // 20000 个「中」= 60000 字节 > 51200，.length 却只有 20000 —— 按字符数就漏了
    const cjk = '中'.repeat(20000)
    expect(cjk.length).toBeLessThan(DEFAULT_MAX_BYTES)
    expect(truncateMiddle(cjk).truncated).toBe(true)
  })
})

describe('truncateMiddle 行模式（行数超限、字节没超）', () => {
  it('TM-5 3000 短行：一个标记、头尾两段不重叠、首末行都在、不超字节上限', () => {
    const lines = uniqueLines(3000)
    const r = truncateMiddle(lines.join('\n'))
    const { head, tail, omitted } = parseLineMode(r.text)

    expect(head.length).toBeGreaterThanOrEqual(1)
    expect(tail.length).toBeGreaterThanOrEqual(1)
    expect(head).toEqual(lines.slice(0, head.length))
    expect(tail).toEqual(lines.slice(lines.length - tail.length))
    // 不重叠：头部取的行号严格小于尾部取的行号
    expect(head.length).toBeLessThan(lines.length - tail.length)
    expect(omitted).toBe(3000 - head.length - tail.length)
    expect(omitted).toBeGreaterThanOrEqual(1)
    expect(head[0]).toBe(lines[0])
    expect(tail[tail.length - 1]).toBe(lines[2999])
    expect(bytesOf(r.text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
  })

  it('TM-6 输出行数不超过 maxLines —— 标记自己也占一行', () => {
    expect(
      truncateMiddle(uniqueLines(3000).join('\n')).text.split('\n').length
    ).toBeLessThanOrEqual(DEFAULT_MAX_LINES)
    // 小号：上限小的时候标记那一行占的比例更大，更容易溢出
    const small = truncateMiddle(uniqueLines(20).join('\n'), 10)
    expect(small.text.split('\n').length).toBeLessThanOrEqual(10)
  })

  it('TM-7 没有字节压力时头部占 headRatio', () => {
    const { head, tail } = parseLineMode(truncateMiddle(uniqueLines(3000).join('\n')).text)
    expect(Math.abs(head.length - 0.3 * (head.length + tail.length))).toBeLessThanOrEqual(1)

    const half = parseLineMode(truncateMiddle(uniqueLines(100).join('\n'), 20, 51200, 0.5).text)
    expect(Math.abs(half.head.length - half.tail.length)).toBeLessThanOrEqual(1)
  })

  it('TM-8 maxLines 3 → 恰好「首行 + 标记 + 末行」', () => {
    expect(truncateMiddle('a\nb\nc\nd\ne', 3).text).toBe('a\n... [3 lines omitted] ...\ne')
  })
})

describe('truncateMiddle 行模式（字节超限、行数没超）', () => {
  it('TM-9 10 行 × 100 字节、maxBytes 500：不超预算、无重复行、省略数为真', () => {
    const lines = uniqueLines(10, 100)
    const r = truncateMiddle(lines.join('\n'), 2000, 500)
    const { head, tail, omitted } = parseLineMode(r.text)

    expect(bytesOf(r.text)).toBeLessThanOrEqual(500)
    const kept = [...head, ...tail]
    expect(new Set(kept).size, '保留的行互不相同').toBe(kept.length)
    expect(omitted).toBe(10 - kept.length)
    expect(omitted).toBeGreaterThanOrEqual(1)
  })

  it('TM-10 50 行 × 1KB（约 51.2KB）：不超预算、首末行都在、省略数为真', () => {
    const lines = uniqueLines(50, 1024, 'm')
    const r = truncateMiddle(lines.join('\n'))
    const { head, tail, omitted } = parseLineMode(r.text)

    expect(bytesOf(r.text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
    expect(head[0]).toBe(lines[0])
    expect(tail[tail.length - 1]).toBe(lines[49])
    expect(omitted).toBe(50 - head.length - tail.length)
  })

  it('TM-11 大块在尾部：首行放得下就不能丢', () => {
    const lines = [
      'FIRST',
      ...Array.from({ length: 6 }, (_, i) => `l${i + 2}`),
      'X'.repeat(400),
      'Y'.repeat(400),
      'Z'.repeat(400)
    ]
    const r = truncateMiddle(lines.join('\n'), 2000, 1000)
    // FIRST + 标记 + Y + Z 约 830 字节，放得下 —— 丢掉首行没有道理
    expect(r.text.startsWith('FIRST\n')).toBe(true)
    expect(r.text.endsWith('Z'.repeat(400))).toBe(true)
    expect(bytesOf(r.text)).toBeLessThanOrEqual(1000)
  })

  it('TM-12 大块在中间：首末行都留，省略数为真', () => {
    const r = truncateMiddle(`first\n${'x'.repeat(200)}\nlast`, 2000, 100)
    expect(r.text.startsWith('first')).toBe(true)
    expect(r.text.endsWith('last')).toBe(true)
    expect(bytesOf(r.text)).toBeLessThanOrEqual(100)

    // 哪种标记都行，但里面的数字必须是真省略掉的量
    const m = BYTE_SHAPE.exec(r.text)
    if (m) {
      expect(bytesOf(m[1]) + Number(m[2]) + bytesOf(m[3])).toBe(r.originalBytes)
    } else {
      const { head, tail, omitted } = parseLineMode(r.text)
      expect(omitted).toBe(3 - head.length - tail.length)
    }
  })

  it('TM-13 中间一整行超过 maxBytes：首末行都留，省略数为真', () => {
    const lines = [
      ...Array.from({ length: 10 }, (_, i) => `h${i}`),
      'M'.repeat(1000),
      ...Array.from({ length: 10 }, (_, i) => `t${i}`)
    ]
    const r = truncateMiddle(lines.join('\n'), 2000, 500)
    const { head, tail, omitted } = parseLineMode(r.text)

    expect(head[0]).toBe('h0')
    expect(tail[tail.length - 1]).toBe('t9')
    expect(bytesOf(r.text)).toBeLessThanOrEqual(500)
    expect(omitted).toBe(lines.length - head.length - tail.length)
  })
})

describe('truncateMiddle 字节模式（单行本身超过 maxBytes）', () => {
  it('TM-14 一行 200 字节、maxBytes 100：前缀 + 字节标记 + 后缀，数字对得上', () => {
    const text = 'a'.repeat(200)
    const r = truncateMiddle(text, 2000, 100)
    const { start, end, omitted } = parseByteMode(r.text)

    expect(start.length).toBeGreaterThan(0)
    expect(end.length).toBeGreaterThan(0)
    expect(text.startsWith(start)).toBe(true)
    expect(text.endsWith(end)).toBe(true)
    expect(bytesOf(start) + omitted + bytesOf(end)).toBe(200)
    expect(bytesOf(r.text)).toBeLessThanOrEqual(100)
    expect(r.truncated).toBe(true)
    expect(r.originalLines).toBe(1)
    expect(r.originalBytes).toBe(200)
  })

  it('TM-15 单行扫描（中文 / emoji / 混排 × maxBytes 40..400）：良构、前后缀、数字精确、不超预算', () => {
    const emoji = String.fromCodePoint(0x1f600)
    const eAcute = String.fromCharCode(0xe9)
    const samples: [string, string][] = [
      ['中文', '中'.repeat(1000)],
      ['emoji', emoji.repeat(1000)],
      ['混排', `a${eAcute}中${emoji}`.repeat(500)]
    ]

    for (const [name, text] of samples) {
      for (let maxBytes = 40; maxBytes <= 400; maxBytes++) {
        const where = `${name} maxBytes=${maxBytes}`
        const r = truncateMiddle(text, 2000, maxBytes)
        expect(isWellFormedText(r.text), `${where} 没有劈开字符`).toBe(true)
        expect(bytesOf(r.text), `${where} 不超预算`).toBeLessThanOrEqual(maxBytes)

        const m = BYTE_SHAPE.exec(r.text)
        if (!m) {
          // 预算小到放不下标记加两侧内容 → 只留开头、不带标记
          expect(text.startsWith(r.text), `${where} 退化成开头前缀`).toBe(true)
          expect(maxBytes, `${where} 只在极小预算下退化`).toBeLessThan(64)
          continue
        }
        const [, start, n, end] = m
        expect(text.startsWith(start), `${where} 开头是原文前缀`).toBe(true)
        expect(text.endsWith(end), `${where} 结尾是原文后缀`).toBe(true)
        expect(start.includes('\n') || end.includes('\n'), `${where} 行内截断不含换行`).toBe(false)
        expect(bytesOf(start) + Number(n) + bytesOf(end), `${where} 省略字节数精确`).toBe(
          r.originalBytes
        )
        if (maxBytes >= 64) {
          expect(start.length, `${where} 开头非空`).toBeGreaterThan(0)
          expect(end.length, `${where} 结尾非空`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('TM-16 截点上是孤立代理项：按 TextEncoder 的算法（3 字节）数，数字仍然精确', () => {
    const lone = String.fromCharCode(0xd83d)
    const text = `${'a'.repeat(18)}${lone}${'b'.repeat(200)}`
    const r = truncateMiddle(text, 2000, 101)
    const { start, end, omitted } = parseByteMode(r.text)

    expect(bytesOf(start) + omitted + bytesOf(end)).toBe(r.originalBytes)
    expect(r.originalBytes).toBe(bytesOf(text))
    expect(bytesOf(r.text)).toBeLessThanOrEqual(101)
  })

  it('TM-17 末行巨大：开头从首行起，结尾是那一行的尾巴', () => {
    const text = ['s0', 's1', 's2', 'H'.repeat(1000)].join('\n')
    const r = truncateMiddle(text, 2000, 200)
    const { start, end, omitted } = parseByteMode(r.text)

    expect(start.startsWith('s0')).toBe(true)
    expect(end.length).toBeGreaterThan(0)
    expect(end).toBe('H'.repeat(end.length))
    expect(bytesOf(start) + omitted + bytesOf(end)).toBe(r.originalBytes)
    expect(bytesOf(r.text)).toBeLessThanOrEqual(200)
  })

  it('TM-18 首行巨大：开头是那一行的前缀（不是整段被丢掉），结尾仍是末行', () => {
    const tails = Array.from({ length: 10 }, (_, i) => `tail${i}`)
    const text = `${'z'.repeat(200)}\n${tails.join('\n')}`
    const r = truncateMiddle(text, 2000, 150)
    const { start, end, omitted } = parseByteMode(r.text)

    expect(start.length).toBeGreaterThan(0)
    expect(start).toBe('z'.repeat(start.length))
    expect(end.endsWith('tail9')).toBe(true)
    expect(bytesOf(start) + omitted + bytesOf(end)).toBe(r.originalBytes)
    expect(bytesOf(r.text)).toBeLessThanOrEqual(150)
  })

  it('TM-19 字节模式也守 maxLines —— 留下的开头本身可能有几千行', () => {
    const r = truncateMiddle(`${'a\n'.repeat(3000)}${'x'.repeat(60000)}`)
    expect(r.text.split('\n').length).toBeLessThanOrEqual(DEFAULT_MAX_LINES)
    expect(bytesOf(r.text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
  })
})

describe('truncateMiddle 退化上限', () => {
  it('TM-25 maxLines < 3 → 只留开头的 maxLines 行，不带标记', () => {
    // 放不下「一侧 + 标记 + 另一侧」时不硬塞：以前这里会把原文写两遍、标记里还是负数
    expect(truncateMiddle('abc', 0, 1000).text).toBe('')
    expect(truncateMiddle('a\nb\nc\nd\ne', 1, 1000).text).toBe('a')
    expect(truncateMiddle('a\nb\nc\nd\ne', 2, 1000).text).toBe('a\nb')
    expect(truncateMiddle('abc', 0, 1000).truncated).toBe(true)
  })

  it('TM-26 字节预算放不下两侧各 8 字节 → 只留开头，仍守住 maxBytes', () => {
    const text = 'abcdefghijklmnop'
    const r = truncateMiddle(text, 2000, 10)
    expect(bytesOf(r.text)).toBeLessThanOrEqual(10)
    expect(text.startsWith(r.text)).toBe(true)
    expect(r.text).not.toContain('omitted')
  })

  it('TM-27 headRatio 钳到 [0,1]：0 仍留首行、1 仍留末行', () => {
    const lines = uniqueLines(100)
    const zero = parseLineMode(truncateMiddle(lines.join('\n'), 20, 51200, 0).text)
    expect(zero.head[0], 'headRatio 0 也要留住首行').toBe(lines[0])
    expect(zero.tail[zero.tail.length - 1]).toBe(lines[99])

    const one = parseLineMode(truncateMiddle(lines.join('\n'), 20, 51200, 1).text)
    expect(one.head[0]).toBe(lines[0])
    expect(one.tail[one.tail.length - 1], 'headRatio 1 也要留住末行').toBe(lines[99])

    // 超出 [0,1] 的取值按钳后的算，不会崩、也不会丢边界行
    for (const ratio of [-5, 42]) {
      const r = truncateMiddle(lines.join('\n'), 20, 51200, ratio)
      expect(r.text.split('\n').length).toBeLessThanOrEqual(20)
      expect(r.text.startsWith(lines[0])).toBe(true)
      expect(r.text.endsWith(lines[99])).toBe(true)
    }
  })
})

describe('truncateMiddle 结果字段', () => {
  it('TM-23 originalLines / originalBytes 描述的是输入，不是输出', () => {
    const lineMode = truncateMiddle(uniqueLines(3000).join('\n'))
    expect(lineMode.originalLines).toBe(3000)
    expect(lineMode.originalBytes).toBe(bytesOf(uniqueLines(3000).join('\n')))
    expect(lineMode.text.split('\n').length).toBeLessThan(lineMode.originalLines)

    const byteText = ['q0', 'q1', 'H'.repeat(5000)].join('\n')
    const byteMode = truncateMiddle(byteText, 2000, 200)
    expect(byteMode.originalLines).toBe(3)
    expect(byteMode.originalBytes).toBe(bytesOf(byteText))
    expect(bytesOf(byteMode.text)).toBeLessThan(byteMode.originalBytes)
  })

  it('TM-24 桌面侧的再导出就是 @shuvix/agent-runtime 的那一个函数', () => {
    expect(truncateMiddle).toBe(runtimeTruncateMiddle)
  })
})

describe('truncateMiddle 性能（主进程同步跑，不能是平方级）', () => {
  /** 预热一次，再计时 —— 首次调用带着 JIT 与模块初始化的账 */
  const timed = (text: string): { ms: number; bytes: number; lines: number } => {
    truncateMiddle('warmup\nwarmup')
    const started = performance.now()
    const r = truncateMiddle(text)
    return {
      ms: performance.now() - started,
      bytes: bytesOf(r.text),
      lines: r.text.split('\n').length
    }
  }

  it('TM-20 单行 5MB（ASCII / 中文 / emoji）各 < 500ms', () => {
    const cases: [string, string][] = [
      ['ASCII', 'a'.repeat(5_000_000)],
      ['中文', '中'.repeat(1_700_000)],
      ['emoji', String.fromCodePoint(0x1f600).repeat(1_250_000)]
    ]
    for (const [name, text] of cases) {
      const { ms, bytes } = timed(text)
      expect(bytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
      expect(ms, `${name} 单行 5MB 用时 ${ms.toFixed(0)}ms`).toBeLessThan(500)
    }
  }, 30_000)

  it('TM-21 2000 短行之后跟一个 5MB 的巨行 < 2s', () => {
    const text = `${uniqueLines(2000).join('\n')}\n${'a'.repeat(5_000_000)}`
    const { ms, bytes, lines } = timed(text)
    expect(bytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
    expect(lines).toBeLessThanOrEqual(DEFAULT_MAX_LINES)
    expect(ms, `用时 ${ms.toFixed(0)}ms`).toBeLessThan(2000)
  }, 30_000)

  it('TM-22 2000 行 × 1KB < 1s', () => {
    const { ms, bytes } = timed(uniqueLines(2000, 1024, 'z').join('\n'))
    expect(bytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
    expect(ms, `用时 ${ms.toFixed(0)}ms`).toBeLessThan(1000)
  }, 30_000)
})
