/**
 * TRT —— 工具结果的界面文字化（`toolResultText`）：实时广播与重开会话**同一个函数**。
 *
 * 以前三份写法各算各的：桌面实时路径（图片换占位、按行拼）、宿主不注入时的缺省转换（图片块
 * JSON.stringify —— 整段 base64 铺进工具卡片）、重开会话的投影（文本首尾相连、图片丢掉）。
 * 于是一次「文字 + 图 + 文字」的结果，同一张卡片跑着的时候和重开之后显示两样东西；MCP 结果
 * 如今可以带图、也可以是多段文字，这个分歧就从边角变成了常态。
 *
 * 这里钉函数本身与缺省转换（TRT-1 ~ 4）；另两处调用点各在自己的测试文件里对着同一个函数断言：
 * 重开投影 → harness/__tests__/projection.test.ts（TRT-5），桌面实时管线 →
 * apps/desktop/src/main/services/__tests__/stepPersistPipeline.test.ts（TRT-6）。
 * 缺省转换在广播路径上的那一条在 harness/__tests__/eventHandler.test.ts。
 */
import { describe, it, expect } from 'vitest'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import { imagePlaceholder, toolResultText } from '../toolResultText'
import { defaultToolResultTransform } from '../types'

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

describe('defaultToolResultTransform（宿主不注入 transform 时的广播文字）', () => {
  it('TRT-4 图片块换成占位，不再把 base64 JSON 进工具卡片；与 toolResultText 一字不差', () => {
    const content = [
      { type: 'text', text: 'screenshot taken' },
      { type: 'image', data: BASE64, mimeType: 'image/png' }
    ]
    const out = defaultToolResultTransform({
      toolName: 'mcp__browser__screenshot',
      toolCallId: 'call-1',
      sessionId: 'sess-1',
      isError: false,
      content
    })
    expect(out.content).toContain(imagePlaceholder('image/png'))
    expect(out.content).not.toContain(BASE64.slice(0, 64))
    expect(out.content).toBe(toolResultText(content as Array<TextContent | ImageContent>))
  })
})
