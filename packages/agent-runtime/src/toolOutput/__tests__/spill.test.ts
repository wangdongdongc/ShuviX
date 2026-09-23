/**
 * SPL —— 共享的「工具输出后处理」内核：未超限原样通过；超限时**有落盘口就落盘**、回预览 +
 * 「用 read 取全文」的指路，**没有口（或落盘失败）就只在内存里截断**。
 *
 * 落盘介质由宿主注入（桌面写 tool_results），所以这一组不碰文件系统：sink 全是手写的假对象。
 * 钉的是两条分界：
 *  - **有没有指路**。没有 sink 时，结果里不能出现「Full output saved」/「Read tool」/「IMPORTANT」——
 *    那句指引对一个取不回全文的 agent 就是死路（Chrome 标签页会话的 `tab` 档案正是这种）。
 *  - **截到多少**。没落盘时按调用方给的上限截（它拿到的就只有这些）；落盘成功时正文在盘上，
 *    正文里只留 200 行 / 10KB 的预览，且这个预览还要受调用方上限的**再一次**收紧。
 *
 * 正文一律与 truncateMiddle / truncateKeepStart / truncateKeepEnd 的**返回值**对照，不写死形状 ——
 * 截断算法自己的契约在 apps/desktop/src/shared/node/__tests__/truncate.test.ts 里钉。
 */
import { describe, it, expect, vi } from 'vitest'
import { processToolOutput, type SpillSink, type TruncateStrategy } from '../spill'
import {
  truncateMiddle,
  truncateKeepStart,
  truncateKeepEnd,
  formatSize,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES
} from '../../fileTools/truncate'

const byteLen = (s: string): number => new TextEncoder().encode(s).length

/** 3000 行、每行内容唯一 —— 缺省上限下必然超行数 */
const BIG = Array.from({ length: 3000 }, (_, i) => `L${String(i).padStart(4, '0')}`).join('\n')
const SMALL = 'one\ntwo\nthree'

const header = (full: string): string =>
  `[Output truncated: ${full.split('\n').length} lines / ${formatSize(byteLen(full))}]`

/** 落盘成功的假 sink（记下它收到的参数） */
function okSink(locator = '/tmp/tool_results/s/tc.txt'): {
  sink: SpillSink
  write: ReturnType<typeof vi.fn>
} {
  const write = vi.fn(async () => ({ locator }))
  return { sink: { write } as unknown as SpillSink, write }
}

/** 没有指路的三句话：一句都不能出现在纯内存截断的结果里 */
function expectNoPointer(text: string): void {
  expect(text).not.toContain('Full output saved')
  expect(text).not.toMatch(/Read tool/i)
  expect(text).not.toContain('IMPORTANT')
}

const run = (
  opts: Partial<Parameters<typeof processToolOutput>[0]> & { fullText: string }
): ReturnType<typeof processToolOutput> =>
  processToolOutput({ toolCallId: 'tc-1', strategy: 'middle', ...opts })

describe('SPL 没有落盘口', () => {
  it('SPL-1 超限 + 无 sink → 只截断：表头 + 空行 + truncateMiddle 的正文，一句指路都没有', async () => {
    const r = await run({ fullText: BIG })

    expect(r.truncated).toBe(true)
    expect(r.persisted).toBe(false)
    expect(r.text).toBe(
      `${header(BIG)}\n\n${truncateMiddle(BIG, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES).text}`
    )
    expectNoPointer(r.text)
  })

  it('SPL-3 sink 返回 null / sink 抛异常 → 与「根本没有 sink」逐字相同', async () => {
    const baseline = await run({ fullText: BIG })

    const nullSink = { write: vi.fn(async () => null) } as unknown as SpillSink
    const nulled = await run({ fullText: BIG, sink: nullSink })
    expect(nulled.text).toBe(baseline.text)
    expect(nulled.persisted).toBe(false)
    expect(nulled.truncated).toBe(true)

    const throwing = {
      write: vi.fn(async () => {
        throw new Error('disk full')
      })
    } as unknown as SpillSink
    const threw = await run({ fullText: BIG, sink: throwing })
    expect(threw.text).toBe(baseline.text)
    expect(threw.persisted).toBe(false)
    expect(threw.truncated).toBe(true)
  })

  it('SPL-6 strategy keep-start / keep-end 决定留哪一段 —— 与函数本身对照，不照抄注释', async () => {
    const start = await run({ fullText: BIG, strategy: 'keep-start' })
    expect(start.text).toBe(
      `${header(BIG)}\n\n${truncateKeepStart(BIG, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES).text}`
    )

    const end = await run({ fullText: BIG, strategy: 'keep-end' })
    expect(end.text).toBe(
      `${header(BIG)}\n\n${truncateKeepEnd(BIG, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES).text}`
    )
    expect(end.text).not.toBe(start.text)
  })
})

