// @vitest-environment jsdom
/**
 * 询问卡片与选项题共用的选项行（inputs/OptionRows）：`OptionRow` 一行的结构，与 `useOptionHotkeys` 的数字键。
 *
 *   OR-1  一行是 `button[type=button]`，`data` 的属性挂在按钮上；行首序号 aria-hidden、写 index + 1；
 *         `[data-option-label]` / `[data-option-detail]` 各是正文与说明；点一下 onPick 恰一次
 *   OR-2  checked 未给 → 没有 aria-pressed、显示序号；false → aria-pressed="false"、序号；true → "true"、
 *         序号换成对勾（svg.lucide-check），没有数字
 *   OR-3  detailIsPath → 说明里包一个 <bdi>，恰是那条路径（从左端截断：rtl + truncate，只断 class）；
 *         普通说明没有 <bdi>；没有说明 → 没有 `[data-option-detail]`
 *   OR-4  （只断 class）紧凑档 min-h-8 + text-[13px]；触屏档 min-h-11 + text-sm
 *   OR-5  1 / 2 / 3 → onPick(0) / (1) / (2) 各一次，事件都被 preventDefault
 *   OR-6  超出行数的 4、0、字母、F1、回车、空格 → 不选、不拦
 *   OR-7  焦点在 input / textarea / select / contenteditable 的 div / 它里面的 span 上按 1 → 不选、不拦
 *   OR-8  带 ⌘ / Ctrl / Alt / Shift（各自单独）按 1 → 不选、不拦
 *   OR-9  长按连发（repeat）、输入法组字中（isComposing）→ 不选
 *   OR-10 document 上捕获阶段先 preventDefault 的监听 → 不选
 *   OR-11 触屏档：1 什么都不做、不拦
 *   OR-12 卸载之后 1 什么都不做；紧凑 → 触屏重渲染关掉数字键、触屏 → 紧凑打开；行数 3 → 1：2 不认、1 照选；
 *         行数 0：什么都不认
 *   OR-13 换一个新的 onPick（行数不变）重渲染 → 1 调新的，不调旧的
 *   OR-14 焦点在普通 <button> 上 → 1 照选
 *   OR-15 shadow root 里获得焦点的 <input>，按 1（composed）→ 不选
 *
 * 紧凑 = 不包宿主上下文（或给 density 'compact'）；触屏 = `ChatHostContext` 给 density 'touch'。按键在目标元素上
 * 派发（bubbles + cancelable + composed），每一下各自一个 act；dispatchEvent 回 true = 没处理，false = 被拦下。
 * 文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { OptionRow, useOptionHotkeys, type OptionRowProps } from '../inputs/OptionRows'
import {
  ChatHostContext,
  type ChatDensity,
  type ChatHostValue
} from '../../../host/chatHostContext'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let mounted = false

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = true
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  document.body.innerHTML = ''
})

/** 包一层宿主上下文（给了 density 才包；不给 = 没有 Provider，即紧凑档） */
function withDensity(
  el: ReturnType<typeof createElement>,
  density?: ChatDensity
): ReturnType<typeof createElement> {
  return density
    ? createElement(ChatHostContext.Provider, { value: { density } as ChatHostValue }, el)
    : el
}

function render(el: ReturnType<typeof createElement>): void {
  act(() => {
    root.render(el)
  })
}

// ─── OptionRow ──────────────────────────────────────────────

const rowProps = (extra: Partial<OptionRowProps> = {}): OptionRowProps => ({
  index: 2,
  label: 'L',
  onPick: vi.fn(),
  ...extra
})

const button = (): HTMLButtonElement => {
  const el = container.querySelector('button')
  if (!el) throw new Error('option row not rendered')
  return el
}
/** 行首的序号格（按钮的第一个子元素） */
const badge = (): HTMLElement => button().firstElementChild as HTMLElement
const classesOf = (el: Element): string[] => (el.getAttribute('class') ?? '').split(/\s+/)

