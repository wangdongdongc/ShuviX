/**
 * 工具卡上的「已审查」标记（toolReview.ts）—— 载体是工具结果 details 的保留键，随 toolResult 落进
 * 会话 JSONL：实时广播（tool_end）与重开会话的投影读的是同一份。
 *
 * 钉的是这条载体的两端：
 *   - 键名本身（改名 = 旧会话里的标记全读不出）；
 *   - withToolReview 的写入不动原 details、details 缺省时只带这一个键；
 *   - toolReviewOf 的读取对任何形状都不抛、形状不对就当没有（风险只认四档原词）；
 *   - 过一次 JSON 往返照样读得出（落盘 / IPC 都是 JSON）。
 */
import { describe, expect, it } from 'vitest'
import { PERMISSION_RISKS } from './permissionReview'
import {
  TOOL_REVIEW_DETAILS_KEY,
  toolReviewOf,
  withToolReview,
  type ToolReviewNote
} from './toolReview'

/** 一份 bash 工具自己的 details（工具结果上最常见的形状） */
const bashDetails = (): Record<string, unknown> => ({
  type: 'bash',
  exitCode: 0,
  truncated: false,
  cwd: '/w'
})

const NOTE: ToolReviewNote = { risk: 'medium', summary: 'Removes the build folder' }

describe('toolReview —— details 上的保留键', () => {
  it('TR-1 保留键恒为 shuvixReview（它随 toolResult 落盘，改名等于旧会话的标记全读不出）', () => {
    expect(TOOL_REVIEW_DETAILS_KEY).toBe('shuvixReview')
  })

  it.each(PERMISSION_RISKS)('TR-2 往返：风险 %s 写进 bash details 再读出，与原标记深等', (risk) => {
    const note: ToolReviewNote = { risk, summary: `summary for ${risk}` }
    expect(toolReviewOf(withToolReview(bashDetails(), note))).toEqual(note)
  })

  it('TR-3 写入不动原 details：冻结的 details 照样能写，结果是新对象、原对象一字未改', () => {
    const d = Object.freeze(bashDetails())
    const snapshot = { ...d }
    const out = withToolReview(d, NOTE)
    expect(out).toEqual({ ...snapshot, shuvixReview: NOTE })
    expect(out).not.toBe(d)
    expect(d).toEqual(snapshot)
    expect(TOOL_REVIEW_DETAILS_KEY in d).toBe(false)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ["'text'", 'text'],
    ['42', 42]
  ])('TR-4 details 为 %s 时结果恰为 {shuvixReview: note}', (_label, details) => {
    expect(withToolReview(details as unknown, NOTE)).toStrictEqual({ shuvixReview: NOTE })
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ["'x'", 'x'],
    ['0', 0],
    ['[]', []],
    ['{}', {}],
    ['{shuvixReview: null}', { shuvixReview: null }],
    ["{shuvixReview: 'low'}", { shuvixReview: 'low' }],
    ["{shuvixReview: ['low']}", { shuvixReview: ['low'] }],
    ['{shuvixReview: {}}', { shuvixReview: {} }],
    ["{shuvixReview: {summary: 's'}}", { shuvixReview: { summary: 's' } }],
    ["risk 'severe'", { shuvixReview: { risk: 'severe', summary: 's' } }],
    ["risk 'LOW'", { shuvixReview: { risk: 'LOW', summary: 's' } }],
    ['risk 3', { shuvixReview: { risk: 3, summary: 's' } }]
  ])('TR-5 形状不对（%s）→ undefined，且不抛', (_label, details) => {
    expect(() => toolReviewOf(details)).not.toThrow()
    expect(toolReviewOf(details)).toBeUndefined()
  })

  it.each([
    ['summary 缺失', { risk: 'high' }],
    ['summary 为数字', { risk: 'high', summary: 7 }]
  ])('TR-6 risk 合法、%s → {risk, summary: ""}', (_label, note) => {
    expect(toolReviewOf({ shuvixReview: note })).toStrictEqual({ risk: 'high', summary: '' })
  })

  it('TR-7 标记上多带的键（reason / decision）读出时一概不带', () => {
    const details = {
      shuvixReview: { risk: 'low', summary: 's', reason: 'r', decision: 'allow' }
    }
    expect(toolReviewOf(details)).toStrictEqual({ risk: 'low', summary: 's' })
  })

  it('TR-8 过一次 JSON 往返（落盘 / IPC）之后仍能读出', () => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(withToolReview(bashDetails(), NOTE)))
    expect(toolReviewOf(roundTripped)).toEqual(NOTE)
  })

  it('TR-9 details 里已有同名键时，用新标记覆盖', () => {
    const old = { ...bashDetails(), shuvixReview: { risk: 'low', summary: 'old' } }
    const out = withToolReview(old, NOTE)
    expect(toolReviewOf(out)).toEqual(NOTE)
    expect((out as Record<string, unknown>).cwd).toBe('/w')
  })
})
