// @vitest-environment jsdom
/**
 * 侧栏的视图切换 `SidebarViewSwitch`（2026-11-16；jsdom）—— 只有图标的三段：会话 / 收件箱 / 日历。
 *
 * 契约：
 *   - 三种视图的顺序固定；认不得的值一律当成 `sessions`（`toSidebarView`）；
 *   - 根是 `role="group"`，`data-sidebar-view-switch` = 当前视图；三枚 `button[data-sidebar-view]`，当前那枚
 *     `aria-pressed="true"`；
 *   - 收件箱那一段带 `data-inbox-count`；有条数时名字后面接「 · N」（悬停提示 / 读屏），数字不画出来；
 *   - `inboxAlert` → 收件箱那一段上一个 `[data-view-alert]`，与条数、与是否选中都无关；
 *   - 点没选中的一段调 `onChange(那一段)`，点选中的那段什么都不做；受控（自己不记状态）；
 *   - `size="touch"` 只换尺寸。
 *
 * 文件是 `.ts`，一律 createElement。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import {
  SIDEBAR_VIEWS,
  SIDEBAR_VIEW_LABEL_KEYS,
  SidebarViewSwitch,
  toSidebarView,
  type SidebarView,
  type SidebarViewSwitchProps
} from './SidebarViewSwitch'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function render(props: Partial<SidebarViewSwitchProps> = {}): void {
  act(() =>
    root.render(
      createElement(SidebarViewSwitch, { value: 'sessions', onChange: () => {}, ...props })
    )
  )
}

const rootEl = (): HTMLElement =>
  container.querySelector('[data-sidebar-view-switch]') as HTMLElement
const buttons = (): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-sidebar-view]'))
const seg = (view: SidebarView): HTMLButtonElement =>
  container.querySelector(`button[data-sidebar-view="${view}"]`) as HTMLButtonElement

/** 点路径取值（locale JSON） */
function lookup(obj: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj)
}

const NAMES: Record<SidebarView, string> = {
  sessions: en.sidebar.viewSessions,
  inbox: en.inbox.title,
  calendar: en.panel.calendar
}

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

describe('sidebar views: pure pieces', () => {
  it('VS-1 the three views, in order', () => {
    expect([...SIDEBAR_VIEWS]).toEqual(['sessions', 'inbox', 'calendar'])
  })

  it('VS-2 toSidebarView keeps the three valid values', () => {
    for (const view of SIDEBAR_VIEWS) expect(toSidebarView(view)).toBe(view)
  })

  it.each([
    [undefined],
    [null],
    [''],
    ['Inbox'],
    [' inbox'],
    ['widget'],
    ['files'],
    [0],
    [1],
    [true],
    [{}],
    [['inbox']]
  ])('VS-3 toSidebarView(%j) falls back to sessions', (value) => {
    expect(toSidebarView(value)).toBe('sessions')
  })

  it('VS-4 the label keys', () => {
    expect(SIDEBAR_VIEW_LABEL_KEYS).toEqual({
      sessions: 'sidebar.viewSessions',
      inbox: 'inbox.title',
      calendar: 'panel.calendar'
    })
  })

  it.each([
    ['en', en],
    ['zh', zh],
    ['ja', ja]
  ])('VS-5 every label and the group name exist in %s', (_lang, locale) => {
    for (const key of [...Object.values(SIDEBAR_VIEW_LABEL_KEYS), 'sidebar.viewSwitch']) {
      const value = lookup(locale, key)
      expect(typeof value, key).toBe('string')
      expect((value as string).trim(), key).not.toBe('')
      expect(value, key).not.toBe(key)
    }
  })

  it.each([
    ['en', en],
    ['zh', zh],
    ['ja', ja]
  ])('VS-5b the removed phone toggle strings are gone from %s', (_lang, locale) => {
    expect(lookup(locale, 'mobile.list')).toBeUndefined()
    expect(lookup(locale, 'mobile.calendar')).toBeUndefined()
  })

  it('VS-6 the barrel exports the switch and no InboxRow', () => {
    // 整只 barrel 在 jsdom 里太重：读源文件
    const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf8')
    const block = source.match(/export \{([^}]*)\} from '\.\/sidebar\/SidebarViewSwitch'/)
    expect(block).not.toBeNull()
    const names = block![1].split(',').map((s) => s.trim())
    expect(names).toEqual(
      expect.arrayContaining([
        'SidebarViewSwitch',
        'SIDEBAR_VIEWS',
        'SIDEBAR_VIEW_LABEL_KEYS',
        'toSidebarView'
      ])
    )
    expect(source).not.toContain('InboxRow')
  })
})

