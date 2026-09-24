/**
 * `isZeroContentAssistant` —— 「零内容 assistant 空回复」的判定表。
 *
 * 这条判定决定哪些调用的 usage 不可信：自动压缩的估算与运行时注册中心（上下文占用、缓存
 * 命中率）都靠它剔掉空回复。这里只钉**判定本身**；「剔掉之后读数不变」的接线在
 * `__tests__/runtimeRegistry.test.ts` 的 R-13 ~ R-18。
 *
 * 契约：只判 assistant；content 是空白字符串，或数组里每一块都是空白 text / 空白 thinking
 * （空数组也算 —— openai-completions 适配器对空 delta 不建块，真实的空回复就是 `[]`）。
 * toolCall / image / 未知类型 / 没有 type 的块都算「有内容」，形状不认识的 content 也按
 * 「有内容」处理（偏保守：宁可放过一条坏数据，也不丢掉一条真调用的 usage）。
 *
 * 不钉：「空白 thinking 文本但带非空签名」的块（加密推理）—— 该不该算内容还没定。
 *
 *   Z-1 ~ Z-3   非 assistant / 没有 role → false
 *   Z-4 ~ Z-5   字符串 content：空白 → true，有字 → false
 *   Z-6         空数组 → true
 *   Z-7 ~ Z-9   空白 text / 空白 thinking / 两者混合 → true
 *   Z-10 ~ Z-14 任一块有内容（非空 text / thinking、toolCall、image、未知块、已脱敏 thinking）→ false
 *   Z-15        content 形状不认识 → false
 */
import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { isZeroContentAssistant } from '../zeroContent'

/** 判定只看 role 与 content，其余字段一概不需要 */
const msg = (fields: Record<string, unknown>): AgentMessage => fields as unknown as AgentMessage
const assistant = (content: unknown): AgentMessage => msg({ role: 'assistant', content })

const toolCall = { type: 'toolCall', id: 't1', name: 'ls', arguments: {} }

describe('isZeroContentAssistant', () => {
  it.each([
    ['user，空字符串', msg({ role: 'user', content: '' })],
    ['user，空数组', msg({ role: 'user', content: [] })]
  ])('Z-1 只判 assistant：%s → false', (_label, m) => {
    expect(isZeroContentAssistant(m)).toBe(false)
  })

  it('Z-2 toolResult，空数组 → false', () => {
    expect(isZeroContentAssistant(msg({ role: 'toolResult', content: [] }))).toBe(false)
  })

  it('Z-3 没有 role 的对象 → false', () => {
    expect(isZeroContentAssistant(msg({ content: [] }))).toBe(false)
  })

  it.each([
    ['空字符串', ''],
    ['只有空白', '   \n\t']
  ])('Z-4 assistant 的字符串 content %s → true', (_label, content) => {
    expect(isZeroContentAssistant(assistant(content))).toBe(true)
  })

  it.each([
    ['单个字符', 'x'],
    ['两侧带空白', ' x ']
  ])('Z-5 assistant 的字符串 content 有字（%s）→ false', (_label, content) => {
    expect(isZeroContentAssistant(assistant(content))).toBe(false)
  })

  it('Z-6 空数组 → true（真实空回复的形状）', () => {
    expect(isZeroContentAssistant(assistant([]))).toBe(true)
  })

  it.each([
    ['空 text', [{ type: 'text', text: '' }]],
    ['空白 text', [{ type: 'text', text: ' \n' }]],
    ['没有 text 字段', [{ type: 'text' }]]
  ])('Z-7 %s → true', (_label, content) => {
    expect(isZeroContentAssistant(assistant(content))).toBe(true)
  })

  it.each([
    ['空 thinking', [{ type: 'thinking', thinking: '' }]],
    ['空白 thinking', [{ type: 'thinking', thinking: '  ' }]],
    ['没有 thinking 字段', [{ type: 'thinking' }]]
  ])('Z-8 %s → true', (_label, content) => {
    expect(isZeroContentAssistant(assistant(content))).toBe(true)
  })

  it('Z-9 空白 text 与空白 thinking 混合 → true', () => {
    expect(
      isZeroContentAssistant(
        assistant([
          { type: 'text', text: '' },
          { type: 'thinking', thinking: ' \n' },
          { type: 'text', text: '\t' }
        ])
      )
    ).toBe(true)
  })

  it.each([
    ['非空 text', [{ type: 'text', text: 'hi' }]],
    ['非空 thinking', [{ type: 'thinking', thinking: 'hmm' }]]
  ])('Z-10 %s → false（非空 thinking 也算内容）', (_label, content) => {
    expect(isZeroContentAssistant(assistant(content))).toBe(false)
  })

  it('Z-11 一块有内容就够：空 text + 非空 thinking → false', () => {
    expect(
      isZeroContentAssistant(
        assistant([
          { type: 'text', text: '' },
          { type: 'thinking', thinking: 'plan' }
        ])
      )
    ).toBe(false)
  })

  it.each([
    ['toolCall 单块', [toolCall]],
    ['空 text + toolCall', [{ type: 'text', text: '' }, toolCall]]
  ])('Z-12 %s → false', (_label, content) => {
    expect(isZeroContentAssistant(assistant(content))).toBe(false)
  })

  it.each([
    ['image 块', [{ type: 'image', data: 'x', mimeType: 'image/png' }]],
    ['未知 type 块', [{ type: 'mystery' }]],
    ['没有 type 的块', [{}]]
  ])('Z-13 %s → false', (_label, content) => {
    expect(isZeroContentAssistant(assistant(content))).toBe(false)
  })

  it('Z-14 已脱敏的 thinking 块（pi 的 anthropic 适配器的形状）→ false', () => {
    expect(
      isZeroContentAssistant(
        assistant([{ type: 'thinking', thinking: '[Reasoning redacted]', redacted: true }])
      )
    ).toBe(false)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['数字', 42]
  ])('Z-15 content 形状不认识（%s）→ false', (_label, content) => {
    expect(isZeroContentAssistant(assistant(content))).toBe(false)
  })
})