describe('SPL 落盘成功', () => {
  it('SPL-2 全文交给 sink 一次、正文换成 200 行 / 10KB 的预览 + 指路', async () => {
    const { sink, write } = okSink('/tmp/tool_results/sess/tc-1.txt')
    const r = await run({ fullText: BIG, sink })

    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('tc-1', BIG)
    expect(r.truncated).toBe(true)
    expect(r.persisted).toBe(true)

    const preview = truncateMiddle(BIG, 200, 10 * 1024)
    expect(preview.truncated, '3000 行必然还要再截一次').toBe(true)
    expect(r.text).toBe(
      `${header(BIG)}\n` +
        `[Full output saved to: /tmp/tool_results/sess/tc-1.txt]\n` +
        `[IMPORTANT: Use the Read tool (not bash) to view the full output]\n\n` +
        `${preview.text}\n...`
    )
  })
})

describe('SPL 未超限', () => {
  it('SPL-4 两个上限内 → sink 一次都不碰，文本原样', async () => {
    const { sink, write } = okSink()
    const r = await run({ fullText: SMALL, sink })

    expect(write).not.toHaveBeenCalled()
    expect(r.text).toBe(SMALL)
    expect(r.truncated).toBe(false)
    expect(r.persisted).toBe(false)
    expect(r.originalLines).toBe(3)
    expect(r.originalBytes).toBe(byteLen(SMALL))
  })
})

describe('SPL 调用方给的上限', () => {
  it('SPL-5a 无 sink：调用方的上限同时决定「算不算超限」与「截到多少」', async () => {
    const text = Array.from({ length: 20 }, (_, i) => `n${i}`).join('\n')
    // 缺省上限下它根本不算超限
    expect((await run({ fullText: text })).truncated).toBe(false)

    const r = await run({ fullText: text, maxLines: 10 })
    expect(r.truncated).toBe(true)
    expect(r.text).toBe(`${header(text)}\n\n${truncateMiddle(text, 10, DEFAULT_MAX_BYTES).text}`)
    expect(r.text.split('\n').length).toBeLessThanOrEqual(10 + 2)
  })

  it('SPL-5b 有 sink：预览按 min(200, maxLines) / min(10240, maxBytes) 再收一次', async () => {
    const { sink } = okSink('/p/a.txt')

    // 比预览上限更紧 → 以调用方的为准
    const tight = await run({ fullText: BIG, sink, maxLines: 50, maxBytes: 4096 })
    const tightPreview = truncateMiddle(BIG, 50, 4096)
    expect(tight.text.endsWith(`${tightPreview.text}\n...`)).toBe(true)
    expect(tight.persisted).toBe(true)

    // 比预览上限更松（但仍判得出超限）→ 预览仍然只有 200 行 / 10KB
    const loose = await run({ fullText: BIG, sink, maxLines: 2500, maxBytes: 1_000_000 })
    const loosePreview = truncateMiddle(BIG, 200, 10 * 1024)
    expect(loose.text.endsWith(`${loosePreview.text}\n...`)).toBe(true)
  })

  it('SPL-5c 有 sink 时「算不算超限」仍按调用方的上限判', async () => {
    const text = Array.from({ length: 20 }, (_, i) => `n${i}`).join('\n')
    const { sink, write } = okSink()

    expect((await run({ fullText: text, sink })).persisted, '缺省上限内不落盘').toBe(false)
    expect(write).not.toHaveBeenCalled()

    expect((await run({ fullText: text, sink, maxLines: 10 })).persisted).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
  })
})

describe('SPL 结果字段', () => {
  it('SPL-7 originalLines / originalBytes 描述的是入参全文，落没落盘都一样', async () => {
    const { sink } = okSink()
    const strategies: TruncateStrategy[] = ['middle', 'keep-start', 'keep-end']
    for (const strategy of strategies) {
      for (const s of [undefined, sink]) {
        const r = await run({ fullText: BIG, strategy, sink: s })
        expect(r.originalLines).toBe(3000)
        expect(r.originalBytes).toBe(byteLen(BIG))
      }
    }
  })
})
