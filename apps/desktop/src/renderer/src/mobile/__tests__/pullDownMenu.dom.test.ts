// @vitest-environment jsdom
/**
 * 手机布局的下拉菜单（mobile/PullDownMenu.tsx，jsdom）。
 *
 * 契约：挂到 body 上，贴着按钮的下边、右边与按钮对齐（离屏幕右边不少于 8px）；一组一组的项，组与组之间一条粗线，
 * 空组不画；每项行尾带图标、数字 > 0 才画；点一项先收起再做事，置灰的项点了没反应；点菜单以外、按 Esc、
 * 浏览器历史一动（返回手势）就收起。
 *
 *   PM-1  挂在 body 上、role
 *   PM-2  各组的项按顺序画出
 *   PM-3 / PM-4 位置：按钮下面 6px、右对齐、离右边至少 8px
 *   PM-5..7 空组不画、不留粗线
 *   PM-8  数字 > 0 才画
 *   PM-9  点一项：先收起再做事
 *   PM-10 置灰的项
 *   PM-11 / PM-12 点菜单外收起、点菜单里不是项的地方不收起
 *   PM-13 Esc 收起，别的键不收
 *   PM-14 卸掉之后不再听键盘
 *   PM-15 换了 onClose 用新的
 *   PM-16 一行里的顺序：名字、数字、图标
 *   PM-17 返回手势（popstate）收起
 *   PM-18 卸掉之后不再听 popstate
 *
 * 组件只引 react / react-dom，没有替身。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PullDownMenu, type PullDownItem, type PullDownMenuProps } from '../PullDownMenu'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const onPick = vi.fn<(id: string) => void>()
const onClose = vi.fn<() => void>()

const item = (id: string, extra: Partial<PullDownItem> = {}): PullDownItem => ({
  id,
  label: id.toUpperCase(),
  icon: h('i', { 'data-icon': id }),
  ...extra
})

function render(groups: PullDownItem[][], over: Partial<PullDownMenuProps> = {}): void {
  act(() =>
    root.render(
      h(PullDownMenu, { anchor: { right: 380, bottom: 44 }, groups, onPick, onClose, ...over })
    )
  )
}

const layer = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[data-mobile-pulldown-layer]')
const menu = (): HTMLElement => document.body.querySelector<HTMLElement>('[data-mobile-pulldown]')!
const items = (): HTMLButtonElement[] =>
  Array.from(menu().querySelectorAll<HTMLButtonElement>('[data-mobile-menu-item]'))
const ids = (): Array<string | null> =>
  items().map((el) => el.getAttribute('data-mobile-menu-item'))
const itemOf = (id: string): HTMLButtonElement =>
  menu().querySelector<HTMLButtonElement>(`[data-mobile-menu-item="${id}"]`)!
const groupsOf = (): HTMLElement[] => Array.from(menu().children) as HTMLElement[]
const DIVIDER = 'border-t-[6px]'

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
function key(name: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: name }))
  })
}
function pop(): void {
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
}

beforeEach(() => {
  onPick.mockReset()
  onClose.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('PullDownMenu: where and what it draws', () => {
  it('PM-1 the menu is portaled to body, with menu roles', () => {
    render([[item('a')]])
    expect(layer()).not.toBeNull()
    expect(layer()!.parentElement).toBe(document.body)
    expect(container.contains(layer())).toBe(false)
    expect(menu().getAttribute('role')).toBe('menu')
    for (const el of items()) {
      expect(el.getAttribute('role')).toBe('menuitem')
      expect(el.getAttribute('type')).toBe('button')
    }
  })

  it('PM-2 items keep their order and labels across groups', () => {
    render([[item('a'), item('b')], [item('c')]])
    expect(ids()).toEqual(['a', 'b', 'c'])
    expect(items().map((el) => el.textContent)).toEqual(['A', 'B', 'C'])
  })

  it('PM-3 the menu sits under the button, right-aligned to it', () => {
    render([[item('a')]], { anchor: { right: 380, bottom: 44 } })
    expect(menu().style.top).toBe('50px')
    expect(menu().style.right).toBe(`${window.innerWidth - 380}px`)
    expect(menu().style.right).toBe('644px')
  })

  it.each([1020, 1024, 1100])(
    'PM-4 a button whose right edge is at %i keeps the menu 8px from the right edge',
    (right) => {
      render([[item('a')]], { anchor: { right, bottom: 44 } })
      expect(menu().style.right).toBe('8px')
    }
  )

  it('PM-5 an empty group is not drawn and leaves one divider between the two that are', () => {
    render([[item('a')], [], [item('b')]])
    const groups = groupsOf()
    expect(groups).toHaveLength(2)
    expect(groups[0].className).not.toContain(DIVIDER)
    expect(groups[1].className).toContain(DIVIDER)
    expect(ids()).toEqual(['a', 'b'])
  })

  it('PM-6 a leading empty group leaves no divider', () => {
    render([[], [item('a')]])
    const groups = groupsOf()
    expect(groups).toHaveLength(1)
    expect(groups[0].className).not.toContain(DIVIDER)
  })

  it('PM-7 with every group empty the menu still renders, with no items', () => {
    expect(() => render([[], []])).not.toThrow()
    expect(layer()).not.toBeNull()
    expect(groupsOf()).toHaveLength(0)
    expect(items()).toHaveLength(0)
  })

  it('PM-8 a count shows only when it is above zero', () => {
    render([
      [item('a', { count: 3 }), item('b', { count: 0 }), item('c'), item('d', { count: -1 })]
    ])
    const counts = menu().querySelectorAll('[data-mobile-menu-count]')
    expect(counts).toHaveLength(1)
    expect(itemOf('a').querySelector('[data-mobile-menu-count]')!.textContent).toBe('3')
  })

  it('PM-16 a row is the label, the count, then the icon (hidden from assistive tech)', () => {
    render([[item('a', { count: 2 })]])
    const cells = Array.from(itemOf('a').children) as HTMLElement[]
    expect(cells).toHaveLength(3)
    expect(cells[0].textContent).toBe('A')
    expect(cells[1].hasAttribute('data-mobile-menu-count')).toBe(true)
    expect(cells[2].querySelector('[data-icon="a"]')).not.toBeNull()
    expect(cells[2].getAttribute('aria-hidden')).toBe('true')
  })
})

describe('PullDownMenu: picking and closing', () => {
  it('PM-9 picking an item closes first, then acts', () => {
    render([[item('a'), item('b')]])
    click(itemOf('b'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith('b')
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onPick.mock.invocationCallOrder[0])
  })

  it('PM-10 a disabled item does nothing', () => {
    render([[item('a'), item('fork', { disabled: true })]])
    const fork = itemOf('fork')
    expect(fork.disabled).toBe(true)
    act(() => fork.click())
    click(fork)
    expect(onPick).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(itemOf('a').disabled).toBe(false)
  })

  it('PM-11 a tap outside the menu closes it', () => {
    render([[item('a')]])
    click(layer()!)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('PM-12 a tap inside the menu that is not on an item does not close it', () => {
    render([[item('a')]])
    click(menu())
    expect(onClose).not.toHaveBeenCalled()
    expect(onPick).not.toHaveBeenCalled()
  })

  it('PM-13 Escape closes; other keys do not', () => {
    render([[item('a')]])
    key('Escape')
    key('Enter')
    key('a')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('PM-17 the back gesture (popstate) closes', () => {
    render([[item('a')]])
    pop()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('PM-14 after unmount Escape no longer reaches it and nothing is left in body', () => {
    render([[item('a')]])
    act(() => root.unmount())
    key('Escape')
    expect(onClose).not.toHaveBeenCalled()
    expect(layer()).toBeNull()
    root = createRoot(container)
  })

  it('PM-18 after unmount a popstate no longer reaches it', () => {
    render([[item('a')]])
    act(() => root.unmount())
    pop()
    expect(onClose).not.toHaveBeenCalled()
    root = createRoot(container)
  })

  it('PM-15 a new onClose replaces the old one for Escape and popstate', () => {
    render([[item('a')]])
    const onClose2 = vi.fn<() => void>()
    render([[item('a')]], { onClose: onClose2 })
    key('Escape')
    pop()
    expect(onClose).not.toHaveBeenCalled()
    expect(onClose2).toHaveBeenCalledTimes(2)
  })
})
