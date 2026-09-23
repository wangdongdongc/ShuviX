/**
 * 协作编辑的 CM6 状态层（coEditState）—— 只测状态，不挂视图（node 环境、没有 DOM）。
 *
 * 契约（coEditState.ts 文件头）：
 *   - agent 的修改不进撤销栈：⌘Z 只撤用户自己的输入，用户的历史在 agent 的改动周围映射；
 *   - agent 的修改是**一个事务**：改文字、收掉它自己的虚影、留下改动痕迹，带 remoteChange = 调用 id；
 *   - 虚影不是文档：设 / 换 / 收都不动文本与历史；锚点与目标随用户的输入映射，目标被删掉就塌成一点；
 *   - 改动痕迹随输入映射，痕迹里的字被删光就成了一道「删除」标记（空区间）；
 *   - 外部写盘的合并同样不进历史，每一处改动一条 external 痕迹，annotation 为 'external'；空改动什么都不派发。
 *
 * 假视图只有 `state` 与 `dispatch(spec)`（applyAgentChange / applyExternalChanges 只用这两样）；
 * 撤销 / 重做用 @codemirror/commands 的 undo / redo 直接驱动 state。
 *
 *   C1 用户打 X、agent 改别处、⌘Z → X 没了 agent 的字还在；⌘⇧Z → X 回来；agent 的修改不增加撤销深度
 *   C2 用户在 agent 修改之前、之后各改一处，两次 ⌘Z 只撤用户的
 *   C3 光标在目标之后 → 跟着平移；光标在被替换的范围里 → 落在 CM6 映射的位置（钉：替换段的起点），不跳到 0
 *   C4 applyAgentChange：一个事务、只收自己的虚影、带 remoteChange=id、痕迹 [from, from+insert.length]；纯删除 → 空痕迹
 *   C5 虚影：同 id 再设 → 替换；clear → 移除；锚点 / 目标随输入映射；目标被删 → 塌成一点；从不动文本与历史
 *   C6 痕迹随输入映射；痕迹里的字删光 → 空痕迹（删除标记）
 *   C7 applyExternalChanges：空改动不派发；否则每处一条 external 痕迹、annotation 'external'、不进历史
 */
