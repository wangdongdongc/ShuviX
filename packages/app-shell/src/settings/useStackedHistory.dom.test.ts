// @vitest-environment jsdom
/**
 * useStackedHistory(enabled, depth, onPopTo) —— 叠放设置的层数接到浏览器历史上（jsdom）。
 *
 * 契约：`depth` 变深一层压一条，带 `shuvixSettingsDepth: <层数>` 并保留那一条上已有的记号；`depth` 变浅而历史
 * 此刻停在这里压的那一条上 → `history.go(-n)`（一次）；返回手势（popstate）落到比此刻浅的一条 → `onPopTo(层数)`。
 * 挂上那一刻的层数是基线，基线以内不压也不退。挂上时当前条目上留着比基线深的旧记号（重新加载留下的）→ 摘掉。
 *
 *   SH-1  深度 0 挂上：不压、不动 state、不调 onPopTo
 *   SH-2 / SH-3 / SH-4  0→1、1→2、0→2：各压几条、记号是几、别的记号留着
 *   SH-5 / SH-6  重渲染变浅（顶栏的返回键那条路）：go(-1) / go(-2) 各一次，popstate 回来不再调 onPopTo
 *   SH-7 / SH-8  返回手势：onPopTo(浅的那一层) 一次；之后宿主重渲染到那一层不再退一次
 *   SH-9 / SH-10 基线（挂上就在第 1 层）：基线以内不压不退，基线以上照常
 *   SH-11 变浅时当前条目不带我们的记号：不退
 *   SH-12 enabled = false：什么都不做
 *   SH-13 onPopTo 用最新的那个；SH-14 卸载后不再响应
 *   SH-15 popstate 落在记号 ≥ 此刻层数的条目上：不调
 *   SH-16 记号不是数字 → 当 0
 *   SH-17 退到 0 之后浏览器「前进」：不调、不抛（已知的弱点，钉住现状）
 *   SH-23 连着两次变浅（第一次回退还没落地）：一共只退两条
 *   SH-18..22 挂上时摘掉留在当前条目上的旧记号（B2）：别的记号留着、空了就是 null；基线以内的记号、
 *         enabled = false 都不动；摘掉之后 0→1 压一条、返回手势 → onPopTo(0)
 *
 * jsdom 的 history.back() / go() 异步发 popstate：凡是会退历史的动作都在 `awaitPop` 里等到它。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { STACKED_SETTINGS_HISTORY_MARK, useStackedHistory } from './useStackedHistory'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const MARK = STACKED_SETTINGS_HISTORY_MARK

interface HarnessProps {
  enabled: boolean
  depth: number
  onPopTo: (depth: number) => void
}

function H(p: HarnessProps): null {
  useStackedHistory(p.enabled, p.depth, p.onPopTo)
  return null
}

let container: HTMLDivElement
let root: Root
let mounted: boolean

function render(depth: number, onPopTo: (depth: number) => void, enabled = true): void {
  mounted = true
  act(() => root.render(createElement(H, { enabled, depth, onPopTo })))
}

const state = (): Record<string, unknown> | null =>
  window.history.state as Record<string, unknown> | null

/**
 * 做一件会退 / 进一条历史的事，等到 popstate（jsdom 异步发）。`trigger` 在 act 外面跑（它自己可以是一次
 * `render`：套在外层的异步 act 里，里层 act 的 effect 要等外层结束才跑，而外层在等 effect 触发的 popstate）
 */
async function awaitPop(trigger: () => void): Promise<void> {
  const popped = new Promise<void>((resolve) => {
    window.addEventListener('popstate', () => resolve(), { once: true })
  })
  trigger()
  await act(async () => {
    await popped
  })
}
const back = (): Promise<void> => awaitPop(() => window.history.back())
/** 不动历史，只发一个 popstate */
const firePop = (): void => {
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
}

beforeEach(() => {
  window.history.replaceState(null, '')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = false
})