describe('OptionRow', () => {
  it('OR-1 一颗 type=button 的按钮，data 属性在按钮上；序号 aria-hidden、写 3；正文 / 说明各就各位；点一下 onPick 一次', () => {
    const onPick = vi.fn()
    render(createElement(OptionRow, rowProps({ detail: 'D', data: { 'data-x': 'y' }, onPick })))
    const btn = button()
    expect(container.querySelectorAll('button')).toHaveLength(1)
    expect(btn.getAttribute('type')).toBe('button')
    expect(btn.getAttribute('data-x')).toBe('y')
    expect(badge().tagName).toBe('SPAN')
    expect(badge().getAttribute('aria-hidden')).toBe('true')
    expect(badge().textContent).toBe('3')
    expect(btn.querySelector('[data-option-label]')?.textContent).toBe('L')
    expect(btn.querySelector('[data-option-detail]')?.textContent).toBe('D')

    act(() => btn.click())
    expect(onPick).toHaveBeenCalledTimes(1)
  })

  it('OR-2 checked：未给 → 没有 aria-pressed、显示序号；false → "false"、序号；true → "true"、对勾、没有数字', () => {
    render(createElement(OptionRow, rowProps()))
    expect(button().hasAttribute('aria-pressed')).toBe(false)
    expect(badge().textContent).toBe('3')
    expect(badge().querySelector('svg.lucide-check')).toBeNull()

    render(createElement(OptionRow, rowProps({ checked: false })))
    expect(button().getAttribute('aria-pressed')).toBe('false')
    expect(badge().textContent).toBe('3')
    expect(badge().querySelector('svg.lucide-check')).toBeNull()

    render(createElement(OptionRow, rowProps({ checked: true })))
    expect(button().getAttribute('aria-pressed')).toBe('true')
    expect(badge().querySelector('svg.lucide-check')).not.toBeNull()
    expect(badge().textContent).not.toMatch(/\d/)
  })

  it('OR-3 路径说明包在 <bdi> 里、恰是那条路径（rtl + truncate）；普通说明没有 <bdi>；没有说明就没有说明那一格', () => {
    const PATH = '/Users/u/proj/docs'
    render(createElement(OptionRow, rowProps({ detail: PATH, detailIsPath: true })))
    const detail = container.querySelector<HTMLElement>('[data-option-detail]')!
    expect(detail).not.toBeNull()
    const bdis = detail.querySelectorAll('bdi')
    expect(bdis).toHaveLength(1)
    expect(bdis[0].textContent).toBe(PATH)
    expect(detail.textContent).toBe(PATH)
    expect(classesOf(detail)).toEqual(expect.arrayContaining(['truncate', '[direction:rtl]']))

    render(createElement(OptionRow, rowProps({ detail: 'plain words' })))
    const plain = container.querySelector<HTMLElement>('[data-option-detail]')!
    expect(plain.textContent).toBe('plain words')
    expect(plain.querySelector('bdi')).toBeNull()

    render(createElement(OptionRow, rowProps()))
    expect(container.querySelector('[data-option-detail]')).toBeNull()
  })

  it.each<[string, ChatDensity | undefined, string[], string[]]>([
    ['紧凑档（没有宿主）', undefined, ['min-h-8', 'text-[13px]'], ['min-h-11', 'text-sm']],
    ['触屏档', 'touch', ['min-h-11', 'text-sm'], ['min-h-8', 'text-[13px]']]
  ])('OR-4 %s：行高与字号的 class', (_label, density, has, hasNot) => {
    render(withDensity(createElement(OptionRow, rowProps()), density))
    const cls = classesOf(button())
    expect(cls).toEqual(expect.arrayContaining(has))
    for (const c of hasNot) expect(cls).not.toContain(c)
  })
})

// ─── useOptionHotkeys ───────────────────────────────────────

function H({ count, onPick }: { count: number; onPick: (index: number) => void }): null {
  useOptionHotkeys(count, onPick)
  return null
}

type PickSpy = Mock<(index: number) => void>

function mountHotkeys(
  opts: { count?: number; onPick?: PickSpy; density?: ChatDensity } = {}
): PickSpy {
  const onPick = opts.onPick ?? vi.fn<(index: number) => void>()
  render(withDensity(createElement(H, { count: opts.count ?? 3, onPick }), opts.density))
  return onPick
}

/**
 * 在目标（缺省 = 此刻的焦点，没有就 body）上派发一次 keydown；回 dispatchEvent 的结果（false = 被拦下）
 */
function press(key: string, init: KeyboardEventInit = {}, target?: EventTarget): boolean {
  const at = target ?? document.activeElement ?? document.body
  let result = true
  act(() => {
    result = at.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        composed: true,
        ...init
      })
    )
  })
  return result
}