import { describe, expect, it } from 'vitest'
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  Transaction,
  type TransactionSpec
} from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { history, redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import {
  applyAgentChange,
  applyExternalChanges,
  changeMarkField,
  clearGhost,
  ghostField,
  remoteChange,
  setGhost,
  type Ghost
} from '../coEditState'

/** 一个只有 state / dispatch 的假视图；记下每一次派发的事务 */
interface FakeView {
  state: EditorState
  dispatch(spec: TransactionSpec): void
  transactions: Transaction[]
  /** 按用户的方式改文字（进历史），time 拉开间隔免得和上一次合成一组 */
  type(from: number, to: number, insert: string): void
  undo(): boolean
  redo(): boolean
  text(): string
  asView(): EditorView
}

let clock = 1_000_000

function fakeView(doc: string, cursor?: number): FakeView {
  let state = EditorState.create({
    doc,
    selection: cursor === undefined ? undefined : EditorSelection.cursor(cursor),
    extensions: [history(), ghostField, changeMarkField]
  })
  const transactions: Transaction[] = []
  const target = {
    get state() {
      return state
    },
    dispatch: (tr: Transaction) => {
      state = tr.state
    }
  }
  const view: FakeView = {
    get state() {
      return state
    },
    set state(s) {
      state = s
    },
    transactions,
    dispatch(spec) {
      const tr = state.update(spec)
      transactions.push(tr)
      state = tr.state
    },
    type(from, to, insert) {
      clock += 5_000
      const tr = state.update({
        changes: { from, to, insert },
        selection: EditorSelection.cursor(from + insert.length),
        userEvent: 'input.type',
        annotations: Transaction.time.of(clock)
      })
      state = tr.state
    },
    undo: () => undo(target),
    redo: () => redo(target),
    text: () => state.doc.toString(),
    asView: () => view as unknown as EditorView
  }
  return view
}

const ghosts = (v: FakeView): readonly Ghost[] => v.state.field(ghostField)
const marks = (v: FakeView): Array<{ origin: string; from: number; to: number }> =>
  v.state.field(changeMarkField).map((m) => ({ origin: m.origin, from: m.from, to: m.to }))

describe('C1 / C2 撤销分开', () => {
  it('C1 用户打 X、agent 改别处、⌘Z → 只撤 X；⌘⇧Z → X 回来；agent 的修改不增加撤销深度', () => {
    const v = fakeView('hello world\nsecond line\n')
    v.type(5, 5, ' X')
    expect(v.text()).toBe('hello X world\nsecond line\n')
    const depth = undoDepth(v.state)
    expect(depth).toBe(1)

    // agent 改第二行
    const at = v.text().indexOf('second')
    applyAgentChange(v.asView(), { id: 'tc1', from: at, to: at + 6, insert: 'AGENT' })
    expect(v.text()).toBe('hello X world\nAGENT line\n')
    expect(undoDepth(v.state)).toBe(depth)

    expect(v.undo()).toBe(true)
    expect(v.text()).toBe('hello world\nAGENT line\n')
    expect(undoDepth(v.state)).toBe(0)
    // 没有更多可撤的：agent 的修改不在栈上
    expect(v.undo()).toBe(false)
    expect(v.text()).toBe('hello world\nAGENT line\n')

    expect(redoDepth(v.state)).toBe(1)
    expect(v.redo()).toBe(true)
    expect(v.text()).toBe('hello X world\nAGENT line\n')
  })

  it('C2 用户在 agent 修改之前、之后各改一处 → 两次 ⌘Z 只撤用户的，agent 的字留着', () => {
    const v = fakeView('aaa bbb ccc')
    v.type(0, 0, 'U0 ')
    const at = v.text().indexOf('bbb')
    applyAgentChange(v.asView(), { id: 'tc', from: at, to: at + 3, insert: 'AGENT-B' })
    v.type(v.text().length, v.text().length, ' U1')
    expect(v.text()).toBe('U0 aaa AGENT-B ccc U1')
    expect(undoDepth(v.state)).toBe(2)

    v.undo()
    expect(v.text()).toBe('U0 aaa AGENT-B ccc')
    v.undo()
    expect(v.text()).toBe('aaa AGENT-B ccc')
    expect(v.undo()).toBe(false)
    expect(v.text()).toBe('aaa AGENT-B ccc')
  })
})

describe('C3 光标', () => {
  it('光标在目标之后 → 跟着平移', () => {
    const v = fakeView('0123456789 tail', 13)
    applyAgentChange(v.asView(), { id: 'tc', from: 2, to: 4, insert: 'LONGER' })
    expect(v.text()).toBe('01LONGER456789 tail')
    expect(v.state.selection.main.head).toBe(13 + 4)
  })

  it('光标在目标之前 → 不动', () => {
    const v = fakeView('0123456789 tail', 1)
    applyAgentChange(v.asView(), { id: 'tc', from: 2, to: 4, insert: 'LONGER' })
    expect(v.state.selection.main.head).toBe(1)
  })

  it('光标在被替换的范围里 → 落在替换段的起点（CM6 的映射），不跳到 0', () => {
    const v = fakeView('abc DEFGH ijk', 6)
    applyAgentChange(v.asView(), { id: 'tc', from: 4, to: 9, insert: 'new text' })
    expect(v.text()).toBe('abc new text ijk')
    const head = v.state.selection.main.head
    expect(head).toBe(4)
    expect(head).not.toBe(0)
  })
})

describe('C4 applyAgentChange', () => {
  it('一个事务：改文字、只收自己的虚影、带 remoteChange=id、不进历史、痕迹盖住新字', () => {
    const v = fakeView('one two three')
    v.dispatch({
      effects: [
        setGhost.of({ id: 'a', anchor: 3, above: false, text: 'x', mode: 'rewriting' }),
        setGhost.of({ id: 'b', anchor: 7, above: false, text: 'y', mode: 'writing' })
      ]
    })
    v.transactions.length = 0

    applyAgentChange(v.asView(), { id: 'a', from: 4, to: 7, insert: 'TWO!' })

    expect(v.transactions).toHaveLength(1)
    const tr = v.transactions[0]
    expect(tr.annotation(remoteChange)).toBe('a')
    expect(tr.annotation(Transaction.addToHistory)).toBe(false)
    expect(v.text()).toBe('one TWO! three')
    expect(ghosts(v).map((g) => g.id)).toEqual(['b'])
    const ms = marks(v)
    expect(ms).toHaveLength(1)
    expect(ms[0]).toEqual({ origin: 'agent', from: 4, to: 8 })
    expect(v.text().slice(ms[0].from, ms[0].to)).toBe('TWO!')
  })

  it('纯删除 → 一条空痕迹（删除标记）落在删除处', () => {
    const v = fakeView('keep DROP keep')
    applyAgentChange(v.asView(), { id: 'd', from: 5, to: 10, insert: '' })
    expect(v.text()).toBe('keep keep')
    expect(marks(v)).toEqual([{ origin: 'agent', from: 5, to: 5 }])
  })

  it('插入（from == to）→ 痕迹就是插进来的那段', () => {
    const v = fakeView('ab')
    applyAgentChange(v.asView(), { id: 'i', from: 1, to: 1, insert: '\n\nNEW' })
    expect(v.text()).toBe('a\n\nNEWb')
    expect(marks(v)).toEqual([{ origin: 'agent', from: 1, to: 6 }])
  })
})

describe('C5 虚影', () => {
  const ghost = (over: Partial<Ghost> = {}): Ghost => ({
    id: 'g',
    target: { from: 10, to: 15 },
    anchor: 15,
    above: false,
    text: 'draft',
    mode: 'rewriting',
    ...over
  })

  it('同 id 再设 → 替换（不叠两个）；clear → 移除；别的 id 不受影响', () => {
    const v = fakeView('0123456789ABCDEFGHIJ')
    v.dispatch({ effects: setGhost.of(ghost({ text: 'first' })) })
    v.dispatch({ effects: setGhost.of(ghost({ text: 'second', mode: 'waiting' })) })
    v.dispatch({ effects: setGhost.of(ghost({ id: 'other', target: undefined, anchor: 3 })) })
    expect(ghosts(v).filter((g) => g.id === 'g')).toHaveLength(1)
    expect(ghosts(v).find((g) => g.id === 'g')).toMatchObject({ text: 'second', mode: 'waiting' })

    v.dispatch({ effects: clearGhost.of('g') })
    expect(ghosts(v).map((g) => g.id)).toEqual(['other'])
    // 收一个不存在的 id：什么也不发生
    v.dispatch({ effects: clearGhost.of('nope') })
    expect(ghosts(v).map((g) => g.id)).toEqual(['other'])
  })

  it('虚影从不动文本与历史', () => {
    const v = fakeView('0123456789ABCDEFGHIJ')
    v.type(0, 0, 'u')
    const before = v.text()
    const depth = undoDepth(v.state)
    v.dispatch({ effects: setGhost.of(ghost()) })
    v.dispatch({ effects: setGhost.of(ghost({ text: 'longer draft' })) })
    v.dispatch({ effects: clearGhost.of('g') })
    expect(v.text()).toBe(before)
    expect(undoDepth(v.state)).toBe(depth)
    // ⌘Z 撤的仍是用户那一下，不是虚影
    v.undo()
    expect(v.text()).toBe('0123456789ABCDEFGHIJ')
  })

  it('锚点 / 目标随用户的输入映射（在它之前打字 → 平移；在它之后 → 不动）', () => {
    const v = fakeView('0123456789ABCDEFGHIJ')
    v.dispatch({ effects: setGhost.of(ghost()) })
    v.type(2, 2, 'xyz')
    expect(ghosts(v)[0]).toMatchObject({ target: { from: 13, to: 18 }, anchor: 18 })
    v.type(v.text().length, v.text().length, 'tail')
    expect(ghosts(v)[0]).toMatchObject({ target: { from: 13, to: 18 }, anchor: 18 })
  })

  it('目标被用户删掉 → 塌成一点（from == to）', () => {
    const v = fakeView('0123456789ABCDEFGHIJ')
    v.dispatch({ effects: setGhost.of(ghost()) })
    v.type(8, 17, '')
    const g = ghosts(v)[0]
    expect(g.target!.from).toBe(g.target!.to)
    expect(g.target!.from).toBe(8)
  })

  it('above 的锚点（doc_insert 的 before）在锚点处的插入之后仍挂在前面', () => {
    const v = fakeView('line one\nline two')
    v.dispatch({
      effects: setGhost.of(ghost({ target: undefined, anchor: 9, above: true, mode: 'writing' }))
    })
    v.type(9, 9, 'NEW ')
    // above → 映射偏向左边：锚点停在插入之前
    expect(ghosts(v)[0].anchor).toBe(9)
  })
})

describe('C6 改动痕迹', () => {
  it('随输入映射：在痕迹之前打字 → 平移；在痕迹里打字 → 扩进去', () => {
    const v = fakeView('0123456789')
    applyAgentChange(v.asView(), { id: 'a', from: 4, to: 6, insert: 'AB' })
    expect(marks(v)).toEqual([{ origin: 'agent', from: 4, to: 6 }])
    v.type(0, 0, '++')
    expect(marks(v)).toEqual([{ origin: 'agent', from: 6, to: 8 }])
    v.type(7, 7, 'z')
    expect(marks(v)).toEqual([{ origin: 'agent', from: 6, to: 9 }])
  })

  it('痕迹里的字被删光 → 空痕迹（删除标记）', () => {
    const v = fakeView('0123456789')
    applyAgentChange(v.asView(), { id: 'a', from: 4, to: 6, insert: 'ABC' })
    v.type(3, 8, '')
    const [m] = marks(v)
    expect(m.from).toBe(m.to)
    expect(m.from).toBe(3)
  })
})

describe('C7 applyExternalChanges', () => {
  it('空改动 → 什么都不派发', () => {
    const v = fakeView('same text')
    applyExternalChanges(v.asView(), ChangeSet.empty(v.state.doc.length))
    expect(v.transactions).toHaveLength(0)
  })

  it('每处改动一条 external 痕迹、annotation 为 external、不进历史', () => {
    const v = fakeView('one two three four')
    v.type(0, 0, 'U ')
    const depth = undoDepth(v.state)
    // 'U one two three four'：two → TWO，four → 4!
    const text = v.text()
    const changes = ChangeSet.of(
      [
        { from: text.indexOf('two'), to: text.indexOf('two') + 3, insert: 'TWO' },
        { from: text.indexOf('four'), to: text.indexOf('four') + 4, insert: '4!' }
      ],
      text.length
    )
    applyExternalChanges(v.asView(), changes)

    expect(v.transactions).toHaveLength(1)
    const tr = v.transactions[0]
    expect(tr.annotation(remoteChange)).toBe('external')
    expect(tr.annotation(Transaction.addToHistory)).toBe(false)
    expect(v.text()).toBe('U one TWO three 4!')
    expect(undoDepth(v.state)).toBe(depth)
    const ms = marks(v)
    expect(ms.map((m) => m.origin)).toEqual(['external', 'external'])
    expect(ms.map((m) => v.text().slice(m.from, m.to))).toEqual(['TWO', '4!'])

    // ⌘Z 撤的是用户那一下，外部的改动留着
    v.undo()
    expect(v.text()).toBe('one TWO three 4!')
  })
})