afterEach(async () => {
  if (mounted) act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  // 万一还有没落地的历史跳转：别让它落进下一条用例
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('useStackedHistory: pushing as the depth grows', () => {
  it('SH-1 mounting at depth 0 pushes nothing, leaves the state alone and calls nothing', () => {
    const push = vi.spyOn(window.history, 'pushState')
    const onPopTo = vi.fn()
    render(0, onPopTo)
    expect(push).not.toHaveBeenCalled()
    expect(state()).toBeNull()
    expect(onPopTo).not.toHaveBeenCalled()
  })

  it('SH-2 0 → 1 pushes one entry marked 1 that keeps the marks already there', () => {
    window.history.replaceState({ foo: true }, '')
    const onPopTo = vi.fn()
    render(0, onPopTo)
    const push = vi.spyOn(window.history, 'pushState')
    render(1, onPopTo)
    expect(push).toHaveBeenCalledTimes(1)
    expect(state()).toEqual({ foo: true, [MARK]: 1 })
    expect(onPopTo).not.toHaveBeenCalled()
  })

  it('SH-3 1 → 2 pushes one more entry marked 2, other marks still there', () => {
    window.history.replaceState({ foo: true }, '')
    const onPopTo = vi.fn()
    render(0, onPopTo)
    render(1, onPopTo)
    const push = vi.spyOn(window.history, 'pushState')
    render(2, onPopTo)
    expect(push).toHaveBeenCalledTimes(1)
    expect(state()).toEqual({ foo: true, [MARK]: 2 })
  })

  it('SH-4 0 → 2 in one re-render pushes two entries, marked 1 then 2', () => {
    const onPopTo = vi.fn()
    render(0, onPopTo)
    const push = vi.spyOn(window.history, 'pushState')
    render(2, onPopTo)
    expect(push).toHaveBeenCalledTimes(2)
    expect(push.mock.calls.map(([s]) => (s as Record<string, unknown>)[MARK])).toEqual([1, 2])
    expect(state()).toEqual({ [MARK]: 2 })
  })
})

describe('useStackedHistory: the depth lowered by a re-render (the back button)', () => {
  it('SH-5 1 → 0 on the pushed entry: go(-1) once; after the pop no mark and no onPopTo', async () => {
    const onPopTo = vi.fn()
    render(0, onPopTo)
    render(1, onPopTo)
    const go = vi.spyOn(window.history, 'go')
    await awaitPop(() => render(0, onPopTo))
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-1)
    expect(state()?.[MARK]).toBeUndefined()
    expect(onPopTo).not.toHaveBeenCalled()
  })

  it('SH-6 2 → 1 goes back one entry', async () => {
    const onPopTo = vi.fn()
    render(0, onPopTo)
    render(2, onPopTo)
    const go = vi.spyOn(window.history, 'go')
    await awaitPop(() => render(1, onPopTo))
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-1)
    expect(state()).toEqual({ [MARK]: 1 })
    expect(onPopTo).not.toHaveBeenCalled()
  })

  it('SH-6 2 → 0 goes back two entries in one call', async () => {
    const onPopTo = vi.fn()
    render(0, onPopTo)
    render(2, onPopTo)
    const go = vi.spyOn(window.history, 'go')
    await awaitPop(() => render(0, onPopTo))
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-2)
    expect(state()).toBeNull()
    expect(onPopTo).not.toHaveBeenCalled()
  })

  it('SH-23 two drops before the first traversal lands ask for two entries in total, not three', async () => {
    const onPopTo = vi.fn()
    render(0, onPopTo)
    render(2, onPopTo)
    const go = vi.spyOn(window.history, 'go')
    // 两次连着变浅（连按两次返回键，快过浏览器的回退）：第二次渲染时 history.state 还停在第 2 层的条目上
    await awaitPop(() => {
      render(1, onPopTo)
      render(0, onPopTo)
    })
    // 第二次回退的 popstate 也等到
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(go.mock.calls).toEqual([[-1], [-1]])
    expect(onPopTo).not.toHaveBeenCalled()
  })

  it('SH-11 lowering the depth while the current entry does not carry the mark does not navigate', () => {
    const onPopTo = vi.fn()
    render(0, onPopTo)
    render(1, onPopTo)
    window.history.replaceState({ other: true }, '')
    const go = vi.spyOn(window.history, 'go')
    const historyBack = vi.spyOn(window.history, 'back')
    render(0, onPopTo)
    expect(go).not.toHaveBeenCalled()
    expect(historyBack).not.toHaveBeenCalled()
    expect(state()).toEqual({ other: true })
  })
})

