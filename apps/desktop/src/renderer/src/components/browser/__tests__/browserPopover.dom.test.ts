// @vitest-environment jsdom
/**
 * 弹层的外框（BrowserPopover）：内容经 portal 渲染进透明 view 的文档，矩形报给主进程，挂着就是开着、卸载就关。
 *
 *   BPO-1   文档备好了：内容在弹层文档里、外壳里没有；卸载后清空，最后一次 setPopover(null)；
 *   BPO-2   文档还没备好：什么都不画、不报；备好之后画出来、报一次；
 *   BPO-3   矩形 = anchor 左下 + 间距，多出放阴影的留白；width 不给就和 anchor 一样宽；
 *   BPO-4   弹层那边的 ResizeObserver 报盒子、外壳这边的报 anchor：都重报，中间不报 null；卸载后两个都断开；
 *   BPO-5   按在盒子里：onPressChange(true)，松手 false，不算 dismiss；按在留白上：dismiss，不算按下；按着卸载：false；
 *   BPO-6   Esc（外壳文档、弹层文档）dismiss，别的键不管；
 *   BPO-7   按在外壳上 dismiss，按钮 stopPropagation 也拦不住（捕获阶段听）；按在 anchor 上不算；
 *   BPO-8   blur（外壳或弹层）60ms 后看焦点：两边都没有才 dismiss；
 *   BPO-9   60ms 内再 blur 一次只看一次；卸载后计时器、键盘、鼠标都不再 dismiss；
 *   BPO-10  不给 onDismiss（地址栏下拉）：留白、Esc、外壳、blur 都什么也不做，不抛；
 *   BPO-11  anchor.current 是 null：不报、不抛。
 *
 * iframe 整个文件一份（browserDomSupport.installPopoverWindow）；要看「还没备好」时用 forgetHost + 一条没加载完的样式表。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, createElement, createRef, type ReactNode } from 'react'
import { BrowserPopover } from '../BrowserPopover'
import { warmBrowserPopover } from '../browserPopoverHost'
import {
  flush,
  initEnI18n,
  installFakeApi,
  installPopoverWindow,
  installResizeObserver,
  keyDown,
  mountInto,
  mouseDown,
  mouseUpOn,
  stubRectsBy,
  warmPopoverHost,
  windowBlur,
  type FakeApi,
  type Mounted,
  type PopoverWindow,
  type ResizeObserverControl
} from './browserDomSupport'

let api: FakeApi
let ro: ResizeObserverControl
let pop: PopoverWindow
let m: Mounted | null = null
let onDismiss: Mock<() => void>
let onPressChange: Mock<(pressed: boolean) => void>

const ANCHOR_RECT = { x: 100, y: 8, width: 600, height: 32 }

interface HarnessProps {
  width?: number
  gap?: number
  focus?: 'take' | 'keep-shell'
  onDismiss?: () => void
  onPressChange?: (pressed: boolean) => void
  children?: ReactNode
}

/** anchor 的 ref：挂着的那份外壳的（放在组件外，每次挂上都是新的元素） */
const anchor = createRef<HTMLDivElement>()

/** 外壳的样子：一个 anchor、一个 anchor 外面的按钮；弹层放在 anchor 后面（挂上时 ref 已经有了） */
function Harness(props: HarnessProps): React.JSX.Element {
  const popoverProps = {
    anchor,
    width: props.width,
    gap: props.gap ?? 6,
    focus: props.focus ?? 'take',
    onDismiss: props.onDismiss,
    onPressChange: props.onPressChange
  } as Parameters<typeof BrowserPopover>[0]
  return createElement(
    'div',
    null,
    createElement('button', { 'data-outside': '' }, 'outside'),
    createElement(
      'div',
      { ref: anchor, 'data-anchor': '' },
      createElement('span', { 'data-in-anchor': '' }, 'lock')
    ),
    createElement(
      BrowserPopover,
      popoverProps,
      props.children ?? createElement('div', { 'data-content': '' }, 'hello')
    )
  )
}

async function mount(props: HarnessProps = {}): Promise<void> {
  m = await mountInto(Harness, { onDismiss, onPressChange, ...props })
}

const setPopover = (): Mock => api.browserView.setPopover
const content = (): HTMLElement | null => pop.doc.querySelector<HTMLElement>('[data-content]')
/** 弹层的盒子（BrowserPopover 自己那层 div） */
const box = (): HTMLElement => pop.doc.body.firstElementChild as HTMLElement
const anchorEl = (): HTMLElement => document.querySelector<HTMLElement>('[data-anchor]')!

function blurOn(target: Window): void {
  act(() => {
    target.dispatchEvent(new FocusEvent('blur'))
  })
}

