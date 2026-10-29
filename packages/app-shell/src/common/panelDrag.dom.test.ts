// @vitest-environment jsdom
/**
 * startPanelDrag —— 面板分隔条的拖拽手势（右侧面板、会话面板、左侧栏、底部终端共用；jsdom）。
 *
 * 契约：delta = 指针此刻的坐标 − 按下那一点（x 向右为正，y 向下为正），各调用方自己定正负与钳制；拖动期间整窗盖一层
 * 透明遮罩（`[data-panel-drag-overlay]`，最顶层、带拖拽光标），指针下面只有它，iframe 吞不走 mousemove / mouseup；
 * 结束恰好一次（mouseup、一次发现左键已松开的 mousemove、窗口失焦），收走遮罩与 window 上的监听，body 的
 * cursor / userSelect 还原成按下之前的值（不是清空）；只有左键开始拖动，左键按下会 preventDefault。
 *
 *   PD-1  x 轴：window mousemove (130,250) → onMove(30)；(70,999) → onMove(-30)（只看 x）
 *   PD-2  y 轴：(140,180) → -20；(100,260) → 60（只看 y）
 *   PD-3  遮罩：开始前没有；开始后恰好一个，是 body 的最后一个子节点（排在一个事先就在的 fixed + z-index 9999 兄弟之后），
 *         position fixed、inset 0、z-index > 9999、光标 col-resize（x）/ row-resize（y）、pointer-events 不是 none
 *   PD-4  body：事先 cursor=help、userSelect=text；拖动中 = 拖拽光标 + none；结束后还原成 help / text
 *   PD-5  mouseup（在内层元素上派发、冒泡上来；以及直接派发在遮罩上）：onEnd 一次、遮罩没了、之后按着左键的 move 不再
 *         onMove、再来一次 mouseup 不再 onEnd
 *   PD-6  buttons=0 的 move：onEnd 一次，这一次 move 不 onMove，之后的 move 什么都不做
 *   PD-7  buttons=2（只按着右键）的 move：同样算左键已松开 → 结束
 *   PD-8  window blur：与 PD-5 同样的事后状态
 *   PD-9  mouseup、再 blur、再 buttons=0 的 move：onEnd 总共一次，0 个遮罩，什么都不抛
 *   PD-10 中键 / 右键按下：没有遮罩、body 不动、defaultPrevented 为 false，之后的 move / up 不调任何回调；
 *         交回的函数什么也不做
 *   PD-11 window 的 add/removeEventListener 间谍：开始时加上的每个监听，在三条结束路径上都以同一个函数被摘掉
 *   PD-12 左键按下 → defaultPrevented 为 true
 *   PD-13 调交回的结束函数：结束一次（onEnd 一次、遮罩没了）；再调一次什么也不做
 *
 * 开始事件一律 `new MouseEvent('mousedown', { button: 0, buttons: 1, clientX: 100, clientY: 200 })`（加 cancelable，
 * 否则 preventDefault 无从观察）。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { startPanelDrag } from './panelDrag'

const OVERLAY = '[data-panel-drag-overlay]'

function down(button = 0, buttons = 1): MouseEvent {
  return new MouseEvent('mousedown', {
    button,
    buttons,
    clientX: 100,
    clientY: 200,
    cancelable: true,
    bubbles: true
  })
}

function move(x: number, y: number, buttons = 1): void {
  window.dispatchEvent(
    new MouseEvent('mousemove', { clientX: x, clientY: y, buttons, bubbles: true })
  )
}

function up(target: EventTarget = window): void {
  target.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0, bubbles: true }))
}

function blur(): void {
  window.dispatchEvent(new Event('blur'))
}

const overlays = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(OVERLAY)]

let onMove: Mock<(delta: number) => void>
let onEnd: Mock<() => void>
let end: (() => void) | null = null

function start(axis: 'x' | 'y' = 'x', e: MouseEvent = down()): () => void {
  end = startPanelDrag(e, { axis, onMove, onEnd })
  return end
}

/** inset 0：jsdom 认 `inset` 简写（读回 '0'）；换一种实现写成四边也算 */
function insetZero(el: HTMLElement): boolean {
  const s = el.style
  if (s.inset === '0' || s.inset === '0px') return true
  return [s.top, s.right, s.bottom, s.left].every((v) => v === '0' || v === '0px')
}

beforeEach(() => {
  onMove = vi.fn<(delta: number) => void>()
  onEnd = vi.fn<() => void>()
  document.body.innerHTML = ''
  document.body.removeAttribute('style')
})

afterEach(() => {
  end?.()
  end = null
  vi.restoreAllMocks()
})

describe('delta', () => {
  it('PD-1 x axis: delta = clientX − start x, y ignored', () => {
    start('x')
    move(130, 250)
    move(70, 999)
    expect(onMove.mock.calls).toEqual([[30], [-30]])
  })

  it('PD-2 y axis: delta = clientY − start y, x ignored', () => {
    start('y')
    move(140, 180)
    move(100, 260)
    expect(onMove.mock.calls).toEqual([[-20], [60]])
  })
})

