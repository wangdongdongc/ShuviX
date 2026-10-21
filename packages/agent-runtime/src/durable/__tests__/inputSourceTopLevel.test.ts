/**
 * `authorsOf(..., { topLevel: true })`（inputSource.ts，2026-10-20）—— 一串用户消息属于一条**顶层会话**时，没有
 * 「升级之前父会话发的消息没有记录」这回事（别的会话经会话权限表往里发消息恒有记录），所以没有记录的一律是人打的。
 * 大纲（`OutlineReader.topLevel`）与查看别的会话时的 `userIntervened`（desktop subSessionRunner `isTopLevel`）用它。
 *
 *   XS-26a topLevel: true → 没有记录的不论在第一条有记录的之前还是之后都是 human；有记录的仍是 parent
 *   XS-26b [guard] 不给 opts / `{}` / topLevel: false / undefined → 旧判法（锚点之前、整串没有记录 → unknown）
 *   XS-26c 两种判法只差在锚点之前：topLevel 的结果 = 旧结果把 unknown 换成 human（穷举长度 ≤ 6 的全部有无记录组合）
 *
 * AUTH-01..07（不带 opts 的判法本身）在 inputSource.test.ts；这一份只管 topLevel 这个开关。
 */
import { describe, expect, it } from 'vitest'
import { authorsOf, type MessageAuthor } from '../inputSource'

/** 一条用户消息：`p` = 有来源记录 */
interface Msg {
  id: string
  p?: true
}
const m = (id: string, sourced = false): Msg => (sourced ? { id, p: true } : { id })
const sourced = (item: Msg): boolean => item.p === true

function run(
  items: Msg[],
  opts?: Parameters<typeof authorsOf>[2]
): Array<[string, MessageAuthor | undefined]> {
  const authors = opts === undefined ? authorsOf(items, sourced) : authorsOf(items, sourced, opts)
  return items.map((item) => [item.id, authors.get(item)])
}

describe('authorsOf 的 topLevel 开关（XS-26）', () => {
  it('XS-26a topLevel: true、整串没有记录 → 全是 human（不带开关时全是 unknown）', () => {
    const items = [m('a'), m('b'), m('c')]
    expect(run(items, { topLevel: true })).toStrictEqual([
      ['a', 'human'],
      ['b', 'human'],
      ['c', 'human']
    ])
    expect(run(items)).toStrictEqual([
      ['a', 'unknown'],
      ['b', 'unknown'],
      ['c', 'unknown']
    ])
  })

  it('XS-26a topLevel: true、中间有记录：之前的也是 human，有记录的仍是 parent，之后的 human', () => {
    expect(
      run([m('h1'), m('h2'), m('s1', true), m('h3'), m('s2', true), m('h4')], { topLevel: true })
    ).toStrictEqual([
      ['h1', 'human'],
      ['h2', 'human'],
      ['s1', 'parent'],
      ['h3', 'human'],
      ['s2', 'parent'],
      ['h4', 'human']
    ])
  })

  it('XS-26a topLevel: true、空串 → 空表', () => {
    expect(authorsOf([], sourced, { topLevel: true })).toStrictEqual(new Map())
  })

  it.each([
    ['不给 opts', undefined],
    ['{}', {}],
    ['topLevel: false', { topLevel: false }],
    ['topLevel: undefined', { topLevel: undefined }]
  ] as const)('XS-26b [guard] %s → 旧判法：锚点之前 unknown、之后 human', (_label, opts) => {
    expect(run([m('u1'), m('p1', true), m('h1')], opts)).toStrictEqual([
      ['u1', 'unknown'],
      ['p1', 'parent'],
      ['h1', 'human']
    ])
  })

  it('XS-26c 穷举（长度 0..6 的全部有无记录组合）：topLevel 的结果 = 旧结果把 unknown 换成 human；不改输入', () => {
    let checked = 0
    for (let length = 0; length <= 6; length++) {
      for (let mask = 0; mask < 1 << length; mask++) {
        const items = Array.from({ length }, (_, i) => m(`m${i}`, ((mask >> i) & 1) === 1))
        const before = JSON.stringify(items)
        const legacy = run(items)
        const top = run(items, { topLevel: true })
        expect(top).toStrictEqual(
          legacy.map(([id, author]) => [id, author === 'unknown' ? 'human' : author])
        )
        expect(top.some(([, author]) => author === 'unknown')).toBe(false)
        expect(JSON.stringify(items)).toBe(before)
        checked++
      }
    }
    expect(checked).toBe(127)
  })
})
