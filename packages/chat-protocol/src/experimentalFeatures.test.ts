/**
 * 实验功能清单（`experimentalFeatures.ts`）—— 入口上的「实验」小标签只认这张表。
 *
 *   EXP-1 任务列表已转正（2026-11-14 成为内置工具 `update_plan`）：不在表里
 *   EXP-2 `plan` 与 `mcp:plan` 不再算实验功能 —— 目前没有哪台内置 server 是实验性质的
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
  it('EXP-1 taskList 不在表里（任务列表转正为内置工具 update_plan）', () => {
    expect(Object.keys(EXPERIMENTAL_FEATURES)).not.toContain('taskList')
  })

  it('EXP-2 plan 与 mcp:plan → undefined；四台内置 server 也都不是', () => {
    expect(experimentalFeatureOfMcp('plan')).toBeUndefined()
    expect(experimentalFeatureOfMcp('mcp:plan')).toBeUndefined()
    for (const server of ['ssh', 'browser', 'database', 'chrome']) {
      expect(experimentalFeatureOfMcp(server), server).toBeUndefined()
      expect(experimentalFeatureOfMcp(`mcp:${server}`), server).toBeUndefined()
    }
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