describe('overlay and body', () => {
  it.each([
    ['x', 'col-resize'],
    ['y', 'row-resize']
  ] as const)(
    'PD-3 (%s) one fixed full-window overlay above everything, last in body',
    (axis, cursor) => {
      const sibling = document.createElement('div')
      sibling.style.cssText = 'position:fixed;z-index:9999;inset:0;'
      document.body.appendChild(sibling)
      expect(overlays()).toHaveLength(0)

      start(axis)
      const list = overlays()
      expect(list).toHaveLength(1)
      const overlay = list[0]
      expect(document.body.lastElementChild).toBe(overlay)
      expect(overlay.previousElementSibling).toBe(sibling)
      expect(overlay.style.position).toBe('fixed')
      expect(insetZero(overlay)).toBe(true)
      expect(Number(overlay.style.zIndex)).toBeGreaterThan(9999)
      expect(overlay.style.cursor).toBe(cursor)
      expect(getComputedStyle(overlay).pointerEvents).not.toBe('none')
    }
  )

  it.each([
    ['x', 'col-resize'],
    ['y', 'row-resize']
  ] as const)(
    'PD-4 (%s) body cursor / user-select during the drag, restored after',
    (axis, cursor) => {
      document.body.style.cursor = 'help'
      document.body.style.userSelect = 'text'
      start(axis)
      expect(document.body.style.cursor).toBe(cursor)
      expect(document.body.style.userSelect).toBe('none')
      up()
      expect(document.body.style.cursor).toBe('help')
      expect(document.body.style.userSelect).toBe('text')
    }
  )
})

describe('ending', () => {
  /** 一条结束路径走完之后的共同状态（PD-5 / PD-8） */
  function expectEnded(): void {
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(overlays()).toHaveLength(0)
    const before = onMove.mock.calls.length
    move(150, 200)
    expect(onMove).toHaveBeenCalledTimes(before)
    up()
    expect(onEnd).toHaveBeenCalledTimes(1)
  }

  it('PD-5 mouseup bubbling from an inner element ends the drag once', () => {
    const inner = document.createElement('span')
    const outer = document.createElement('div')
    outer.appendChild(inner)
    document.body.appendChild(outer)
    start('x')
    move(110, 200)
    expect(onMove.mock.calls).toEqual([[10]])
    up(inner)
    expectEnded()
  })

  it('PD-5 mouseup on the overlay itself ends the drag once', () => {
    start('x')
    up(overlays()[0])
    expectEnded()
  })

  it('PD-6 a move with the left button released ends without reporting that move', () => {
    start('x')
    move(120, 200)
    move(160, 200, 0)
    expect(onMove.mock.calls).toEqual([[20]])
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(overlays()).toHaveLength(0)
    move(170, 200, 1)
    move(180, 200, 0)
    expect(onMove.mock.calls).toEqual([[20]])
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('PD-7 a move with only the right button held counts as the left one released', () => {
    start('x')
    move(130, 200, 2)
    expect(onMove).not.toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(overlays()).toHaveLength(0)
  })

  it('PD-8 window blur ends the drag once', () => {
    start('x')
    blur()
    expectEnded()
  })

  it('PD-9 mouseup, then blur, then a released move: one onEnd in total, nothing throws', () => {
    start('x')
    expect(() => {
      up()
      blur()
      move(140, 200, 0)
    }).not.toThrow()
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(overlays()).toHaveLength(0)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('PD-13 the returned function ends the drag once; calling it again does nothing', () => {
    const stop = start('y')
    stop()
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(overlays()).toHaveLength(0)
    stop()
    expect(onEnd).toHaveBeenCalledTimes(1)
    move(100, 250)
    expect(onMove).not.toHaveBeenCalled()
  })
})

describe('which button', () => {
  it.each([
    [1, 4],
    [2, 2]
  ])('PD-10 button %i: nothing starts, nothing is prevented', (button, buttons) => {
    document.body.style.cursor = 'help'
    document.body.style.userSelect = 'text'
    const e = down(button, buttons)
    const stop = start('x', e)
    expect(overlays()).toHaveLength(0)
    expect(document.body.style.cursor).toBe('help')
    expect(document.body.style.userSelect).toBe('text')
    expect(e.defaultPrevented).toBe(false)
    move(130, 200, buttons)
    move(140, 200, 1)
    up()
    blur()
    expect(() => stop()).not.toThrow()
    expect(onMove).not.toHaveBeenCalled()
    expect(onEnd).not.toHaveBeenCalled()
    expect(overlays()).toHaveLength(0)
  })

  it('PD-12 a left-button mousedown is preventDefault-ed', () => {
    const e = down()
    start('x', e)
    expect(e.defaultPrevented).toBe(true)
  })
})

describe('listeners', () => {
  it.each([
    ['mouseup', () => up()],
    ['released move', () => move(150, 200, 0)],
    ['blur', () => blur()]
  ] as const)('PD-11 every window listener added at start is removed (%s)', (_path, finish) => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    start('x')
    const added = add.mock.calls.map(([type, fn]) => [type, fn] as const)
    expect(added.length).toBeGreaterThan(0)
    expect(remove).not.toHaveBeenCalled()
    finish()
    const removed = remove.mock.calls.map(([type, fn]) => [type, fn] as const)
    for (const [type, fn] of added) {
      expect(
        removed.some(([t, f]) => t === type && f === fn),
        `${String(type)} listener removed`
      ).toBe(true)
    }
  })
})
