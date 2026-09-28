/**
 * 用户能选的思考档位 —— 输入框的思考选择器、agent md 的 `shuvix-thinking` 解析器与属性卡的下拉
 * 共用 `SELECTABLE_THINKING_LEVELS` 这一份。
 *
 * 钉两件事：清单本身（顺序即选择器里的排列；不含界面从未提供的 `minimal` 与只在协议层承载的
 * `max`），以及 `isSelectableThinkingLevel` 只认清单里的原样小写串 —— 大小写归一是解析器的事，
 * 判据本身不该替调用方宽容一次（否则 md 里写得出、选择器却对不上号的值会从这里漏过去）。
 */
import { describe, it, expect } from 'vitest'
import {
  SELECTABLE_THINKING_LEVELS,
  isSelectableThinkingLevel,
  type ThinkingLevel
} from './thinking'

/**
 * ThinkingLevel 的全部取值。写成 Record 是为了让类型系统替这张表把关：协议层加一档或删一档，
 * 这里少一个键 / 多一个键 typecheck 当场就红，TL-2 不会拿一份过期的全集去比。
 */
const EVERY_LEVEL: Record<ThinkingLevel, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true
}
const ALL_LEVELS = Object.keys(EVERY_LEVEL) as ThinkingLevel[]

describe('SELECTABLE_THINKING_LEVELS', () => {
  it('TL-1 清单恰为 off / low / medium / high / xhigh（顺序即选择器里的排列），不含 minimal 与 max', () => {
    expect([...SELECTABLE_THINKING_LEVELS]).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
    const levels: readonly string[] = SELECTABLE_THINKING_LEVELS
    expect(levels).not.toContain('minimal')
    expect(levels).not.toContain('max')
  })
})

describe('isSelectableThinkingLevel', () => {
  it('TL-2a 协议层全部 7 档：恰好清单里那 5 档为真，minimal / max 为假', () => {
    expect(ALL_LEVELS).toHaveLength(7)
    const accepted = ALL_LEVELS.filter((level) => isSelectableThinkingLevel(level))
    const refused = ALL_LEVELS.filter((level) => !isSelectableThinkingLevel(level))
    expect(accepted.sort()).toEqual([...SELECTABLE_THINKING_LEVELS].sort())
    expect(refused.sort()).toEqual(['max', 'minimal'])
  })

  it.each([
    ['大写（归一是解析器的事，判据不替它宽容）', 'HIGH'],
    ['空串', ''],
    ['null', null],
    ['undefined', undefined],
    ['布尔 false', false],
    ['数字 0', 0]
  ])('TL-2b 非清单值一律为假：%s', (_label, value) => {
    expect(isSelectableThinkingLevel(value)).toBe(false)
  })
})
