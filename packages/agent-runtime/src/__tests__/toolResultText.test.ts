/**
 * TRT —— 工具结果的界面文字化（`toolResultText`）：实时广播与重开会话**同一个函数**。
 *
 * 以前三份写法各算各的：桌面实时路径（图片换占位、按行拼）、宿主不注入时的缺省转换（图片块
 * JSON.stringify —— 整段 base64 铺进工具卡片）、重开会话的投影（文本首尾相连、图片丢掉）。
 * 于是一次「文字 + 图 + 文字」的结果，同一张卡片跑着的时候和重开之后显示两样东西；MCP 结果
 * 如今可以带图、也可以是多段文字，这个分歧就从边角变成了常态。
 *
 * 这里钉函数本身（TRT-1 ~ 3）；重开投影对着同一个函数断言 → legacy/harnessV3/__tests__/projection.test.ts
 *（TRT-5）。旧运行时的广播路径（缺省转换 TRT-4、桌面实时管线 TRT-6）随旧运行时（pi 0.80 harness）一起退场；
 * durable 条目的投影（phase 3）同样该用这个函数。
 */
import { describe, it, expect } from 'vitest'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import { imagePlaceholder, toolResultText } from '../toolResultText'

/** 一段够长、够特征的假 base64 —— 断言「它没出现在输出里」 */
const BASE64 = 'iVBORw0KGgoAAAANSUhEUg' + 'QUJDRUZH'.repeat(200)

const MIXED: Array<TextContent | ImageContent> = [
  { type: 'text', text: 'a' },
  { type: 'image', data: BASE64, mimeType: 'image/png' },
  { type: 'text', text: 'b' }
]

describe('toolResultText', () => {
  it('TRT-1 字符串原样返回；undefined 给空串', () => {
    expect(toolResultText('already text\nsecond line')).toBe('already text\nsecond line')
    expect(toolResultText(undefined)).toBe('')
  })

  it('TRT-2 文本原样、图片换占位，块与块之间换行', () => {
    expect(toolResultText(MIXED)).toBe(`a\n${imagePlaceholder('image/png')}\nb`)
    // 占位点名 mime，但绝不带 base64
    expect(imagePlaceholder('image/png')).toContain('image/png')
    expect(toolResultText(MIXED)).not.toContain(BASE64.slice(0, 64))
  })

  it('TRT-3 不认识的块给它的 JSON', () => {
    const foo = { type: 'foo', x: 1 }
    expect(toolResultText([foo] as unknown as Parameters<typeof toolResultText>[0])).toBe(
      JSON.stringify(foo)
    )
  })
})
