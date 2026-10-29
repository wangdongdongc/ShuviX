// @vitest-environment jsdom
/**
 * 右侧面板左缘的分隔条（BrowserResizeHandle；名字是历史遗留）。手势交给 startPanelDrag（整窗遮罩，面板里的小组件
 * iframe 吞不走 mousemove / mouseup），组件自己只管起点宽度、方向（往左拖变宽）与 [320, 960] 的钳制。
 *
 *   BR-1 store 宽 600，在 x=800 按下：移到 860 → 宽 540；移到 400 → 960（钳到上限）；在遮罩上松开结束拖动；
 *        之后再移到 300（仍按着左键）宽度不动，还是 960
 *
 * `useBrowserStore` 用真的；它底下的 `@shuvix/app-shell` 换成小替身（共享面板 store），但 startPanelDrag 用
 * app-shell 源码里真的那份；布局持久化换成间谍。`window.api` 只铺 store 会碰的几项。一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@shuvix/app-shell', async () => {
  const { create } = await import('zustand')
  const { startPanelDrag } = await import('@shuvix/app-shell/common/panelDrag')
  return {
    SESSION_PANEL_MIN_W: 280,
    startPanelDrag,
    usePanelStore: create<{
      isOpen: boolean
      activeTab: string
      width: number
      setOpen: (open: boolean) => void
      setActiveTab: (tab: string) => void
      setWidth: (width: number) => void
    }>((set) => ({
      isOpen: true,
      activeTab: 'widget',
      width: 320,
      setOpen: (isOpen) => set({ isOpen }),
      setActiveTab: (activeTab) => set({ activeTab }),
      setWidth: (width) => set({ width })
    }))
  }
})
vi.mock('../../../stores/panelLayout', () => ({ persistPanelLayout: vi.fn() }))

import { usePanelStore } from '@shuvix/app-shell'
import { BrowserResizeHandle } from '../BrowserResizeHandle'
import { useBrowserStore } from '../../../stores/browserStore'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function move(x: number): void {
  act(() => {
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: 300, buttons: 1 }))
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  ;(window as unknown as { api: unknown }).api = {
    app: { platform: 'darwin', setBrowserOffset: vi.fn(), adjustWindowWidth: vi.fn() },
    settings: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) }
  }
  usePanelStore.setState({ isOpen: true, width: 600 })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  document.body.innerHTML = ''
  document.body.removeAttribute('style')
})

describe('BrowserResizeHandle', () => {
  it('BR-1 dragging right narrows, left widens up to 960; the drag ends on mouseup over the overlay', () => {
    act(() => root.render(createElement(BrowserResizeHandle)))
    expect(useBrowserStore.getState().width).toBe(600)
    const handle = container.firstElementChild as HTMLElement

    act(() => {
      handle.dispatchEvent(
        new MouseEvent('mousedown', {
          button: 0,
          buttons: 1,
          clientX: 800,
          clientY: 300,
          bubbles: true,
          cancelable: true
        })
      )
    })
    move(860)
    expect(useBrowserStore.getState().width).toBe(540)
    move(400)
    expect(useBrowserStore.getState().width).toBe(960)

    const overlay = document.querySelector('[data-panel-drag-overlay]')
    expect(overlay).not.toBeNull()
    act(() => {
      overlay!.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0, bubbles: true }))
    })
    expect(document.querySelector('[data-panel-drag-overlay]')).toBeNull()

    move(300)
    expect(useBrowserStore.getState().width).toBe(960)
  })
})
