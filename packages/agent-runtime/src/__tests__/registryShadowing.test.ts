/**
 * resolveShadowing / registryFileBase —— 注册表 md 同名裁决的纯函数表。
 *
 * 四个注册表（agent / 策略 / hook / bot）的运行时生效集与设置页 / 侧栏的全量列表，都是这一次
 * 裁决的两种投影。宿主那一层（agentService / policyService / hookService / botService 的单测）
 * 用真文件名验证「两边投影一致」；这里只钉规则本身：用户压过内置 → 文件名就是名字的那份 → 文件名
 * 短的 → 码点序，且与输入顺序无关。
 *
 * 大小写只能在这里测：macOS 默认文件系统不分大小写，真目录里放不下 `Scout.MD` 与 `scout.md` 两份。
 */
import { describe, it, expect } from 'vitest'
import {
  registryFileBase,
  resolveShadowing,
  type ShadowCandidate,
  type ShadowResolved
} from '../registryShadowing'

type Candidate = ShadowCandidate<string>

/** 用户文件候选（fileName 省略 = 没有文件身份的宿主） */
const u = (name: string, fileName?: string): Candidate => ({
  name,
  source: 'user',
  ...(fileName !== undefined ? { fileName } : {}),
  value: `user:${name}@${fileName ?? '-'}`
})

/** 内置候选（内置没有文件名） */
const b = (name: string): Candidate => ({ name, source: 'builtin', value: `builtin:${name}` })

/** 输出里没被遮蔽的那些 —— 判据是「没有这个键」，不是「这个键为 undefined」 */
const winnersOf = <T>(out: ShadowResolved<T>[]): ShadowResolved<T>[] =>
  out.filter((r) => !('shadowedBy' in r))

/**
 * 同名一组候选里胜出那份的文件名；顺带核对：恰好一个胜出者，其余每一份都指向它。
 * 两种输入顺序各跑一遍，结论必须一样。
 */
function winnerFileOf(candidates: Candidate[]): string | undefined {
  const verdicts = [candidates, [...candidates].reverse()].map((input) => {
    const out = resolveShadowing(input)
    const winners = winnersOf(out)
    expect(winners, JSON.stringify(input)).toHaveLength(1)
    const [winner] = winners
    for (const r of out) {
      if (r === winner) continue
      expect(r.shadowedBy, JSON.stringify(input)).toStrictEqual({
        source: winner.source,
        ...(winner.fileName ? { fileName: winner.fileName } : {})
      })
    }
    return winner.fileName
  })
  expect(verdicts[1], 'reversed input order').toBe(verdicts[0])
  return verdicts[0]
}

/** 全排列（RS-5 用；5 份 → 120 种） */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])
  )
}

describe('resolveShadowing —— 胜出次序', () => {
  it('RS-1 用户文件压过内置，与输入顺序无关；输出仍按输入顺序', () => {
    const builtin = b('x')
    const user = u('x', 'zzz.md')

    // 文件名既不是名字、又长又靠后 —— 用户压过内置这一条不看文件名
    const out = resolveShadowing([builtin, user])
    expect(out).toStrictEqual([
      { ...builtin, shadowedBy: { source: 'user', fileName: 'zzz.md' } },
      { ...user }
    ])
    expect('shadowedBy' in out[1]).toBe(false)

    const reversed = resolveShadowing([user, builtin])
    expect(reversed).toStrictEqual([
      { ...user },
      { ...builtin, shadowedBy: { source: 'user', fileName: 'zzz.md' } }
    ])
    expect('shadowedBy' in reversed[0]).toBe(false)
  })

  it('RS-2 同为用户文件：文件名就是名字的那份胜出，哪怕另一份更短或排序更前', () => {
    // `s.md` 更短、码点序也靠前；`ask-1.md` 同样靠前 —— 只有「文件名即名字」能让后者输
    expect(winnerFileOf([u('scout', 's.md'), u('scout', 'scout.md')])).toBe('scout.md')
    expect(winnerFileOf([u('ask', 'ask-1.md'), u('ask', 'ask.md')])).toBe('ask.md')
  })

  it('RS-3 「文件名即名字」按新建时的净化规则比，大小写不敏感，`.md` 后缀大小写也不论', () => {
    expect(winnerFileOf([u('scout', 'a.md'), u('scout', 'Scout.MD')])).toBe('Scout.MD')
    // 名字里的路径分隔 / 保留字符在文件名里是 `-`
    expect(winnerFileOf([u('net/ssh:guard', 'a.md'), u('net/ssh:guard', 'net-ssh-guard.md')])).toBe(
      'net-ssh-guard.md'
    )
    // 前导点在文件名里被剥掉
    expect(winnerFileOf([u('.hidden', 'a.md'), u('.hidden', 'hidden.md')])).toBe('hidden.md')
    // `...` 净化成空串：没有哪份文件「就是它」，退回文件名短的那份
    expect(winnerFileOf([u('...', 'bb.md'), u('...', 'a.md')])).toBe('a.md')
  })

  it('RS-4 都不是名字本身：文件名短的胜出，再按码点序（不是 locale 序）', () => {
    expect(winnerFileOf([u('p', 'abc.md'), u('p', 'ab.md')])).toBe('ab.md')
    // 同长：码点序里大写字母排在小写之前（localeCompare 会把 alfa 排前面）
    expect(winnerFileOf([u('p', 'alfa.md'), u('p', 'Zeta.md')])).toBe('Zeta.md')
  })

  it('RS-5 输入顺序改变不了结论：5 份候选的 120 种排列，胜者恒为 a.md，其余每份都指向它', () => {
    const pool = [b('p'), u('p', 'zz.md'), u('p', 'c.md'), u('p', 'a.md'), u('p', 'bb.md')]
    const all = permutations(pool)
    expect(all).toHaveLength(120)
    for (const input of all) {
      const label = input.map((c) => c.fileName ?? 'builtin').join(',')
      const out = resolveShadowing(input)
      const winners = winnersOf(out)
      expect(
        winners.map((r) => r.fileName),
        label
      ).toEqual(['a.md'])
      for (const r of out) {
        if (r === winners[0]) continue
        expect(r.shadowedBy, label).toStrictEqual({ source: 'user', fileName: 'a.md' })
      }
    }
  })
})

