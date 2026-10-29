// @vitest-environment jsdom
/**
 * SidebarResizeHandle（左侧栏 / 扩展侧栏的分隔条；jsdom）—— 手势交给 startPanelDrag 之后，组件自己只剩起点宽度、
 * 方向（invert）与钳制，以及开始 / 结束两个回调。
 *
 *   SR-1 宽 250、min 200、max 400，在 x=100 按下：移到 130 → onResize(280)；移到 400 → 400（钳到 max）；
 *        invert 时移到 130 → 220
 *   SR-2 onResizeStart / onResizeEnd 各一次；被窗口失焦结束时也一样
 *   SR-3 文档里的 `<iframe>` 拖动中与拖完 `style.pointerEvents` 都还是 ''（不再逐个改 iframe —— 遮罩挡住了它们）
 *   SR-4 右键按下 → 不调 onResizeStart（什么都不开始）
 *
 * 文件是 `.ts`，一律 createElement；mousedown 派发在组件根节点上（React 的委托在 root 容器上收）。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SidebarResizeHandle, type SidebarResizeHandleProps } from './SidebarResizeHandle'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let onResize: Mock<(width: number) => void>
let onResizeStart: Mock<() => void>
let onResizeEnd: Mock<() => void>

function render(props: Partial<SidebarResizeHandleProps> = {}): HTMLElement {
  act(() =>
    root.render(
      createElement(SidebarResizeHandle, {
        width: 250,
        min: 200,
        max: 400,
        onResize,
        onResizeStart,
        onResizeEnd,
        ...props
      })
    )
  )
  return container.firstElementChild as HTMLElement
}

function press(el: HTMLElement, button = 0): void {
  act(() => {
    el.dispatchEvent(
      new MouseEvent('mousedown', {
        button,
        buttons: button === 0 ? 1 : 2,
        clientX: 100,
        clientY: 200,
        bubbles: true,
        cancelable: true
      })
    )
  })
}

function move(x: number, buttons = 1): void {
  act(() => {
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: 200, buttons }))
  })
}

function up(): void {
  act(() => {
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0 }))
  })
}

beforeEach(() => {
  onResize = vi.fn<(width: number) => void>()
  onResizeStart = vi.fn<() => void>()
  onResizeEnd = vi.fn<() => void>()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  // 收尾：万一哪条用例没结束拖动
  window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }))
  act(() => root.unmount())
  document.body.innerHTML = ''
  document.body.removeAttribute('style')
})

describe('SidebarResizeHandle', () => {
  it('SR-1 width follows the pointer from the start width, clamped; invert flips the direction', () => {
    const handle = render()
    press(handle)
    move(130)
    move(400)
    expect(onResize.mock.calls).toEqual([[280], [400]])
    up()

    onResize.mockClear()
    const inverted = render({ invert: true })
    press(inverted)
    move(130)
    expect(onResize.mock.calls).toEqual([[220]])
    up()
  })

  it('SR-2 onResizeStart / onResizeEnd once each, also when the window loses focus', () => {
    const handle = render()
    press(handle)
    expect(onResizeStart).toHaveBeenCalledTimes(1)
    expect(onResizeEnd).not.toHaveBeenCalled()
    move(120)
    up()
    up()
    expect(onResizeStart).toHaveBeenCalledTimes(1)
    expect(onResizeEnd).toHaveBeenCalledTimes(1)

    onResizeStart.mockClear()
    onResizeEnd.mockClear()
    press(handle)
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    up()
    expect(onResizeStart).toHaveBeenCalledTimes(1)
    expect(onResizeEnd).toHaveBeenCalledTimes(1)
  })

  it('SR-3 iframes in the document are not touched', () => {
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    const handle = render()
    press(handle)
    move(130)
    expect(frame.style.pointerEvents).toBe('')
    up()
    expect(frame.style.pointerEvents).toBe('')
  })

  it('SR-4 a right-button mousedown starts nothing', () => {
    const handle = render()
    press(handle, 2)
    move(130)
    up()
    expect(onResizeStart).not.toHaveBeenCalled()
    expect(onResize).not.toHaveBeenCalled()
    expect(onResizeEnd).not.toHaveBeenCalled()
    expect(document.querySelector('[data-panel-drag-overlay]')).toBeNull()
  })
})