describe('useStackedHistory: the back gesture', () => {
  it('SH-7 back at depth 1 → onPopTo(0) once; the host re-rendering at 0 does not pop again', async () => {
    const onPopTo = vi.fn()
    render(0, onPopTo)
    render(1, onPopTo)
    await back()
    expect(onPopTo).toHaveBeenCalledTimes(1)
    expect(onPopTo).toHaveBeenCalledWith(0)

    const go = vi.spyOn(window.history, 'go')
    const historyBack = vi.spyOn(window.history, 'back')
    render(0, onPopTo)
    expect(go).not.toHaveBeenCalled()
    expect(historyBack).not.toHaveBeenCalled()
    expect(onPopTo).toHaveBeenCalledTimes(1)
  })

  it('SH-8 back at depth 2 → onPopTo(1) once', async () => {
    const onPopTo = vi.fn()
    render(0, onPopTo)
    render(2, onPopTo)
    await back()
    expect(onPopTo).toHaveBeenCalledTimes(1)
    expect(onPopTo).toHaveBeenCalledWith(1)
  })

  it('SH-8 history.go(-2) at depth 2 → onPopTo(0) once', async () => {
    const onPopTo = vi.fn()
    render(0, onPopTo)
    render(2, onPopTo)
    await awaitPop(() => window.history.go(-2))
    expect(onPopTo).toHaveBeenCalledTimes(1)
    expect(onPopTo).toHaveBeenCalledWith(0)
  })

  it('SH-13 the latest onPopTo is the one called', async () => {
    const first = vi.fn()
    const latest = vi.fn()
    render(0, first)
    render(1, first)
    render(1, latest)
    await back()
    expect(latest).toHaveBeenCalledTimes(1)
    expect(latest).toHaveBeenCalledWith(0)
    expect(first).not.toHaveBeenCalled()
  })

  it('SH-14 after unmount a popstate calls nothing', async () => {
    const onPopTo = vi.fn()
    render(0, onPopTo)
    render(1, onPopTo)
    act(() => root.unmount())
    mounted = false
    await back()
    firePop()
    expect(onPopTo).not.toHaveBeenCalled()
  })

  it('SH-15 a popstate on an entry whose mark is not below the current depth calls nothing', () => {
    const onPopTo = vi.fn()
    render(0, onPopTo)
    render(1, onPopTo)
    expect(state()).toEqual({ [MARK]: 1 })
    firePop()
    expect(onPopTo).not.toHaveBeenCalled()
  })

  it.each<[string, unknown]>([
    ['a string', '1'],
    ['a boolean', true]
  ])('SH-16 a mark that is %s reads as 0', (_label, value) => {
    const onPopTo = vi.fn()
    render(0, onPopTo)
    render(1, onPopTo)
    window.history.replaceState({ [MARK]: value }, '')
    firePop()
    expect(onPopTo).toHaveBeenCalledTimes(1)
    expect(onPopTo).toHaveBeenCalledWith(0)
  })

  it('SH-17 after going back to 0, the browser’s forward calls nothing and throws nothing', async () => {
    const onPopTo = vi.fn()
    render(0, onPopTo)
    render(1, onPopTo)
    await back()
    render(0, onPopTo)
    onPopTo.mockClear()
    await awaitPop(() => window.history.forward())
    // 已知的弱点：历史回到了记号 1 的那一条，界面还在列表上
    expect(state()).toEqual({ [MARK]: 1 })
    expect(onPopTo).not.toHaveBeenCalled()
  })
})

