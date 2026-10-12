/**
 * 命令风险分类（CommandRisk）的形状校验 —— 宿主交来的分类要完整才挂上命令客体、才进决策记录。
 *
 *   CR-0  类别表恰是 12 类、顺序固定、read_only 打头
 *   CR-1  每个类别 × 概率取 0 / 0.5 / 1 → true
 *   CR-2  类别不是已知的一类（未知名 / 大小写不同 / 数字 / 缺）→ false
 *   CR-3  confidence / readOnly：缺、-0.01、1.01、NaN、Infinity、'0.5' 任一 → false
 *   CR-3b probabilities 缺 / null / 字符串 / []，或 12 个键中任一缺、越界、字符串、null → false
 *   CR-4  模型名缺、非字符串、null、空串 → false
 *   CR-5  不是对象（null / undefined / 0 / 'x' / []）→ false
 *   CR-6  多余的键（顶层、probabilities 里）不影响守卫（挂上去时由 pickCommandRisk 丢掉）
 *   CR-6b 只校验形状：概率不必加和为 1、选中类别不必是最大概率、readOnly 不必等于 probabilities.read_only
 *   CR-7  commandRiskOf：命令客体上完整的 risk → 同一个引用；不完整 / 不是命令客体 → undefined
 *   CR-8  pickCommandRisk：恰好 5 个键、probabilities 恰好 12 个键（按类别顺序），内外两层都是新对象
 */
import { describe, expect, it } from 'vitest'
import { commandRiskOf, isCommandRisk, pickCommandRisk } from '../commandRisk'
import { COMMAND_RISK_CATEGORIES, type CommandRisk, type SecurityObject } from '../types'

const EXPECTED_CATEGORIES = [
  'read_only',
  'personal_data',
  'runs_project_code',
  'local_change',
  'outside_change',
  'install',
  'remote_change',
  'data_out',
  'secrets',
  'destructive',
  'privilege',
  'persistence'
]

/** 每个类别都取 p 的概率表 */
function allProbabilities(p: number): Record<string, number> {
  return Object.fromEntries(COMMAND_RISK_CATEGORIES.map((c) => [c, p]))
}

const RISK: CommandRisk = {
  category: 'local_change',
  confidence: 0.7,
  readOnly: 0.1,
  probabilities: {
    read_only: 0.1,
    personal_data: 0,
    runs_project_code: 0.05,
    local_change: 0.7,
    outside_change: 0.05,
    install: 0,
    remote_change: 0,
    data_out: 0,
    secrets: 0,
    destructive: 0.1,
    privilege: 0,
    persistence: 0
  },
  model: 'p/m'
}

/** 在完整的一份上改一个顶层键（value 为 undefined = 删掉这个键） */
function withKey(key: string, value: unknown): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...RISK, probabilities: { ...RISK.probabilities } }
  if (value === undefined) delete copy[key]
  else copy[key] = value
  return copy
}

/** 在完整的一份上改 probabilities 的一个键（value 为 undefined = 删掉这个键） */
function withProbability(key: string, value: unknown): Record<string, unknown> {
  const probabilities: Record<string, unknown> = { ...RISK.probabilities }
  if (value === undefined) delete probabilities[key]
  else probabilities[key] = value
  return { ...RISK, probabilities }
}

const BAD_PROBABILITIES: Array<[string, unknown]> = [
  ['缺', undefined],
  ['-0.01', -0.01],
  ['1.01', 1.01],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ["'0.5'", '0.5']
]

describe('COMMAND_RISK_CATEGORIES', () => {
  it('CR-0 恰是 12 类，顺序固定，read_only 打头', () => {
    expect([...COMMAND_RISK_CATEGORIES]).toEqual(EXPECTED_CATEGORIES)
    expect(COMMAND_RISK_CATEGORIES).toHaveLength(12)
    expect(COMMAND_RISK_CATEGORIES[0]).toBe('read_only')
    expect(new Set(COMMAND_RISK_CATEGORIES).size).toBe(12)
  })
})