describe('useOptionHotkeys', () => {
  beforeEach(() => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
  })

  it('OR-5 1 / 2 / 3 → onPick(0) / (1) / (2) 各一次，事件都被拦下', () => {
    const onPick = mountHotkeys()
    expect(document.activeElement).toBe(document.body)
    expect(press('1')).toBe(false)
    expect(press('2')).toBe(false)
    expect(press('3')).toBe(false)
    expect(onPick.mock.calls).toEqual([[0], [1], [2]])
  })

  it.each([['4'], ['0'], ['a'], ['F1'], ['Enter'], [' ']])('OR-6 %j（三行）→ 不选、不拦', (key) => {
    const onPick = mountHotkeys()
    expect(press(key)).toBe(true)
    expect(onPick).not.toHaveBeenCalled()
  })

  it.each<[string, () => HTMLElement]>([
    [
      'input[type=text]',
      () => {
        const el = document.createElement('input')
        el.type = 'text'
        return el
      }
    ],
    ['textarea', () => document.createElement('textarea')],
    [
      'select',
      () => {
        const el = document.createElement('select')
        el.appendChild(document.createElement('option'))
        return el
      }
    ],
    [
      'contenteditable 的 div',
      () => {
        const el = document.createElement('div')
        el.setAttribute('contenteditable', 'true')
        el.tabIndex = 0
        el.textContent = 'note'
        return el
      }
    ],
    [
      'contenteditable 里的 span',
      () => {
        const host = document.createElement('div')
        host.setAttribute('contenteditable', 'true')
        host.tabIndex = 0
        const span = document.createElement('span')
        span.textContent = 'inner'
        host.appendChild(span)
        return span
      }
    ]
  ])('OR-7 焦点在 %s 上按 1 → 不选、不拦', (_label, make) => {
    const onPick = mountHotkeys()
    const el = make()
    document.body.appendChild(el.closest('[contenteditable]') ?? el)
    el.focus()
    expect(press('1', {}, el)).toBe(true)
    expect(onPick).not.toHaveBeenCalled()
  })

  it.each<[keyof KeyboardEventInit]>([['metaKey'], ['ctrlKey'], ['altKey'], ['shiftKey']])(
    'OR-8 带 %s 按 1 → 不选、不拦',
    (mod) => {
      const onPick = mountHotkeys()
      expect(press('1', { [mod]: true })).toBe(true)
      expect(onPick).not.toHaveBeenCalled()
    }
  )

  it('OR-9 长按连发、输入法组字中 → 不选', () => {
    const onPick = mountHotkeys()
    press('1', { repeat: true })
    press('1', { isComposing: true })
    expect(onPick).not.toHaveBeenCalled()
  })

  it('OR-10 document 上捕获阶段先 preventDefault → 不选', () => {
    const onPick = mountHotkeys()
    const first = (e: Event): void => e.preventDefault()
    document.addEventListener('keydown', first, true)
    try {
      press('1')
      expect(onPick).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', first, true)
    }
  })

  it('OR-11 触屏档：1 什么都不做、不拦', () => {
    const onPick = mountHotkeys({ density: 'touch' })
    expect(press('1')).toBe(true)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('OR-12 卸载之后不认；紧凑 ⇄ 触屏重渲染开关数字键；行数 3 → 1 → 0', () => {
    // 卸载
    let onPick = mountHotkeys()
    act(() => root.unmount())
    mounted = false
    expect(press('1')).toBe(true)
    expect(onPick).not.toHaveBeenCalled()

    // 紧凑 → 触屏 → 紧凑（同一棵树，H 不重挂）
    root = createRoot(container)
    mounted = true
    onPick = mountHotkeys({ density: 'compact' })
    press('1')
    expect(onPick).toHaveBeenCalledTimes(1)
    mountHotkeys({ density: 'touch', onPick })
    expect(press('1')).toBe(true)
    expect(onPick).toHaveBeenCalledTimes(1)
    mountHotkeys({ density: 'compact', onPick })
    expect(press('1')).toBe(false)
    expect(onPick).toHaveBeenCalledTimes(2)

    // 行数 3 → 1：2 不认、1 照选
    onPick.mockClear()
    mountHotkeys({ count: 1, onPick })
    expect(press('2')).toBe(true)
    expect(onPick).not.toHaveBeenCalled()
    expect(press('1')).toBe(false)
    expect(onPick.mock.calls).toEqual([[0]])

    // 行数 0：什么都不认
    onPick.mockClear()
    mountHotkeys({ count: 0, onPick })
    for (const key of ['1', '2', '9']) expect(press(key)).toBe(true)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('OR-13 换一个新的 onPick（行数不变）→ 1 调新的', () => {
    const first = mountHotkeys()
    const second = vi.fn<(index: number) => void>()
    mountHotkeys({ onPick: second })
    press('1')
    expect(second.mock.calls).toEqual([[0]])
    expect(first).not.toHaveBeenCalled()
  })

  it('OR-14 焦点在普通 <button> 上 → 1 照选', () => {
    const onPick = mountHotkeys()
    const btn = document.createElement('button')
    btn.textContent = 'plain'
    document.body.appendChild(btn)
    btn.focus()
    expect(document.activeElement).toBe(btn)
    expect(press('1')).toBe(false)
    expect(onPick.mock.calls).toEqual([[0]])
  })

  it('OR-15 shadow root 里获得焦点的 <input>，按 1（composed）→ 不选', () => {
    const onPick = mountHotkeys()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const input = document.createElement('input')
    shadow.appendChild(input)
    input.focus()
    // 在 document 看来焦点是宿主；事件路径的第一个节点才是输入框
    expect(document.activeElement).toBe(host)
    expect(shadow.activeElement).toBe(input)
    expect(press('1', {}, input)).toBe(true)
    expect(onPick).not.toHaveBeenCalled()
  })
})