/** 假时钟走 ms */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(async () => {
  api = installFakeApi()
  ro = installResizeObserver()
  pop = installPopoverWindow()
  await warmPopoverHost()
  onDismiss = vi.fn<() => void>()
  onPressChange = vi.fn<(pressed: boolean) => void>()
  stubRectsBy((el) =>
    el.hasAttribute('data-anchor') ? ANCHOR_RECT : { x: 0, y: 0, width: 0, height: 0 }
  )
})

afterEach(() => {
  m?.unmount()
  m = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('渲染到哪（BPO-1 / BPO-2）', () => {
  it('BPO-1 内容在弹层文档里、外壳里没有；卸载后清空，最后一次 setPopover(null)', async () => {
    await mount()
    expect(content()?.textContent).toBe('hello')
    expect(document.querySelector('[data-content]')).toBeNull()

    m!.unmount()
    m = null
    expect(pop.doc.body.children).toHaveLength(0)
    expect(setPopover().mock.calls.at(-1)).toEqual([null])
  })

  it('BPO-2 文档还没备好：不画、不报；备好之后画出来、报一次', async () => {
    // 重新开一遍，外壳多一条还没加载完的样式表：这份文档开着，但还没备好
    pop.forgetHost()
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/assets/pending.css'
    document.head.appendChild(link)
    try {
      warmBrowserPopover()
      expect(pop.open).toHaveBeenCalledTimes(1)
      await mount()
      await act(async () => {
        await Promise.resolve()
      })
      expect(pop.open).toHaveBeenCalledTimes(1)
      expect(content()).toBeNull()
      expect(setPopover()).not.toHaveBeenCalled()

      await act(async () => {
        for (const copy of pop.doc.head.querySelectorAll('link')) {
          copy.dispatchEvent(new Event('load'))
        }
      })
      await flush(1)
      expect(content()).not.toBeNull()
      expect(setPopover()).toHaveBeenCalledTimes(1)
    } finally {
      link.remove()
    }
  })
})

describe('矩形（BPO-3 / BPO-4）', () => {
  it('BPO-3 anchor 左下 + 间距，多出放阴影的留白：{80,42,360,244}；盒子 320 宽', async () => {
    await mount({ width: 320, gap: 6, focus: 'take' })
    expect(setPopover().mock.calls).toEqual([
      [{ bounds: { x: 80, y: 42, width: 360, height: 244 }, focus: 'take' }]
    ])
    expect(box().style.width).toBe('320px')
  })

  it('BPO-3 不给 width：盒子和 anchor 一样宽', async () => {
    await mount({ gap: 4, focus: 'keep-shell' })
    expect(box().style.width).toBe('600px')
    expect(setPopover().mock.calls).toEqual([
      [{ bounds: { x: 80, y: 40, width: 640, height: 244 }, focus: 'keep-shell' }]
    ])
  })

  it('BPO-4 弹层那边的观察者报盒子、外壳的报 anchor：都重报，中间没有 null；卸载后都断开', async () => {
    const realmBefore = pop.realmObservers()
    await mount({ width: 320 })
    expect(pop.realmObservers()).toBe(realmBefore + 1)
    const theBox = box()
    const theAnchor = anchorEl()
    expect(ro.observing(theBox)).toBe(1)
    expect(ro.observing(theAnchor)).toBe(1)
    expect(setPopover()).toHaveBeenCalledTimes(1)

    // 内容长高：盒子那边报
    pop.box.height = 300
    ro.trigger(theBox)
    expect(setPopover()).toHaveBeenCalledTimes(2)
    expect(setPopover().mock.calls.at(-1)?.[0].bounds.height).toBe(344)

    // 地址栏变宽 / 挪了：anchor 这边报
    stubRectsBy((el) =>
      el.hasAttribute('data-anchor')
        ? { ...ANCHOR_RECT, x: 200 }
        : { x: 0, y: 0, width: 0, height: 0 }
    )
    ro.trigger(theAnchor)
    expect(setPopover()).toHaveBeenCalledTimes(3)
    expect(setPopover().mock.calls.at(-1)?.[0].bounds.x).toBe(180)
    expect(setPopover().mock.calls.map(([p]) => p)).not.toContain(null)

    m!.unmount()
    m = null
    expect(ro.observing(theBox)).toBe(0)
    expect(ro.observing(theAnchor)).toBe(0)
  })

  it('BPO-11 anchor.current 是 null：不报、不抛', async () => {
    m = await mountInto(BrowserPopover, {
      anchor: { current: null },
      gap: 6,
      focus: 'take',
      children: createElement('div', { 'data-content': '' }, 'hello')
    })
    expect(setPopover()).not.toHaveBeenCalled()
    expect(content()).not.toBeNull()
  })
})

describe('鼠标（BPO-5 / BPO-7）', () => {
  it('BPO-5 按在盒子里：pressed true，松手 false，不 dismiss', async () => {
    await mount()
    mouseDown(content()!)
    expect(onPressChange.mock.calls).toEqual([[true]])
    mouseUpOn(content()!)
    expect(onPressChange.mock.calls).toEqual([[true], [false]])
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('BPO-5 按在放阴影的留白上：dismiss 一次，不算按下', async () => {
    await mount()
    mouseDown(pop.doc.body)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onPressChange).not.toHaveBeenCalledWith(true)
  })

  it('BPO-5 按着的时候卸载（松手再也到不了）：onPressChange(false)', async () => {
    await mount()
    mouseDown(content()!)
    onPressChange.mockClear()
    m!.unmount()
    m = null
    expect(onPressChange.mock.calls).toEqual([[false]])
  })

  it('BPO-7 按在外壳上：dismiss 一次', async () => {
    await mount()
    mouseDown(document.querySelector('[data-outside]')!)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('BPO-7 外壳上的按钮 stopPropagation：照样 dismiss 一次（捕获阶段听）', async () => {
    await mount()
    const button = document.querySelector('[data-outside]')!
    button.addEventListener('mousedown', (e) => e.stopPropagation())
    mouseDown(button)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('BPO-7 按在 anchor 里：不算（那是开关自己的事）', async () => {
    await mount()
    mouseDown(document.querySelector('[data-in-anchor]')!)
    mouseDown(anchorEl())
    expect(onDismiss).not.toHaveBeenCalled()
  })
})

describe('键盘（BPO-6）', () => {
  it.each([
    ['外壳文档', (): Element => document.body],
    ['弹层文档', (): Element => pop.doc.body]
  ])('BPO-6 %s：Esc dismiss，别的键不管', async (_label, target) => {
    await mount()
    keyDown(target(), 'a')
    expect(onDismiss).not.toHaveBeenCalled()
    keyDown(target(), 'Escape')
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})

describe('焦点（BPO-8 / BPO-9）', () => {
  const stubFocus = (shell: boolean, popover: boolean): void => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(shell)
    vi.spyOn(pop.doc, 'hasFocus').mockReturnValue(popover)
  }

  it.each([
    ['外壳', true, true],
    ['外壳', true, false],
    ['外壳', false, true],
    ['外壳', false, false],
    ['弹层', true, true],
    ['弹层', true, false],
    ['弹层', false, true],
    ['弹层', false, false]
  ] as const)(
    'BPO-8 %s blur，外壳有焦点 %s、弹层有焦点 %s：59ms 没事，60ms 两边都没有才 dismiss',
    async (source, shellFocus, popoverFocus) => {
      vi.useFakeTimers()
      await mount()
      stubFocus(shellFocus, popoverFocus)

      if (source === '外壳') windowBlur()
      else blurOn(pop.win)
      await tick(59)
      expect(onDismiss).not.toHaveBeenCalled()

      await tick(1)
      expect(onDismiss).toHaveBeenCalledTimes(!shellFocus && !popoverFocus ? 1 : 0)
    }
  )

  it('BPO-9 外壳 blur、30ms 后弹层 blur：从最后一次算起，只看一次焦点', async () => {
    vi.useFakeTimers()
    await mount()
    stubFocus(false, false)
    const hasFocus = document.hasFocus as unknown as Mock

    windowBlur()
    await tick(30)
    blurOn(pop.win)
    await tick(59)
    expect(hasFocus).not.toHaveBeenCalled()
    expect(onDismiss).not.toHaveBeenCalled()

    await tick(1)
    expect(hasFocus).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('BPO-9 等焦点落定时卸载：计时器作废；之后键盘、鼠标也不再 dismiss', async () => {
    vi.useFakeTimers()
    await mount()
    stubFocus(false, false)

    windowBlur()
    m!.unmount()
    m = null
    await tick(100)
    expect(onDismiss).not.toHaveBeenCalled()

    keyDown(document.body, 'Escape')
    keyDown(pop.doc.body, 'Escape')
    mouseDown(document.body)
    mouseDown(pop.doc.body)
    blurOn(pop.win)
    await tick(100)
    expect(onDismiss).not.toHaveBeenCalled()
  })
})

describe('不给 onDismiss（BPO-10）', () => {
  it('BPO-10 留白、Esc、外壳、blur：什么也不发生、不抛', async () => {
    vi.useFakeTimers()
    await mount({ onDismiss: undefined })
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    vi.spyOn(pop.doc, 'hasFocus').mockReturnValue(false)

    expect(() => {
      mouseDown(pop.doc.body)
      keyDown(document.body, 'Escape')
      keyDown(pop.doc.body, 'Escape')
      mouseDown(document.querySelector('[data-outside]')!)
      windowBlur()
    }).not.toThrow()
    await tick(100)

    expect(content()).not.toBeNull()
    expect(setPopover().mock.calls.map(([p]) => p)).not.toContain(null)
    expect(document.hasFocus).not.toHaveBeenCalled()
  })
})