describe('resolveShadowing —— 输出契约与退化情形', () => {
  it('RS-6 逐份按输入顺序返回、字段原样（value 保持引用）；胜者没有 shadowedBy 键；结果是新对象，输入不被改动', () => {
    const values = [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
    const input: ShadowCandidate<{ id: number }>[] = [
      { name: 'x', source: 'user', fileName: 'x.md', value: values[0] },
      { name: 'x', source: 'builtin', value: values[1] },
      { name: 'y', source: 'user', fileName: 'y copy.md', value: values[2] },
      { name: 'z', source: 'builtin', value: values[3] },
      { name: 'x', source: 'user', fileName: 'x copy.md', value: values[4] }
    ]
    const snapshot = JSON.stringify(input)

    const out = resolveShadowing(input)
    expect(out).toHaveLength(input.length)
    out.forEach((r, i) => {
      expect(r, `#${i}`).not.toBe(input[i])
      expect(r.name, `#${i}`).toBe(input[i].name)
      expect(r.source, `#${i}`).toBe(input[i].source)
      expect('fileName' in r, `#${i}`).toBe('fileName' in input[i])
      expect(r.fileName, `#${i}`).toBe(input[i].fileName)
      expect(r.value, `#${i}`).toBe(values[i])
    })

    // x.md（名字本身）、y 唯一的一份、z 唯一的内置胜出；胜者连 undefined 的 shadowedBy 键都没有
    for (const i of [0, 2, 3]) expect('shadowedBy' in out[i], `#${i}`).toBe(false)
    expect(out[1].shadowedBy).toStrictEqual({ source: 'user', fileName: 'x.md' })
    expect(out[4].shadowedBy).toStrictEqual({ source: 'user', fileName: 'x.md' })

    expect(JSON.stringify(input)).toBe(snapshot)
    for (const candidate of input) expect('shadowedBy' in candidate).toBe(false)
  })

  it('RS-7 退化平局：两份同名内置 / 两份没有文件名的用户候选 → 先到者胜，指向它的 shadowedBy 不带 fileName 键；大小写不同是两个名字', () => {
    const builtins = resolveShadowing([b('dup'), b('dup')])
    expect('shadowedBy' in builtins[0]).toBe(false)
    expect(builtins[1].shadowedBy).toStrictEqual({ source: 'builtin' })
    expect('fileName' in builtins[1].shadowedBy!).toBe(false)

    const users = resolveShadowing([u('dup'), u('dup')])
    expect('shadowedBy' in users[0]).toBe(false)
    expect(users[1].shadowedBy).toStrictEqual({ source: 'user' })
    expect('fileName' in users[1].shadowedBy!).toBe(false)

    // 名字是区分大小写的身份：Scout 与 scout 各自独占，谁也不遮蔽谁
    const cased = resolveShadowing([u('Scout', 'a.md'), u('scout', 'b.md')])
    expect(winnersOf(cased)).toHaveLength(2)
  })
})

describe('registryFileBase —— 由名字派生文件名的净化规则（新建与同名裁决共用）', () => {
  it('RS-8 路径分隔 / 保留字符 → `-`，前导点剥掉，其余原样', () => {
    const table: Array<[string, string]> = [
      ['a/b:c', 'a-b-c'],
      ['net\\ssh', 'net-ssh'],
      ['a*b?c"d<e>f|g', 'a-b-c-d-e-f-g'],
      ['..hidden', 'hidden'],
      ['...', ''],
      ['中文 名', '中文 名']
    ]
    for (const [name, base] of table) {
      expect(registryFileBase(name), name).toBe(base)
    }
  })
})
