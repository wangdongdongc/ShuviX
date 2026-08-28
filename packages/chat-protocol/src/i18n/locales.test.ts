import { describe, it, expect } from 'vitest'
import en from './locales/en.json'
import zh from './locales/zh.json'
import ja from './locales/ja.json'

/**
 * 三语键集合齐平 —— UI 文案的唯一真源就是这三份 JSON，缺键的表现是界面上直接
 * 露出 `toolCall.imageMissing` 这样的原始键名（i18next 的兜底），而不是报错。
 * 加文案时漏译一门语言几乎无感，故用一条常驻断言把它钉住。
 */
function flatten(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key)
  )
}

/** a 有而 b 没有的键（排序后便于读失败输出） */
function missing(a: string[], b: string[]): string[] {
  const known = new Set(b)
  return a.filter((k) => !known.has(k)).sort()
}

describe('i18n 语言包', () => {
  const keys = { en: flatten(en), zh: flatten(zh), ja: flatten(ja) }

  it('zh / ja 与 en 的键集合完全一致', () => {
    expect({
      zhMissing: missing(keys.en, keys.zh),
      zhExtra: missing(keys.zh, keys.en),
      jaMissing: missing(keys.en, keys.ja),
      jaExtra: missing(keys.ja, keys.en)
    }).toEqual({ zhMissing: [], zhExtra: [], jaMissing: [], jaExtra: [] })
  })

  it('键数量三语相等', () => {
    expect(keys.en.length).toBeGreaterThan(0)
    expect([keys.zh.length, keys.ja.length]).toEqual([keys.en.length, keys.en.length])
  })
})