describe('useStackedHistory: the baseline (mounted below the list)', () => {
  it('SH-9 mounted at depth 1: nothing is pushed or popped within the baseline; above it works as usual', async () => {
    const onPopTo = vi.fn()
    const push = vi.spyOn(window.history, 'pushState')
    const go = vi.spyOn(window.history, 'go')
    render(1, onPopTo)
    expect(push).not.toHaveBeenCalled()

    render(0, onPopTo)
    expect(go).not.toHaveBeenCalled()

    // 基线以内从不压：回到列表再进分区也不压（B4：独立设置页的基线，有意如此）
    render(1, onPopTo)
    expect(push).not.toHaveBeenCalled()

    render(2, onPopTo)
    expect(push).toHaveBeenCalledTimes(1)
    expect(state()).toEqual({ [MARK]: 2 })

    // 退回到的那一条没有记号，但基线是 1 → 退到第 1 层，不是 0
    await back()
    expect(onPopTo).toHaveBeenCalledTimes(1)
    expect(onPopTo).toHaveBeenCalledWith(1)
    expect(go).not.toHaveBeenCalled()
  })

  it('SH-9 mounted at depth 1, 2 → 1 by re-render goes back one entry', async () => {
    const onPopTo = vi.fn()
    render(1, onPopTo)
    render(2, onPopTo)
    const go = vi.spyOn(window.history, 'go')
    await awaitPop(() => render(1, onPopTo))
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-1)
    expect(state()).toBeNull()
    expect(onPopTo).not.toHaveBeenCalled()
  })

  it('SH-10 mounted at depth 1, a popstate landing on an unmarked entry calls nothing', () => {
    const onPopTo = vi.fn()
    render(1, onPopTo)
    window.history.replaceState(null, '')
    firePop()
    expect(onPopTo).not.toHaveBeenCalled()
  })
})

describe('useStackedHistory: disabled', () => {
  it('SH-12 enabled = false: no push on increase, no go on decrease, a popstate calls nothing', () => {
    const onPopTo = vi.fn()
    const push = vi.spyOn(window.history, 'pushState')
    const go = vi.spyOn(window.history, 'go')
    const historyBack = vi.spyOn(window.history, 'back')
    render(0, onPopTo, false)
    render(2, onPopTo, false)
    expect(push).not.toHaveBeenCalled()
    expect(state()).toBeNull()

    // 就算当前条目带着记号也不退
    window.history.replaceState({ [MARK]: 2 }, '')
    render(0, onPopTo, false)
    expect(go).not.toHaveBeenCalled()
    expect(historyBack).not.toHaveBeenCalled()

    render(2, onPopTo, false)
    window.history.replaceState(null, '')
    firePop()
    expect(onPopTo).not.toHaveBeenCalled()
  })
})

describe('useStackedHistory: a mark left on the current entry by a reload (B2)', () => {
  it('SH-18 a leftover mark deeper than the mount depth is removed; an otherwise empty state becomes null', () => {
    window.history.replaceState({ [MARK]: 1 }, '')
    const push = vi.spyOn(window.history, 'pushState')
    render(0, vi.fn())
    expect(state()).toBeNull()
    expect(push).not.toHaveBeenCalled()
  })

  it('SH-19 the other keys on the state are kept', () => {
    window.history.replaceState({ foo: true, [MARK]: 2 }, '')
    render(0, vi.fn())
    expect(state()).toEqual({ foo: true })
  })

  it('SH-20 a mark within the mount depth is left alone', () => {
    window.history.replaceState({ [MARK]: 1 }, '')
    const replace = vi.spyOn(window.history, 'replaceState')
    render(1, vi.fn())
    expect(replace).not.toHaveBeenCalled()
    expect(state()).toEqual({ [MARK]: 1 })
  })

  it('SH-21 enabled = false leaves the leftover mark alone', () => {
    window.history.replaceState({ [MARK]: 1 }, '')
    const replace = vi.spyOn(window.history, 'replaceState')
    render(0, vi.fn(), false)
    expect(replace).not.toHaveBeenCalled()
    expect(state()).toEqual({ [MARK]: 1 })
  })

  it('SH-22 after the strip, 0 → 1 pushes and the back gesture returns to 0', async () => {
    window.history.replaceState({ [MARK]: 1 }, '')
    const onPopTo = vi.fn()
    render(0, onPopTo)
    const push = vi.spyOn(window.history, 'pushState')
    render(1, onPopTo)
    expect(push).toHaveBeenCalledTimes(1)
    expect(state()).toEqual({ [MARK]: 1 })

    await back()
    expect(state()).toBeNull()
    expect(onPopTo).toHaveBeenCalledTimes(1)
    expect(onPopTo).toHaveBeenCalledWith(0)
  })
})
