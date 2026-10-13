/**
 * 内置提供商目录 —— `BUILTIN_PROVIDERS` 与 `isClassifierOnlyProvider`。
 *
 * 只提供分类模型的提供商（TypeSafe）由 `classifierOnly` 标出：设置页给它挂「分类器」标签、把模型
 * 管理换成一句提示，模型层不为它造 overlay 聊天模型。这里钉死「哪一个是」和判定函数的边界；
 * 目录里每个名字在 pi 里都有对应提供商、classifierOnly 的那家在 pi 里确实没有聊天目录，
 * 由 agent-runtime 的 catalog.test.ts（CAT-05 / CAT-05c）负责。
 */
import { describe, expect, it } from 'vitest'
import { BUILTIN_PROVIDERS, isClassifierOnlyProvider } from './providerCatalog'

describe('BUILTIN_PROVIDERS', () => {
  it('PC-1 exactly one typesafe entry: TypeSafe, classifier-only, on the System One api', () => {
    const entries = BUILTIN_PROVIDERS.filter((entry) => entry.name === 'typesafe')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      displayName: 'TypeSafe',
      classifierOnly: true,
      defaultApi: 'typesafe-system-one'
    })
  })

  it('PC-4 names are unique (the seed relies on providers.name UNIQUE)', () => {
    const names = BUILTIN_PROVIDERS.map((entry) => entry.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('isClassifierOnlyProvider', () => {
  it('PC-2 typesafe is the only classifier-only entry; every other builtin name answers false', () => {
    expect(
      BUILTIN_PROVIDERS.filter((entry) => entry.classifierOnly).map((entry) => entry.name)
    ).toEqual(['typesafe'])
    expect(isClassifierOnlyProvider('typesafe')).toBe(true)
    for (const entry of BUILTIN_PROVIDERS) {
      if (entry.name === 'typesafe') continue
      expect(isClassifierOnlyProvider(entry.name), entry.name).toBe(false)
    }
  })

  it.each(['', 'nope', 'openrouter'])('PC-3 %j → false', (name) => {
    expect(isClassifierOnlyProvider(name)).toBe(false)
  })
})
