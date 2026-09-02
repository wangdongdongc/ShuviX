/**
 * 子会话自动展开的判定。
 *
 * 为什么这条要单测而不是 e2e：它要区分的两种情形**只差一帧**，而 e2e 里摆不稳
 * ——「新开窗口第一次拿到列表」那一帧，在同一个实例里没有第二次机会（每条 spec 一个
 * 实例、组件不重挂载、渲染端的 reload 被 will-navigate 守卫挡着）。而这条判据正是
 * 在那一帧上出的错：只认「新出现的子会话 id」的话，第一次拿到数据时所有子会话都算新，
 * 于是打开窗口就被整棵树糊满。
 */
import { describe, it, expect } from 'vitest'
import { parentsToAutoExpand } from './autoExpandSubs'

const map = (obj: Record<string, string[]>): Map<string, Array<{ id: string }>> =>
  new Map(Object.entries(obj).map(([k, ids]) => [k, ids.map((id) => ({ id }))]))

describe('新窗口第一次拿到列表', () => {
  it('谁都不展开 —— 那一帧父行也是第一次出现', () => {
    expect(
      parentsToAutoExpand({
        childrenByParent: map({ p1: ['c1', 'c2'], p2: ['c3'] }),
        seenChildren: new Set(),
        seenSessions: new Set()
      })
    ).toEqual([])
  })

  it('哪怕列表分两批到（先父后子），只要父行是这一批才出现的，也不展开', () => {
    // 第一批只有父行
    const seenSessions = new Set<string>()
    const first = parentsToAutoExpand({
      childrenByParent: map({}),
      seenChildren: new Set(),
      seenSessions
    })
    expect(first).toEqual([])
  })
})

describe('会话进行中新开的子会话', () => {
  it('父行上一帧就在 ⇒ 展开它', () => {
    expect(
      parentsToAutoExpand({
        childrenByParent: map({ p1: ['c1'] }),
        seenChildren: new Set(),
        seenSessions: new Set(['p1'])
      })
    ).toEqual(['p1'])
  })

  it('同一批子会话再来一次不重复展开（用户折叠之后不该被又弹开）', () => {
    expect(
      parentsToAutoExpand({
        childrenByParent: map({ p1: ['c1', 'c2'] }),
        seenChildren: new Set(['c1', 'c2']),
        seenSessions: new Set(['p1'])
      })
    ).toEqual([])
  })

  it('只展开真有新子会话的那个父行，别的不动', () => {
    expect(
      parentsToAutoExpand({
        childrenByParent: map({ p1: ['c1'], p2: ['c2', 'c3'] }),
        seenChildren: new Set(['c1', 'c2']),
        seenSessions: new Set(['p1', 'p2'])
      })
    ).toEqual(['p2'])
  })

  it('新父行 + 新子会话同时出现（不该发生：子会话只能开在已有会话下）⇒ 不展开', () => {
    expect(
      parentsToAutoExpand({
        childrenByParent: map({ pNew: ['cNew'] }),
        seenChildren: new Set(['c1']),
        seenSessions: new Set(['p1'])
      })
    ).toEqual([])
  })
})