describe('isCommandRisk', () => {
  it.each(EXPECTED_CATEGORIES)('CR-1 类别 %s、概率取 0 / 0.5 / 1 → true', (category) => {
    for (const p of [0, 0.5, 1]) {
      const risk = {
        category,
        confidence: p,
        readOnly: p,
        probabilities: allProbabilities(p),
        model: 'p/m'
      }
      expect(isCommandRisk(risk), `${category} p ${p}`).toBe(true)
    }
  })

  it.each<[string, unknown]>([
    ['未知名 dangerous', 'dangerous'],
    ['大小写不同 Read_Only', 'Read_Only'],
    ['空串', ''],
    ['数字 0', 0],
    ['null', null],
    ['缺', undefined]
  ])('CR-2 类别 %s → false', (_label, category) => {
    expect(isCommandRisk(withKey('category', category))).toBe(false)
  })

  it.each(
    (['confidence', 'readOnly'] as const).flatMap((key) =>
      BAD_PROBABILITIES.map(([label, value]): [string, string, unknown] => [key, label, value])
    )
  )('CR-3 %s = %s → false', (key, _label, value) => {
    expect(isCommandRisk(withKey(key, value))).toBe(false)
  })

  it.each<[string, unknown]>([
    ['缺', undefined],
    ['null', null],
    ["字符串 'x'", 'x'],
    ['[]', []]
  ])('CR-3b probabilities = %s → false', (_label, value) => {
    expect(isCommandRisk(withKey('probabilities', value))).toBe(false)
  })

  const BAD_ENTRY: Array<[string, unknown]> = [
    ['缺', undefined],
    ['-0.01', -0.01],
    ['1.01', 1.01],
    ["'0.5'", '0.5'],
    ['null', null]
  ]
  it.each(
    EXPECTED_CATEGORIES.flatMap((key) =>
      BAD_ENTRY.map(([label, value]): [string, string, unknown] => [key, label, value])
    )
  )('CR-3b probabilities.%s = %s → false', (key, _label, value) => {
    expect(isCommandRisk(withProbability(key, value))).toBe(false)
  })

  it.each<[string, unknown]>([
    ['缺', undefined],
    ['123', 123],
    ['null', null],
    ["''", '']
  ])('CR-4 模型名 %s → false', (_label, model) => {
    expect(isCommandRisk(withKey('model', model))).toBe(false)
  })

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['0', 0],
    ["'x'", 'x'],
    ['[]', []]
  ])('CR-5 %s → false', (_label, value) => {
    expect(isCommandRisk(value)).toBe(false)
  })

  it('CR-6 多余的键不影响守卫：顶层与 probabilities 里带上别的键仍是 true', () => {
    expect(isCommandRisk({ ...RISK, extra: 'x', nested: { a: 1 } })).toBe(true)
    expect(
      isCommandRisk({ ...RISK, probabilities: { ...RISK.probabilities, network: 0.4, x: 'y' } })
    ).toBe(true)
  })

  it('CR-6b 只校验形状：概率不加和为 1、选中的不是最大概率、readOnly 与 probabilities.read_only 不等 → 仍是 true', () => {
    // 加和远超 1
    expect(isCommandRisk({ ...RISK, probabilities: allProbabilities(1) })).toBe(true)
    // 选 read_only，可 read_only 的概率最低
    expect(
      isCommandRisk({
        ...RISK,
        category: 'read_only',
        probabilities: { ...RISK.probabilities, read_only: 0, destructive: 0.9 }
      })
    ).toBe(true)
    // readOnly 与 probabilities.read_only 各说各的
    expect(isCommandRisk({ ...RISK, readOnly: 0.95 })).toBe(true)
  })
})

describe('commandRiskOf', () => {
  it('CR-7 命令客体上完整的 risk → 同一个引用；没有 / 不完整 → undefined；路径客体带着完整 risk 也 → undefined', () => {
    const command: SecurityObject = { type: 'command', command: 'ls', risk: RISK }
    expect(commandRiskOf(command)).toBe(RISK)

    expect(commandRiskOf({ type: 'command', command: 'ls' })).toBeUndefined()
    expect(
      commandRiskOf({
        type: 'command',
        command: 'ls',
        risk: withKey('category', 'nope') as SecurityObject['risk']
      })
    ).toBeUndefined()
    expect(
      commandRiskOf({
        type: 'command',
        command: 'ls',
        risk: withProbability('secrets', undefined) as SecurityObject['risk']
      })
    ).toBeUndefined()
    expect(commandRiskOf({ type: 'path', path: '/ws/a', risk: RISK })).toBeUndefined()
  })
})

describe('pickCommandRisk', () => {
  it('CR-8 恰好 5 个已知键、probabilities 恰好 12 个键（按类别顺序），内外两层都是新对象', () => {
    const host = {
      ...RISK,
      extra: 'leak',
      note: { a: 1 },
      probabilities: { ...RISK.probabilities, network: 0.4 }
    } as CommandRisk & { extra: string; note: { a: number } }
    const picked = pickCommandRisk(host)

    expect(picked).toStrictEqual(RISK)
    expect(Object.keys(picked).sort()).toEqual(
      ['category', 'confidence', 'model', 'probabilities', 'readOnly'].sort()
    )
    expect(Object.keys(picked.probabilities)).toEqual(EXPECTED_CATEGORIES)

    // 外层、内层都不是宿主那份
    expect(picked).not.toBe(host)
    expect(picked.probabilities).not.toBe(host.probabilities)

    // 宿主事后改，交出去的不跟着变
    host.category = 'destructive'
    host.probabilities.destructive = 0.99
    expect(picked.category).toBe('local_change')
    expect(picked.probabilities.destructive).toBe(0.1)

    // 反过来改交出去的，宿主那份也不变
    picked.probabilities.read_only = 0.5
    picked.readOnly = 0.5
    expect(host.probabilities.read_only).toBe(0.1)
    expect(host.readOnly).toBe(0.1)
  })
})
