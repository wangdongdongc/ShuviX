// @vitest-environment jsdom
/**
 * SessionItem 的「被中断」圆点（jsdom，P3-12-14，Q-P3-10）：
 *
 *   - `interrupted` → `[data-interrupted]`，带悬浮提示；
 *   - 在跑（`run`，agent 与只剩后台命令都算）时不显示圆点；
 *   - 与待答询问计数并存；
 *   - 顶层行、子会话行（`isSub`）、bot 行都一样。
 *
 * 另：SR-1 每一行（顶层行、子会话行）的根节点都带 `data-session-row` —— 手机布局的 CSS 认它把行加高（40px）。
 *
 * 有子会话的行（选中 / 在跑时用实心图标，「在跑」含后台任务，由容器合起来传入 run）：
 *   SI-1 图标矩阵：空闲线框；选中实心不闪；agent 在干活实心 + 闪（蓝色）；两者都有实心 + 闪。只剩后台命令
 *        （resident）实心不闪（绿色，见 SI-6）。实心版每条路径都闭合（否则 fill 出一道切口）
 *   SI-2 bot / 触发运行 / 悬浮 / 笔记本 + 子会话：身份图标不变，从不实心，折叠钮还在
 *   SI-3 折叠钮：点钮只折叠（一次、不选中），点行只选中；空闲 → 在跑重渲染之后也一样；没有子会话就没有钮
 *   SI-4 data-running 只跟 run：子会话行也一样；只选中没有
 *
 * 在跑的两种（S1，2026-11-11）：
 *   SI-5 普通行 resident：`data-run="resident"`，一片实心对话框、绿色、不动；agent → `data-run="agent"`；停着没有
 *   SI-6 有子会话的行 resident（含选中）：实心两片、绿色、不动
 *   SI-7 悬停提示：没有子会话时图标自己的 `<title>`；有子会话时并进折叠钮的 title（「N 个子会话 · …」）
 *   SI-8 未读点：agent 在干活 / 有询问时不画；只剩后台命令照画；出错红点；不是未读不画
 *   SI-9 标题加粗只跟未读
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

  it('P3-12-14 a running session suppresses the dot', () => {
    render({ interrupted: true, run: 'agent' })
    expect(dot()).toBeNull()
  })

  it('P3-12-14 a session with only background commands running suppresses the dot too', () => {
    render({ interrupted: true, run: 'resident' })
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
    ['idle', { active: false, run: null }],
    ['active', { active: true, run: null }],
    ['streaming', { active: false, run: 'agent' }],
    ['active and streaming', { active: true, run: 'agent' }],
    ['resident', { run: 'resident' }],
    ['active and resident', { active: true, run: 'resident' }]
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
    ['streaming only', { run: 'agent' }, true],
    ['active and streaming', { active: true, run: 'agent' }, true]
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

    render({ ...props, run: 'agent' })
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
    render({ subCount: 0, onToggleSubs: vi.fn(), run: 'agent' })
    expect(toggle()).toBeNull()
  })

  it.each<[string, Partial<SessionItemProps>, boolean]>([
    ['idle', {}, false],
    ['active only', { active: true }, false],
    ['streaming', { run: 'agent' }, true],
    ['active and streaming', { active: true, run: 'agent' }, true],
    ['sub-session idle', { isSub: true }, false],
    ['sub-session active only', { isSub: true, active: true }, false],
    ['sub-session streaming', { isSub: true, run: 'agent' }, true],
    ['with sub-sessions, active only', { subCount: 2, active: true }, false],
    ['with sub-sessions, streaming', { subCount: 2, run: 'agent' }, true]
  ])('SI-4 data-running: %s', (_label, props, running) => {
    render(props)
    expect(row().hasAttribute('data-running')).toBe(running)
  })

  it('SI-4 data-running goes away when the row stops running', () => {
    render({ run: 'agent' })
    expect(row().hasAttribute('data-running')).toBe(true)
    render({ run: null })
    expect(row().hasAttribute('data-running')).toBe(false)
  })
})

describe('run kinds (S1)', () => {
  const row = (): HTMLElement => container.querySelector<HTMLElement>('[data-session-row]')!
  const rowIcon = (): SVGElement => {
    const svg = row().querySelector('svg')
    if (!svg) throw new Error('no icon in the row')
    return svg
  }
  const toggle = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('button[data-subs-toggle]')
  const svgTitle = (svg: SVGElement): string | null => {
    const title = [...svg.children].find((el) => el.tagName.toLowerCase() === 'title')
    return title ? (title.textContent ?? '') : null
  }
  const titleSpan = (): HTMLElement => {
    const span = [...row().querySelectorAll<HTMLElement>('span.truncate')].find(
      (el) => el.textContent === 'Session one'
    )
    if (!span) throw new Error('no title span')
    return span
  }
  const unreadDot = (): HTMLElement | null => row().querySelector<HTMLElement>('[data-unread]')
  const subsText = (count: number): string =>
    en.sidebar.subSessions.replace('{{count}}', String(count))

  describe('SI-5 a plain row with only background commands', () => {
    it('SI-5 resident: data-run, data-running, solid green bubble, still', () => {
      render({ run: 'resident' })
      expect(row().getAttribute('data-run')).toBe('resident')
      expect(row().hasAttribute('data-running')).toBe(true)
      const svg = rowIcon()
      expect(svg.classList.contains('lucide-message-square')).toBe(true)
      expect(svg.getAttribute('fill')).toBe('currentColor')
      expect(svg.classList.contains('text-success')).toBe(true)
      expect(svg.classList.contains('animate-pulse')).toBe(false)
      expect(svg.classList.contains('text-accent')).toBe(false)
    })

    it('SI-5 agent → data-run="agent"; idle → no data-run', () => {
      render({ run: 'agent' })
      expect(row().getAttribute('data-run')).toBe('agent')
      render({ run: null })
      expect(row().hasAttribute('data-run')).toBe(false)
    })
  })

  it.each<[string, Partial<SessionItemProps>]>([
    ['resident', { run: 'resident' }],
    ['active and resident', { active: true, run: 'resident' }]
  ])('SI-6 a row with sub-sessions, %s: the solid icon, green, still', (_label, props) => {
    render({ subCount: 2, ...props })
    const svg = toggle()!.querySelector('svg')!
    expect(svg.classList.contains('lucide-messages-square-solid')).toBe(true)
    expect(svg.getAttribute('fill')).toBe('currentColor')
    expect(svg.classList.contains('text-success')).toBe(true)
    expect(svg.classList.contains('animate-pulse')).toBe(false)
    expect(svg.classList.contains('text-accent')).toBe(false)
  })

  describe('SI-7 hover label', () => {
    it.each<[string, Partial<SessionItemProps>, string | null]>([
      ['agent', { run: 'agent' }, en.sidebar.runAgent],
      ['resident', { run: 'resident' }, en.sidebar.runResident],
      ['idle', { run: null }, null]
    ])('SI-7 no sub-sessions, %s: the icon carries its own <title>', (_label, props, expected) => {
      render(props)
      expect(svgTitle(rowIcon())).toBe(expected)
    })

    it.each<[string, Partial<SessionItemProps>, string]>([
      ['agent', { run: 'agent' }, `${subsText(2)} · ${en.sidebar.runAgent}`],
      ['resident', { run: 'resident' }, `${subsText(2)} · ${en.sidebar.runResident}`],
      ['idle', { run: null }, subsText(2)]
    ])(
      'SI-7 with sub-sessions, %s: the label joins the toggle title',
      (_label, props, expected) => {
        render({ subCount: 2, ...props })
        expect(svgTitle(toggle()!.querySelector('svg')!)).toBeNull()
        expect(toggle()!.title).toBe(expected)
        expect(toggle()!.title.endsWith(' · ')).toBe(false)
      }
    )
  })

  describe('SI-8 the unread dot', () => {
    it.each<[string, Partial<SessionItemProps>]>([
      ['unread and idle', { unread: true }],
      ['unread and resident', { unread: true, run: 'resident' }]
    ])('SI-8 %s: a blue dot', (_label, props) => {
      render(props)
      const el = unreadDot()
      expect(el).not.toBeNull()
      expect(el!.getAttribute('data-unread')).toBe('')
      expect(el!.classList.contains('bg-accent')).toBe(true)
      expect(el!.title).toBe(en.sidebar.unread)
    })

    it('SI-8 unread and agent working: no dot', () => {
      render({ unread: true, run: 'agent' })
      expect(unreadDot()).toBeNull()
    })

    it('SI-8 unread, resident, one pending ask: no dot, the ask badge instead', () => {
      render({ unread: true, run: 'resident', pendingCount: 1 })
      expect(unreadDot()).toBeNull()
      expect(row().querySelector('[data-pending-asks="1"]')).not.toBeNull()
    })

    it('SI-8 unread, idle, two pending asks: no dot', () => {
      render({ unread: true, pendingCount: 2 })
      expect(unreadDot()).toBeNull()
    })

    it('SI-8 unread, resident, failed: a red dot', () => {
      render({ unread: true, run: 'resident', unreadFailed: true })
      const el = unreadDot()
      expect(el).not.toBeNull()
      expect(el!.getAttribute('data-unread')).toBe('failed')
      expect(el!.classList.contains('bg-error')).toBe(true)
      expect(el!.title).toBe(en.inbox.failed)
    })

    it('SI-8 not unread but unreadFailed: no dot', () => {
      render({ unreadFailed: true })
      expect(unreadDot()).toBeNull()
    })
  })

  describe('SI-9 the bold title follows unread only', () => {
    it.each<[string, Partial<SessionItemProps>, boolean]>([
      ['unread and agent working', { unread: true, run: 'agent' }, true],
      ['unread with a pending ask', { unread: true, pendingCount: 1 }, true],
      ['not unread', {}, false],
      ['not unread, resident', { run: 'resident' }, false]
    ])('SI-9 %s', (_label, props, bold) => {
      render(props)
      expect(titleSpan().classList.contains('font-semibold')).toBe(bold)
    })
  })
})
