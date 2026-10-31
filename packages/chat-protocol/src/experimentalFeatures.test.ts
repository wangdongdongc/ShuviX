/**
 * 实验功能清单（`experimentalFeatures.ts`）—— 入口上的「实验」小标签只认这张表。
 *
 *   EXP-1 任务列表是一项实验功能，悬停说明是通用那一句
 *   EXP-2 内置 server `plan`（也认选择器里的 `mcp:plan`）→ taskList
 *   EXP-3 别的名字一律 undefined：别的内置 server、大小写不同、改了名的自定义行、空串、原型链上的名字
 *   EXP-4 表里引用的每个悬停说明键在三语里都存在（三语键是否对齐由 locales.test 管，这里管「引用的键在」）
 */
import { describe, expect, it } from 'vitest'
import { EXPERIMENTAL_FEATURES, experimentalFeatureOfMcp } from './experimentalFeatures'
import en from './i18n/locales/en.json'
import ja from './i18n/locales/ja.json'
import zh from './i18n/locales/zh.json'

/** 按扁平键路径取语言包里的叶子（非字符串返回 undefined） */
function leaf(bundle: unknown, path: string): string | undefined {
  const found = path
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], bundle)
  return typeof found === 'string' ? found : undefined
}

describe('experimentalFeatures', () => {
  it('EXP-1 taskList 在表里，悬停说明是通用的 experimental.hint', () => {
    expect(EXPERIMENTAL_FEATURES.taskList).toBe('experimental.hint')
  })

  it('EXP-2 plan 与 mcp:plan → taskList', () => {
    expect(experimentalFeatureOfMcp('plan')).toBe('taskList')
    expect(experimentalFeatureOfMcp('mcp:plan')).toBe('taskList')
  })

  it.each([
    'browser',
    'mcp:browser',
    'Plan',
    '',
    'mcp:',
    'plan-custom',
    'toString',
    'constructor',
    '__proto__',
    'mcp:toString'
  ])('EXP-3 %j → undefined（只认自有属性）', (name) => {
    expect(experimentalFeatureOfMcp(name)).toBeUndefined()
  })

  it('EXP-4 表里每个值都是三语里存在的非空字符串键；标签文字本身也在', () => {
    const keys = [...new Set(Object.values(EXPERIMENTAL_FEATURES)), 'experimental.tag']
    for (const key of keys) {
      for (const [lang, bundle] of Object.entries({ en, zh, ja })) {
        const text = leaf(bundle, key)
        expect(text, `${lang}:${key}`).toBeTypeOf('string')
        expect(text!.trim(), `${lang}:${key}`).not.toBe('')
      }
    }
  })
})
