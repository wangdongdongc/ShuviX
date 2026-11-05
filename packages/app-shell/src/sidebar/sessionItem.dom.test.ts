// @vitest-environment jsdom
/**
 * SessionItem 的「被中断」圆点（jsdom，P3-12-14，Q-P3-10）：
 *
 *   - `interrupted` → `[data-interrupted]`，带悬浮提示；
 *   - 在跑（`isStreaming`）时不显示圆点；
 *   - 与待答询问计数并存；
 *   - 顶层行、子会话行（`isSub`）、bot 行都一样。
 *
 * 另：SR-1 每一行（顶层行、子会话行）的根节点都带 `data-session-row` —— 手机布局的 CSS 认它把行加高（40px）。
 *
 * 有子会话的行（选中 / 在跑时用实心图标，「在跑」含后台任务，由容器合起来传入 isStreaming）：
 *   SI-1 图标矩阵：空闲线框；选中实心不闪；在跑实心 + 闪；两者都有实心 + 闪。实心版每条路径都闭合（否则 fill 出一道切口）
 *   SI-2 bot / 触发运行 / 悬浮 / 笔记本 + 子会话：身份图标不变，从不实心，折叠钮还在
 *   SI-3 折叠钮：点钮只折叠（一次、不选中），点行只选中；空闲 → 在跑重渲染之后也一样；没有子会话就没有钮
 *   SI-4 data-running 只跟 isStreaming：子会话行也一样；只选中没有
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { SessionItem, type SessionItemProps } from './SessionItem'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function render(props: Partial<SessionItemProps>): void {
  act(() =>
    root.render(
      createElement(SessionItem, {
        session: { id: 's1', title: 'Session one' },
        active: false,
        onSelect: () => {},
        ...props
      })
    )
  )
}

const dot = (): HTMLElement | null => container.querySelector('[data-interrupted]')

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('P3-12-14 sidebar row', () => {
  it('P3-12-14 interrupted renders [data-interrupted] with a tooltip; absent otherwise', () => {
    render({ interrupted: true })
    expect(dot()).not.toBeNull()
    expect(dot()!.title).toBe(en.sidebar.interrupted)
    render({ interrupted: false })
    expect(dot()).toBeNull()
    render({})
    expect(dot()).toBeNull()
  })

  it('P3-12-14 isStreaming suppresses the dot', () => {
    render({ interrupted: true, isStreaming: true })
    expect(dot()).toBeNull()
  })

  it('P3-12-14 it coexists with the pending-ask count', () => {
    render({ interrupted: true, pendingCount: 2 })
    expect(dot()).not.toBeNull()
    expect(container.textContent).toContain('2')
  })

  it.each<[string, Partial<SessionItemProps>]>([
    ['top-level', {}],
    ['sub-session', { isSub: true }],
    ['bot', { isBot: true }],
    ['parent with subs', { subCount: 2 }]
  ])('P3-12-14 a %s row supports it', (_label, props) => {
    render({ ...props, interrupted: true })
    expect(dot()).not.toBeNull()
  })
})

describe('SR-1 row anchor', () => {
  it.each<[string, Partial<SessionItemProps>]>([
    ['top-level', {}],
    ['sub-session', { isSub: true }]
  ])('SR-1 a %s row carries data-session-row on its root', (_label, props) => {
    render(props)
    const row = container.firstElementChild as HTMLElement
    expect(row.hasAttribute('data-session-row')).toBe(true)
    expect(container.querySelectorAll('[data-session-row]')).toHaveLength(1)
    expect(row.textContent).toContain('Session one')
    if (props.isSub) expect(row.hasAttribute('data-sub')).toBe(true)
  })
})

describe('rows with sub-sessions', () => {
  const STATES: Array<[string, Partial<SessionItemProps>]> = [
    ['idle', { active: false, isStreaming: false }],
    ['active', { active: true, isStreaming: false }],
    ['streaming', { active: false, isStreaming: true }],
    ['active and streaming', { active: true, isStreaming: true }]
  ]
  const toggle = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('button[data-subs-toggle]')
  const icon = (): SVGElement => {
    const svg = toggle()?.querySelector('svg')
    if (!svg) throw new Error('no icon inside the toggle')
    return svg
  }
  const row = (): HTMLElement => container.querySelector<HTMLElement>('[data-session-row]')!

  it('SI-1 idle: the outline icon, unfilled, no pulse, tertiary colour', () => {
    render({ subCount: 2 })
    const svg = icon()
    expect(svg.classList.contains('lucide-messages-square')).toBe(true)
    expect(svg.classList.contains('lucide-messages-square-solid')).toBe(false)
    expect(svg.getAttribute('fill')).not.toBe('currentColor')
    expect(svg.classList.contains('animate-pulse')).toBe(false)
    expect(svg.classList.contains('text-text-tertiary')).toBe(true)
    expect(svg.classList.contains('text-accent')).toBe(false)
  })

  it.each<[string, Partial<SessionItemProps>, boolean]>([
    ['active only', { active: true }, false],
    ['streaming only', { isStreaming: true }, true],
    ['active and streaming', { active: true, isStreaming: true }, true]
  ])('SI-1 %s: the solid icon in the accent colour', (_label, props, pulses) => {
    render({ subCount: 2, ...props })
    const svg = icon()
    expect(svg.classList.contains('lucide-messages-square-solid')).toBe(true)
    expect(svg.classList.contains('lucide-messages-square')).toBe(false)
    expect(svg.getAttribute('fill')).toBe('currentColor')
    expect(svg.classList.contains('text-accent')).toBe(true)
    expect(svg.classList.contains('text-text-tertiary')).toBe(false)
    expect(svg.classList.contains('animate-pulse')).toBe(pulses)
  })

  it('SI-1 every path of the solid icon is closed, so filling it leaves no slanted cut', () => {
    render({ subCount: 2, active: true })
    const paths = [...icon().querySelectorAll('path')]
    expect(paths.length).toBeGreaterThan(0)
    for (const path of paths) {
      expect(
        path.getAttribute('d')!.trim().toLowerCase().endsWith('z'),
        path.getAttribute('d')!
      ).toBe(true)
    }
  })

  it.each(STATES)('SI-1 control: subCount 0 %s keeps the single-bubble icon', (_label, props) => {
    render({ subCount: 0, ...props })
    const svg = row().querySelector('svg')!
    expect(svg.classList.contains('lucide-message-square')).toBe(true)
    expect(svg.classList.contains('lucide-messages-square')).toBe(false)
    expect(svg.classList.contains('lucide-messages-square-solid')).toBe(false)
  })

  const IDENTITIES: Array<[string, Partial<SessionItemProps>, string]> = [
    ['bot', { isBot: true }, 'lucide-bot'],
    ['trigger run', { isTriggerRun: true }, 'lucide-timer'],
    ['pinned', { isPinned: true }, 'lucide-picture-in-picture-2'],
    ['notebook', { isNotebook: true }, 'lucide-file-text']
  ]
  describe.each(IDENTITIES)('SI-2 %s row with sub-sessions', (_label, identity, iconClass) => {
    it.each(STATES)('%s: keeps its identity icon, never solid, toggle present', (_s, state) => {
      render({ subCount: 2, ...identity, ...state })
      expect(toggle()).not.toBeNull()
      const svg = icon()
      expect(svg.classList.contains(iconClass)).toBe(true)
      expect(svg.classList.contains('lucide-messages-square-solid')).toBe(false)
      expect(svg.classList.contains('lucide-messages-square')).toBe(false)
      expect(svg.getAttribute('fill')).not.toBe('currentColor')
    })
  })

  it.each(STATES)('SI-3 %s: the toggle folds once and does not select', (_label, state) => {
    const onSelect = vi.fn()
    const onToggleSubs = vi.fn()
    render({ subCount: 2, onSelect, onToggleSubs, ...state })
    act(() => toggle()!.click())
    expect(onToggleSubs.mock.calls).toEqual([['s1']])
    expect(onSelect).not.toHaveBeenCalled()
  })

  it.each(STATES)('SI-3 %s: a row click selects and does not fold', (_label, state) => {
    const onSelect = vi.fn()
    const onToggleSubs = vi.fn()
    render({ subCount: 2, onSelect, onToggleSubs, ...state })
    act(() => row().click())
    expect(onSelect.mock.calls).toEqual([['s1']])
    expect(onToggleSubs).not.toHaveBeenCalled()
  })

  it('SI-3 still works after rerendering idle to streaming in the same root (the icon element swaps)', () => {
    const onSelect = vi.fn()
    const onToggleSubs = vi.fn()
    const props = { subCount: 2, onSelect, onToggleSubs }
    render(props)
    const button = toggle()
    expect(icon().classList.contains('lucide-messages-square')).toBe(true)

    render({ ...props, isStreaming: true })
    expect(icon().classList.contains('lucide-messages-square-solid')).toBe(true)
    // 换的是图标，钮还是那个钮
    expect(toggle()).toBe(button)

    act(() => icon().dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onToggleSubs.mock.calls).toEqual([['s1']])
    expect(onSelect).not.toHaveBeenCalled()

    act(() => row().click())
    expect(onSelect.mock.calls).toEqual([['s1']])
    expect(onToggleSubs).toHaveBeenCalledTimes(1)
  })

  it('SI-3 no sub-sessions: no toggle', () => {
    render({ subCount: 0, onToggleSubs: vi.fn(), isStreaming: true })
    expect(toggle()).toBeNull()
  })

  it.each<[string, Partial<SessionItemProps>, boolean]>([
    ['idle', {}, false],
    ['active only', { active: true }, false],
    ['streaming', { isStreaming: true }, true],
    ['active and streaming', { active: true, isStreaming: true }, true],
    ['sub-session idle', { isSub: true }, false],
    ['sub-session active only', { isSub: true, active: true }, false],
    ['sub-session streaming', { isSub: true, isStreaming: true }, true],
    ['with sub-sessions, active only', { subCount: 2, active: true }, false],
    ['with sub-sessions, streaming', { subCount: 2, isStreaming: true }, true]
  ])('SI-4 data-running: %s', (_label, props, running) => {
    render(props)
    expect(row().hasAttribute('data-running')).toBe(running)
  })

  it('SI-4 data-running goes away when the row stops running', () => {
    render({ isStreaming: true })
    expect(row().hasAttribute('data-running')).toBe(true)
    render({ isStreaming: false })
    expect(row().hasAttribute('data-running')).toBe(false)
  })
})