describe('SidebarViewSwitch', () => {
  it.each(SIDEBAR_VIEWS.map((v) => [v]))('VS-7 root reflects value %s', (value) => {
    render({ value })
    const el = rootEl()
    expect(el.getAttribute('data-sidebar-view-switch')).toBe(value)
    expect(el.getAttribute('role')).toBe('group')
    expect(el.getAttribute('aria-label')).toBe(en.sidebar.viewSwitch)
  })

  it('VS-8 three buttons in order, each type=button', () => {
    render()
    const list = buttons()
    expect(list.map((b) => b.getAttribute('data-sidebar-view'))).toEqual([
      'sessions',
      'inbox',
      'calendar'
    ])
    for (const b of list) expect(b.getAttribute('type')).toBe('button')
  })

  it.each(SIDEBAR_VIEWS.map((v) => [v]))('VS-9 only %s is pressed', (value) => {
    render({ value })
    for (const b of buttons()) {
      expect(b.getAttribute('aria-pressed')).toBe(
        b.getAttribute('data-sidebar-view') === value ? 'true' : 'false'
      )
    }
  })

  it('VS-10 sessions / calendar: aria-label and title are the names', () => {
    render({ inboxCount: 4 })
    for (const view of ['sessions', 'calendar'] as const) {
      expect(seg(view).getAttribute('aria-label')).toBe(NAMES[view])
      expect(seg(view).getAttribute('title')).toBe(NAMES[view])
    }
  })

  it.each([[undefined], [0]])('VS-11 inboxCount %s: bare name, count 0', (inboxCount) => {
    render({ inboxCount })
    expect(seg('inbox').getAttribute('aria-label')).toBe(NAMES.inbox)
    expect(seg('inbox').getAttribute('title')).toBe(NAMES.inbox)
    expect(seg('inbox').getAttribute('aria-label')).not.toContain(' · ')
    expect(seg('inbox').getAttribute('data-inbox-count')).toBe('0')
  })

  it('VS-12 inboxCount 3: the count is in the label, on the inbox segment only', () => {
    render({ inboxCount: 3 })
    expect(seg('inbox').getAttribute('aria-label')).toBe(`${NAMES.inbox} · 3`)
    expect(seg('inbox').getAttribute('title')).toBe(`${NAMES.inbox} · 3`)
    expect(seg('inbox').getAttribute('data-inbox-count')).toBe('3')
    for (const view of ['sessions', 'calendar'] as const) {
      expect(seg(view).getAttribute('aria-label')).toBe(NAMES[view])
      expect(seg(view).hasAttribute('data-inbox-count')).toBe(false)
    }
  })

  it('VS-13 no number is drawn', () => {
    render({ inboxCount: 12, inboxAlert: true })
    expect(rootEl().textContent).toBe('')
  })

  it('VS-14 the alert dot: none by default, one inside the inbox segment when set', () => {
    render()
    expect(container.querySelector('[data-view-alert]')).toBeNull()
    render({ inboxAlert: false })
    expect(container.querySelector('[data-view-alert]')).toBeNull()
    render({ inboxAlert: true })
    const dots = container.querySelectorAll('[data-view-alert]')
    expect(dots.length).toBe(1)
    expect(seg('inbox').contains(dots[0])).toBe(true)
  })

  it('VS-15 the alert does not depend on the count', () => {
    render({ inboxAlert: true, inboxCount: 0 })
    expect(container.querySelectorAll('[data-view-alert]').length).toBe(1)
    render({ inboxCount: 5 })
    expect(container.querySelector('[data-view-alert]')).toBeNull()
  })

  it('VS-16 the alert shows on the active inbox segment too', () => {
    render({ value: 'inbox', inboxAlert: true })
    expect(seg('inbox').querySelector('[data-view-alert]')).not.toBeNull()
  })

  it.each([
    ['sessions', 'inbox'],
    ['sessions', 'calendar'],
    ['inbox', 'sessions'],
    ['inbox', 'calendar'],
    ['calendar', 'sessions'],
    ['calendar', 'inbox']
  ] as [SidebarView, SidebarView][])('VS-17 %s → click %s calls onChange once', (from, to) => {
    const onChange = vi.fn()
    render({ value: from, onChange })
    act(() => seg(to).click())
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(to)
  })

  it.each(SIDEBAR_VIEWS.map((v) => [v]))('VS-18 clicking the active %s does nothing', (value) => {
    const onChange = vi.fn()
    render({ value, onChange })
    act(() => seg(value).click())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('VS-19 controlled: pressed follows the prop, not the click', () => {
    const onChange = vi.fn()
    render({ value: 'sessions', onChange })
    act(() => seg('calendar').click())
    expect(seg('sessions').getAttribute('aria-pressed')).toBe('true')
    expect(seg('calendar').getAttribute('aria-pressed')).toBe('false')
    render({ value: 'calendar', onChange })
    expect(seg('sessions').getAttribute('aria-pressed')).toBe('false')
    expect(seg('calendar').getAttribute('aria-pressed')).toBe('true')
    expect(rootEl().getAttribute('data-sidebar-view-switch')).toBe('calendar')
  })

  it('VS-20 a click on the alert dot bubbles to the inbox segment', () => {
    const onChange = vi.fn()
    render({ value: 'sessions', onChange, inboxAlert: true })
    const dot = container.querySelector('[data-view-alert]') as HTMLElement
    act(() => dot.click())
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('inbox')
  })

  it('VS-21 size="touch" changes nothing but the size', () => {
    const snapshot = (): Record<string, string>[] =>
      [rootEl(), ...buttons()].map((el) =>
        Object.fromEntries(
          Array.from(el.attributes)
            .filter((a) => a.name !== 'class')
            .map((a) => [a.name, a.value])
        )
      )
    render({ value: 'inbox', inboxCount: 2, inboxAlert: true })
    const regular = snapshot()
    const onChange = vi.fn()
    render({ value: 'inbox', inboxCount: 2, inboxAlert: true, size: 'touch', onChange })
    expect(snapshot()).toEqual(regular)
    expect(container.querySelectorAll('[data-view-alert]').length).toBe(1)
    const icons = container.querySelectorAll('button[data-sidebar-view] svg')
    expect(icons.length).toBe(3)
    for (const icon of Array.from(icons)) expect(icon.getAttribute('aria-hidden')).toBe('true')
    act(() => seg('inbox').click())
    expect(onChange).not.toHaveBeenCalled()
    act(() => seg('sessions').click())
    expect(onChange).toHaveBeenCalledWith('sessions')
  })

  it('VS-22 className is appended; the default leaves no "undefined"', () => {
    render()
    expect(rootEl().className).not.toContain('undefined')
    render({ className: 'my-extra' })
    expect(rootEl().classList.contains('my-extra')).toBe(true)
    expect(rootEl().classList.contains('inline-flex')).toBe(true)
  })

  it('VS-23 a changed count updates the label and the attribute', () => {
    render({ inboxCount: 2 })
    expect(seg('inbox').getAttribute('aria-label')).toBe(`${NAMES.inbox} · 2`)
    render({ inboxCount: 0 })
    expect(seg('inbox').getAttribute('aria-label')).toBe(NAMES.inbox)
    expect(seg('inbox').getAttribute('title')).toBe(NAMES.inbox)
    expect(seg('inbox').getAttribute('data-inbox-count')).toBe('0')
  })
})
