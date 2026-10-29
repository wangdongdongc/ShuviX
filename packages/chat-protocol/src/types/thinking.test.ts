/**
 * 用户能选的思考档位 —— 输入框的思考选择器、agent md 的 `shuvix-thinking` 解析器与属性卡的下拉
 * 共用 `SELECTABLE_THINKING_LEVELS` 这一份。
 *
 * 钉两件事：清单本身（顺序即选择器里的排列；不含界面从未提供的 `minimal`，`max` 2026-10-29 起可选），以及 `isSelectableThinkingLevel` 只认清单里的原样小写串 —— 大小写归一是解析器的事，
 * 判据本身不该替调用方宽容一次（否则 md 里写得出、选择器却对不上号的值会从这里漏过去）。
 *
 * 以及设置项 `general.defaultThinkingLevel`（设置 → 通用 → 默认模型）用到的三样：
 * - TL-3 内置缺省档 `DEFAULT_THINKING_LEVEL` 是 medium，且本身是可选档（设置页画得出来）；
 * - TL-4 `defaultThinkingLevelOf`：可选档原样返回（含 off），其余一切 —— 没设过、`minimal`
 *   这种协议层有但界面画不出的值、大小写 / 空白不对、类型不对 —— 都回落到缺省档；
 * - TL-5 档位不翻译（2026-10-29）：界面直接显示档位名，三语文案里不再有 `input.think*` 键。
 */
import { describe, it, expect } from 'vitest'
import en from '../i18n/locales/en.json'
import zh from '../i18n/locales/zh.json'
import ja from '../i18n/locales/ja.json'
import {
  DEFAULT_THINKING_LEVEL,
  SELECTABLE_THINKING_LEVELS,
  defaultThinkingLevelOf,
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
  it('TL-1 清单恰为 off / low / medium / high / xhigh / max（顺序即选择器里的排列），不含 minimal', () => {
    expect([...SELECTABLE_THINKING_LEVELS]).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    const levels: readonly string[] = SELECTABLE_THINKING_LEVELS
    expect(levels).not.toContain('minimal')
  })
})

describe('isSelectableThinkingLevel', () => {
  it('TL-2a 协议层全部 7 档：恰好清单里那 6 档为真，只有 minimal 为假', () => {
    expect(ALL_LEVELS).toHaveLength(7)
    const accepted = ALL_LEVELS.filter((level) => isSelectableThinkingLevel(level))
    const refused = ALL_LEVELS.filter((level) => !isSelectableThinkingLevel(level))
    expect(accepted.sort()).toEqual([...SELECTABLE_THINKING_LEVELS].sort())
    expect(refused).toEqual(['minimal'])
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

describe('DEFAULT_THINKING_LEVEL', () => {
  it('TL-3 内置缺省档是 medium，且是可选档（设置页的分段控件能把它画成选中）', () => {
    expect(DEFAULT_THINKING_LEVEL).toBe('medium')
    expect(isSelectableThinkingLevel(DEFAULT_THINKING_LEVEL)).toBe(true)
  })
})

describe('defaultThinkingLevelOf', () => {
  it.each([...SELECTABLE_THINKING_LEVELS])('TL-4a 可选档原样返回：%s', (level) => {
    expect(defaultThinkingLevelOf(level)).toBe(level)
  })

  it.each([
    ['undefined（没设过）', undefined],
    ['null', null],
    ['空串', ''],
    ['minimal（协议层有、界面画不出）', 'minimal'],
    ['大写 HIGH', 'HIGH'],
    ['带前导空格 " high"', ' high'],
    ['乱写', 'garbage'],
    ['数字 0', 0],
    ['布尔 false', false],
    ['对象 {}', {}]
  ])('TL-4b 其余一切回落到 DEFAULT_THINKING_LEVEL：%s', (_label, raw) => {
    expect(defaultThinkingLevelOf(raw)).toBe(DEFAULT_THINKING_LEVEL)
  })
})

describe('档位文案', () => {
  it.each([
    ['en', en],
    ['zh', zh],
    ['ja', ja]
  ])('TL-5 %s：input 下没有 think* 翻译键（档位名原样显示）', (_lang, locale) => {
    const input = (locale as { input?: Record<string, unknown> }).input ?? {}
    expect(Object.keys(input).filter((key) => key.startsWith('think'))).toEqual([])
  })
})
