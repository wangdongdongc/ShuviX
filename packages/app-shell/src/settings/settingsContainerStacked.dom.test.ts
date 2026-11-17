// @vitest-environment jsdom
/**
 * 设置容器的叠放布局（SettingsContainer `stacked`，web 客户端的手机布局；jsdom）。
 *
 * 契约：`stacked.showList` → 一列分区（标题 + 每个 tab 一行，DOM 序 = tabs 序，实验功能带「实验」小标签，
 * 点一行 = onTabChange(id)），不画任何分区内容、没有返回键；否则 → 头部是返回键（文字与 aria-label 都是标题，
 * 点它 = onBack）+ 当前分区名，下面只画当前分区的内容；activeTab 不认识 → 回落 tabs[0]。不传 stacked → 桌面的
 * 左侧导航 + 右侧内容，一样都不变。`SettingsRow` 的根节点带 `data-settings-row`（叠放布局的 CSS 认它），类名不变。
 *
 *   SC-1 列表视图：[data-settings-stacked]、标题、每个 tab 一行 [data-settings-tab=id]（顺序）、实验标签、没有内容、
 *        没有 [data-settings-back]；点一行 → onTabChange(id)
 *   SC-2 分区视图：返回键（标题文字 + aria-label）→ onBack，它那一行里只有它；当前分区名是那一行下面的
 *        大标题 h1[data-settings-heading]；只有当前分区的内容；不认识的 activeTab → tabs[0]
 *   SC-3 不传 stacked：没有叠放标记、没有返回键；桌面导航 + 内容照旧
 *   SC-4 SettingsRow 根节点带 data-settings-row，类名与之前相同
 *
 * 叠放布局的第二层（stackedSettings.tsx：分区自己经 `useStackedSubPage` 报「此刻开着一项的详情」）。返回键
 * 带 `data-settings-level`（`section` = 回设置列表，`item` = 回分区自己的列表），头部的名字在
 * `[data-settings-heading]`：
 *   SC-5 子组件报了一项 → level item；返回键的文字与 aria-label 是当前分区名（不是标题）；头部是这一项的名字；
 *        点返回 → 这一项的 onBack，不是容器的 onBack
 *   SC-6 同一个子组件改报 null → level section；返回键回到标题；头部是分区名；点返回 → 容器的 onBack
 *   SC-7 不留旧头部：报了一项之后 (a) 回列表再进一个什么都不报的分区内容 → section；(b) 切到另一个什么都不报的
 *        分区 → section、头部是它的名字；(c) 卸载不抛、没有 console.error
 *   SC-8 同一个标题、新的 onBack 再渲染：不再报一次；按下注册的 onBack 跑的是最新那个函数
 *   SC-9 标题变了（这一项还挂着）→ 头部跟着变，level 仍是 item
 *   SC-10 useStackedSettings：没有 provider / 桌面容器里 → false，叠放的分区里 → true；没有 provider 时
 *         useStackedSubPage 不抛
 *   SLR-1 StackedListRow：role=button、tabIndex 0、data-stacked-row + 传入的 data-*、标签文字；trailing 紧挨在
 *         行尾 › 之前；min-h-[48px]
 *   SLR-2 点一下 → onClick 一次；Enter / 空格各一次且 preventDefault；a / Tab / Escape 不触发
 *   SLR-3 dimmed → opacity-60；没给 icon → 没有图标那一格
 *
 * 分区列表的分组卡片与行尾的值、层数与浏览器历史（useStackedHistory 接在容器上）：
 *   SC-11 / SC-12 相同 `group` 的分区收进同一张 [data-settings-nav-card]，卡片按各组第一次出现的先后排，没有 group 的
 *         各自一张；行的 DOM 序 = tabs 序（没有 group 时）
 *   SC-13 / SC-14 行尾的值 [data-settings-tab-value]（undefined / null 不画，0 照画），行尾都是 ›，标签里只有名字
 *   SC-15 / SC-16 onDepthChange：列表 0 / 分区 1 / 分区里的一项 2；层数没变不再报，换了函数再报一次
 *   SC-17 / SC-18 列表 → 分区 → 一项：各压一条历史（shuvixSettingsDepth 1、2），原有的记号留着
 *   SC-19 / SC-20 返回手势一层一层退；go(-2) 一步回到列表
 *   SC-21 / SC-22 顶栏的返回键：退掉那一层压的那一条（go(-1) 一次），popstate 回来不再动
 *   SC-23 挂上就在分区里（基线）：不压；返回键回列表也不退历史
 *   SC-24 不传 stacked：没有卡片、没有值，不碰历史
 *   SC-25 历史接上之后第二层的顶栏照旧（返回键写分区名、大标题是这一项）
 *
 * 历史的卫生：jsdom 的 history.back() / go() 异步发 popstate。每条用例开头 `replaceState(null)`；会退历史的动作在
 * `awaitPop` 里等到 popstate；`afterEach` 再让出一拍，免得没落地的跳转落进下一条用例（SC-5..SC-9 里分区一挂上
 * 就报一项，会顺带压 / 退历史）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useMemo, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import {
  SettingsContainer,
  type SettingsContainerProps,
  type SettingsTab
} from './SettingsContainer'
import { SettingsRow } from './SettingsPrimitives'
import {
  StackedListRow,
  StackedSettingsProvider,
  useStackedSettings,
  useStackedSubPage,
  type StackedSubPage
} from './stackedSettings'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const content = (id: string): React.ReactNode =>
  createElement('div', { 'data-content': id }, `content of ${id}`)

const TABS: SettingsTab[] = [
  { id: 'general', label: 'General', icon: createElement('i'), content: content('general') },
  {
    id: 'voice',
    label: 'Voice',
    icon: createElement('i'),
    experimental: 'voice',
    content: content('voice')
  },
  { id: 'about', label: 'About', icon: createElement('i'), content: content('about') }
]

function render(props: Partial<SettingsContainerProps>): void {
  act(() =>
    root.render(
      createElement(SettingsContainer, {
        tabs: TABS,
        activeTab: 'general',
        onTabChange: () => {},
        title: 'Settings',
        ...props
      })
    )
  )
}

const q = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel)
const qa = (sel: string): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(sel)]
const contents = (): string[] =>
  qa('[data-content]').map((el) => el.getAttribute('data-content') ?? '')

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  window.history.replaceState(null, '')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  // 没落地的历史跳转（层数变浅时容器会 history.go）：别让它落进下一条用例
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('SettingsContainer stacked layout', () => {
  it('SC-1 the list view: title, one row per tab in order, experimental tags, no content, no back button', () => {
    const onTabChange = vi.fn()
    const onBack = vi.fn()
    render({ onTabChange, stacked: { showList: true, onBack } })
    const stackedRoot = q('[data-settings-stacked]')
    expect(stackedRoot).not.toBeNull()
    expect(stackedRoot!.textContent).toContain('Settings')
    const rows = qa('[data-settings-tab]')
    expect(rows.map((r) => r.getAttribute('data-settings-tab'))).toEqual([
      'general',
      'voice',
      'about'
    ])
    expect(rows.map((r) => (r.textContent ?? '').replace(en.experimental.tag, '').trim())).toEqual([
      'General',
      'Voice',
      'About'
    ])
    expect(
      rows.map(
        (r) => r.querySelector('[data-experimental]')?.getAttribute('data-experimental') ?? null
      )
    ).toEqual([null, 'voice', null])
    expect(rows[1].querySelector('[data-experimental]')?.textContent).toBe(en.experimental.tag)
    expect(contents()).toEqual([])
    expect(q('[data-settings-back]')).toBeNull()

    act(() => rows[2].click())
    expect(onTabChange).toHaveBeenCalledTimes(1)
    expect(onTabChange).toHaveBeenCalledWith('about')
    expect(onBack).not.toHaveBeenCalled()
  })

  it('SC-2 the section view: a back button named by the title alone in its row, the active label as the heading below, only the active content', () => {
    const onBack = vi.fn()
    render({ activeTab: 'voice', stacked: { showList: false, onBack } })
    expect(q('[data-settings-stacked]')).not.toBeNull()
    const back = q('[data-settings-back]')
    expect(back).not.toBeNull()
    expect(back!.getAttribute('aria-label')).toBe('Settings')
    expect((back!.textContent ?? '').trim()).toBe('Settings')
    // 没有子页：第一层（回设置列表），头部名字是当前分区
    expect(back!.getAttribute('data-settings-level')).toBe('section')
    expect(q('[data-settings-heading]')?.textContent).toBe('Voice')
    // 返回键那一行里只有它；分区名是这一行下面的大标题
    const backRow = back!.parentElement!
    expect(backRow.children).toHaveLength(1)
    expect((backRow.textContent ?? '').trim()).toBe('Settings')
    const headingEl = q('[data-settings-heading]')!
    expect(headingEl.tagName).toBe('H1')
    expect(backRow.nextElementSibling).toBe(headingEl)
    expect(contents()).toEqual(['voice'])
    expect(qa('[data-settings-tab]')).toEqual([])

    act(() => back!.click())
    expect(onBack).toHaveBeenCalledTimes(1)

    // 不认识的 activeTab → tabs[0]
    render({ activeTab: 'nope', stacked: { showList: false, onBack } })
    expect(contents()).toEqual(['general'])
    expect(q('[data-settings-heading]')?.textContent).toBe('General')
    expect((q('[data-settings-back]')!.parentElement!.textContent ?? '').trim()).toBe('Settings')
  })

  it('SC-3 without stacked the desktop layout is unchanged: nav + content, no stacked marker, no back button', () => {
    const onTabChange = vi.fn()
    render({ activeTab: 'about', onTabChange })
    expect(q('[data-settings-stacked]')).toBeNull()
    expect(q('[data-settings-back]')).toBeNull()
    expect(qa('[data-settings-tab]')).toEqual([])
    const nav = q('[data-settings-nav]')
    expect(nav).not.toBeNull()
    expect(qa('[data-settings-nav] [data-tab-label]').map((el) => el.textContent)).toEqual([
      'General',
      'Voice',
      'About'
    ])
    expect(contents()).toEqual(['about'])
    const buttons = [...nav!.querySelectorAll('button')]
    act(() => buttons[0].click())
    expect(onTabChange).toHaveBeenCalledWith('general')
  })

  it('SC-4 SettingsRow carries data-settings-row with the same classes as before', () => {
    act(() =>
      root.render(createElement(SettingsRow, { title: 'Row', control: createElement('input') }))
    )
    const row = container.firstElementChild as HTMLElement
    expect(row.hasAttribute('data-settings-row')).toBe(true)
    expect(row.className).toBe('flex items-center justify-between gap-3 px-4 py-3')
  })
})

/** 分区内容里的假子组件：把用例给的 page 原样报上去 */
function ItemChild({ page }: { page: StackedSubPage | null }): React.JSX.Element {
  useStackedSubPage(page)
  return createElement('div', { 'data-content': 'item-child' }, page?.title ?? 'list')
}

/** 把 useStackedSettings() 的答案写进 DOM */
function StackedProbe(): React.JSX.Element {
  return createElement('div', { 'data-probe': String(useStackedSettings()) })
}

const level = (): string | null =>
  q('[data-settings-back]')?.getAttribute('data-settings-level') ?? null
const heading = (): string | null => q('[data-settings-heading]')?.textContent ?? null
const backText = (): string => (q('[data-settings-back]')?.textContent ?? '').trim()
const backAria = (): string | null => q('[data-settings-back]')?.getAttribute('aria-label') ?? null
const clickBack = (): void => act(() => q('[data-settings-back]')!.click())

/** 一个分区，内容是报 `page` 的假子组件 */
const itemTab = (page: StackedSubPage | null, id = 'general', label = 'General'): SettingsTab => ({
  id,
  label,
  content: createElement(ItemChild, { page })
})

describe('SettingsContainer stacked: the second level (a sub-page declared by the section)', () => {
  it('SC-5 an item declared by the section: level item, back named by the section, heading = the item; back = the item’s onBack', () => {
    const spyItem = vi.fn()
    const spySection = vi.fn()
    render({
      tabs: [itemTab({ title: 'Item X', onBack: spyItem })],
      stacked: { showList: false, onBack: spySection }
    })
    expect(level()).toBe('item')
    expect(backText()).toBe('General')
    expect(backAria()).toBe('General')
    expect(backText()).not.toBe('Settings')
    expect(heading()).toBe('Item X')

    clickBack()
    expect(spyItem).toHaveBeenCalledTimes(1)
    expect(spySection).not.toHaveBeenCalled()
  })

  it('SC-6 the same child declaring null again: level section, back = the title, heading = the section; back = the container’s onBack', () => {
    const spyItem = vi.fn()
    const spySection = vi.fn()
    const stacked = { showList: false, onBack: spySection }
    render({ tabs: [itemTab({ title: 'Item X', onBack: spyItem })], stacked })
    expect(level()).toBe('item')

    render({ tabs: [itemTab(null)], stacked })
    expect(level()).toBe('section')
    expect(backText()).toBe('Settings')
    expect(backAria()).toBe('Settings')
    expect(heading()).toBe('General')

    clickBack()
    expect(spySection).toHaveBeenCalledTimes(1)
    expect(spyItem).not.toHaveBeenCalled()
  })

  it('SC-7a no stale header after going back to the list and into a section that declares nothing', () => {
    const onBack = vi.fn()
    render({
      tabs: [itemTab({ title: 'Item X', onBack: vi.fn() })],
      stacked: { showList: false, onBack }
    })
    expect(level()).toBe('item')

    render({
      tabs: [itemTab({ title: 'Item X', onBack: vi.fn() })],
      stacked: { showList: true, onBack }
    })
    expect(q('[data-settings-back]')).toBeNull()

    // 这一回的内容根本不调 useStackedSubPage —— 头部只能靠上一回卸载时撤掉的那一下
    render({
      tabs: [{ id: 'general', label: 'General', content: content('general') }],
      stacked: { showList: false, onBack }
    })
    expect(level()).toBe('section')
    expect(heading()).toBe('General')
    expect(backText()).toBe('Settings')
  })

  it('SC-7b no stale header after switching to another section that declares nothing', () => {
    const onBack = vi.fn()
    const tabs: SettingsTab[] = [
      itemTab({ title: 'Item X', onBack: vi.fn() }),
      { id: 'about', label: 'About', content: content('about') }
    ]
    render({ tabs, stacked: { showList: false, onBack } })
    expect(level()).toBe('item')

    render({ tabs, activeTab: 'about', stacked: { showList: false, onBack } })
    expect(contents()).toEqual(['about'])
    expect(level()).toBe('section')
    expect(heading()).toBe('About')
    expect(backText()).toBe('Settings')
  })

  it('SC-7c unmounting with an item open throws nothing and logs no console error', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render({
        tabs: [itemTab({ title: 'Item X', onBack: vi.fn() })],
        stacked: { showList: false, onBack: vi.fn() }
      })
      expect(level()).toBe('item')
      expect(() => act(() => root.unmount())).not.toThrow()
      expect(errors).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })

  it('SC-8 the same title with a new onBack is not re-declared; the registered onBack runs the latest function', () => {
    const setSubPage = vi.fn()
    const value = { setSubPage }
    const first = vi.fn()
    const latest = vi.fn()
    const mount = (onBack: () => void): void =>
      act(() =>
        root.render(
          createElement(
            StackedSettingsProvider,
            { value },
            createElement(ItemChild, { page: { title: 'Same', onBack } })
          )
        )
      )
    mount(first)
    expect(setSubPage).toHaveBeenCalledTimes(1)
    const registered = setSubPage.mock.calls[0][0] as StackedSubPage
    expect(registered.title).toBe('Same')

    mount(latest)
    expect(setSubPage).toHaveBeenCalledTimes(1)

    act(() => registered.onBack())
    expect(latest).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('SC-9 a new title while the item stays mounted updates the heading; the level stays item', () => {
    const onBack = vi.fn()
    const stacked = { showList: false, onBack: vi.fn() }
    render({ tabs: [itemTab({ title: 'Old name', onBack })], stacked })
    expect(heading()).toBe('Old name')

    render({ tabs: [itemTab({ title: 'New name', onBack })], stacked })
    expect(heading()).toBe('New name')
    expect(level()).toBe('item')
    expect(backText()).toBe('General')
  })

  it('SC-10 useStackedSettings: false without a provider and in the desktop container, true in a stacked section; useStackedSubPage without a provider does not throw', () => {
    act(() => root.render(createElement(StackedProbe)))
    expect(q('[data-probe]')?.getAttribute('data-probe')).toBe('false')

    const probeTab: SettingsTab = {
      id: 'general',
      label: 'General',
      content: createElement(StackedProbe)
    }
    render({ tabs: [probeTab] })
    expect(q('[data-settings-stacked]')).toBeNull()
    expect(q('[data-probe]')?.getAttribute('data-probe')).toBe('false')

    render({ tabs: [probeTab], stacked: { showList: false, onBack: vi.fn() } })
    expect(q('[data-probe]')?.getAttribute('data-probe')).toBe('true')

    expect(() =>
      act(() =>
        root.render(createElement(ItemChild, { page: { title: 'Loose', onBack: vi.fn() } }))
      )
    ).not.toThrow()
    expect(contents()).toEqual(['item-child'])
  })
})

describe('StackedListRow', () => {
  function renderRow(props: Partial<Parameters<typeof StackedListRow>[0]> = {}): HTMLElement {
    act(() =>
      root.render(
        createElement(StackedListRow, {
          label: 'Row label',
          onClick: () => {},
          ...props
        })
      )
    )
    return container.firstElementChild as HTMLElement
  }
  const keydown = (el: HTMLElement, key: string): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    act(() => {
      el.dispatchEvent(event)
    })
    return event
  }

  it('SLR-1 a button-like row carrying the given data-*, the label, the trailing element right before the chevron, 48px tall', () => {
    const row = renderRow({
      rowProps: { 'data-provider-row': 'x' },
      icon: createElement('i', { 'data-icon': '' }),
      tag: createElement('em', { 'data-tag': '' }, 'tag'),
      trailing: createElement('b', { 'data-trailing': '' })
    })
    expect(row.getAttribute('role')).toBe('button')
    expect(row.tabIndex).toBe(0)
    expect(row.hasAttribute('data-stacked-row')).toBe(true)
    expect(row.getAttribute('data-provider-row')).toBe('x')
    expect(row.textContent).toContain('Row label')
    expect(row.querySelector('[data-icon]')).not.toBeNull()
    expect(row.querySelector('[data-tag]')).not.toBeNull()
    const chevron = row.lastElementChild!
    expect(chevron.tagName.toLowerCase()).toBe('svg')
    expect(chevron.previousElementSibling?.hasAttribute('data-trailing')).toBe(true)
    expect(row.className).toContain('min-h-[48px]')
  })

  it('SLR-2 a click and Enter / Space open it (Enter and Space prevent the default); other keys do not', () => {
    const onClick = vi.fn()
    const row = renderRow({ onClick })
    act(() => row.click())
    expect(onClick).toHaveBeenCalledTimes(1)

    const enter = keydown(row, 'Enter')
    expect(onClick).toHaveBeenCalledTimes(2)
    expect(enter.defaultPrevented).toBe(true)

    const space = keydown(row, ' ')
    expect(onClick).toHaveBeenCalledTimes(3)
    expect(space.defaultPrevented).toBe(true)

    for (const key of ['a', 'Tab', 'Escape']) keydown(row, key)
    expect(onClick).toHaveBeenCalledTimes(3)
  })

  it('SLR-3 dimmed adds opacity-60; without an icon there is no icon slot', () => {
    expect(renderRow().className).not.toContain('opacity-60')
    const dimmed = renderRow({ dimmed: true })
    expect(dimmed.className).toContain('opacity-60')
    // 没给 icon：第一格就是标签那一格
    expect(dimmed.firstElementChild?.textContent).toBe('Row label')
    const withoutIcon = dimmed.children.length
    const withIcon = renderRow({ icon: createElement('i', { 'data-icon': '' }) })
    expect(withIcon.firstElementChild?.querySelector('[data-icon]')).not.toBeNull()
    expect(withIcon.children).toHaveLength(withoutIcon + 1)
  })
})

const MARK = 'shuvixSettingsDepth'
const historyState = (): Record<string, unknown> | null =>
  window.history.state as Record<string, unknown> | null
const cardIds = (): string[][] =>
  qa('[data-settings-nav-card]').map((card) =>
    [...card.querySelectorAll('[data-settings-tab]')].map(
      (el) => el.getAttribute('data-settings-tab') ?? ''
    )
  )
const tabRow = (id: string): HTMLElement => q(`[data-settings-tab="${id}"]`)!
const plainTab = (id: string, extra: Partial<SettingsTab> = {}): SettingsTab => ({
  id,
  label: `Label ${id}`,
  content: content(id),
  ...extra
})

/**
 * 做一件会退一条历史的事，等到 popstate（jsdom 异步发）。`trigger` 在 act 外面跑（它自己带 act）：套进外层的
 * 异步 act，里层 act 的 effect 要等外层结束才跑，而外层正等着 effect 里那一下 history.go 的 popstate
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

describe('SettingsContainer stacked: grouped cards and row values', () => {
  it('SC-11 tabs sharing a group share a card; cards in first-appearance order; ungrouped tabs each get their own', () => {
    const tabs = [
      plainTab('a1', { group: 'a' }),
      plainTab('a2', { group: 'a' }),
      plainTab('b1', { group: 'b' }),
      plainTab('solo'),
      plainTab('b2', { group: 'b' }),
      plainTab('solo2')
    ]
    render({ tabs, stacked: { showList: true, onBack: vi.fn() } })
    expect(cardIds()).toEqual([['a1', 'a2'], ['b1', 'b2'], ['solo'], ['solo2']])
  })

  it('SC-12 tabs without groups: one card per row, rows in tabs order', () => {
    render({ stacked: { showList: true, onBack: vi.fn() } })
    expect(cardIds()).toEqual([['general'], ['voice'], ['about']])
    expect(qa('[data-settings-tab]').map((el) => el.getAttribute('data-settings-tab'))).toEqual(
      TABS.map((tab) => tab.id)
    )
  })

  it('SC-13 the row value: a number or a word at the end of the row, nothing for undefined / null; every row ends with a chevron', () => {
    const tabs = [
      plainTab('num', { value: 3 }),
      plainTab('word', { value: 'On' }),
      plainTab('undef', { value: undefined }),
      plainTab('nul', { value: null }),
      plainTab('exp', { value: 2, experimental: 'voice' })
    ]
    render({ tabs, stacked: { showList: true, onBack: vi.fn() } })
    const valueOf = (id: string): string | null =>
      tabRow(id).querySelector('[data-settings-tab-value]')?.textContent ?? null
    expect(valueOf('num')).toBe('3')
    expect(valueOf('word')).toBe('On')
    expect(valueOf('undef')).toBeNull()
    expect(valueOf('nul')).toBeNull()

    for (const tab of tabs) {
      const row = tabRow(tab.id)
      const chevron = [...row.querySelectorAll('svg')].at(-1)!
      expect(chevron, tab.id).toBeDefined()
      expect(chevron.parentElement!.lastElementChild, tab.id).toBe(chevron)
      const value = row.querySelector('[data-settings-tab-value]')
      if (value) expect(chevron.previousElementSibling, tab.id).toBe(value)
      // 标签里只有名字（值与实验标签都在它外面）
      expect(row.querySelector('[data-tab-label]')?.textContent, tab.id).toBe(tab.label)
    }

    const exp = tabRow('exp')
    expect(exp.querySelector('[data-experimental]')?.getAttribute('data-experimental')).toBe(
      'voice'
    )
    expect(valueOf('exp')).toBe('2')
  })

  it('SC-14 a value of 0 is drawn: the container does not filter zero', () => {
    render({ tabs: [plainTab('zero', { value: 0 })], stacked: { showList: true, onBack: vi.fn() } })
    expect(tabRow('zero').querySelector('[data-settings-tab-value]')?.textContent).toBe('0')
  })

  it('SC-24 without stacked, group and value change nothing and the history is left alone', () => {
    const tabs = [
      plainTab('a1', { group: 'a', value: 3 }),
      plainTab('solo', { value: 'On' }),
      plainTab('a2', { group: 'a' })
    ]
    const push = vi.spyOn(window.history, 'pushState')
    const go = vi.spyOn(window.history, 'go')
    const onTabChange = vi.fn()
    render({ tabs, activeTab: 'a1', onTabChange })
    expect(qa('[data-settings-nav-card]')).toEqual([])
    expect(qa('[data-settings-tab-value]')).toEqual([])
    expect(qa('[data-settings-nav] [data-tab-label]').map((el) => el.textContent)).toEqual([
      'Label a1',
      'Label solo',
      'Label a2'
    ])
    expect(contents()).toEqual(['a1'])

    render({ tabs, activeTab: 'solo', onTabChange })
    expect(contents()).toEqual(['solo'])
    expect(push).not.toHaveBeenCalled()
    expect(go).not.toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(contents()).toEqual(['solo'])
    expect(onTabChange).not.toHaveBeenCalled()
    expect(historyState()).toBeNull()
  })
})

describe('SettingsContainer stacked: the depth reported to the host', () => {
  it('SC-15 list 0 / section 1 / item 2, reported on every change and only on a change', async () => {
    const onDepthChange = vi.fn()
    const onBack = vi.fn()
    const depths = (): number[] => onDepthChange.mock.calls.map(([depth]) => depth as number)
    const withItem = [itemTab({ title: 'Item X', onBack: vi.fn() })]
    const withoutItem = [itemTab(null)]

    render({ tabs: withoutItem, stacked: { showList: true, onBack, onDepthChange } })
    expect(depths()).toEqual([0])

    render({ tabs: withoutItem, stacked: { showList: false, onBack, onDepthChange } })
    expect(depths()).toEqual([0, 1])

    // 层数没变、函数没换：不再报
    render({ tabs: withoutItem, stacked: { showList: false, onBack, onDepthChange } })
    expect(depths()).toEqual([0, 1])

    render({ tabs: withItem, stacked: { showList: false, onBack, onDepthChange } })
    expect(depths()).toEqual([0, 1, 2])

    // 变浅时容器退掉自己压的那一条：等它落地再走下一步
    await awaitPop(() =>
      render({ tabs: withoutItem, stacked: { showList: false, onBack, onDepthChange } })
    )
    expect(depths()).toEqual([0, 1, 2, 1])

    await awaitPop(() =>
      render({ tabs: withoutItem, stacked: { showList: true, onBack, onDepthChange } })
    )
    expect(depths()).toEqual([0, 1, 2, 1, 0])
    expect(onBack).not.toHaveBeenCalled()
  })

  it('SC-15 mounted on a section whose child declares an item at once: 1 then 2', () => {
    const onDepthChange = vi.fn()
    render({
      tabs: [itemTab({ title: 'Item X', onBack: vi.fn() })],
      stacked: { showList: false, onBack: vi.fn(), onDepthChange }
    })
    expect(onDepthChange.mock.calls.map(([depth]) => depth)).toEqual([1, 2])
  })

  it('SC-16 a new onDepthChange function gets the current depth once', () => {
    const first = vi.fn()
    const second = vi.fn()
    const onBack = vi.fn()
    render({ stacked: { showList: false, onBack, onDepthChange: first } })
    expect(first.mock.calls).toEqual([[1]])
    render({ stacked: { showList: false, onBack, onDepthChange: second } })
    expect(second.mock.calls).toEqual([[1]])
    expect(first).toHaveBeenCalledTimes(1)
    render({ stacked: { showList: false, onBack, onDepthChange: second } })
    expect(second).toHaveBeenCalledTimes(1)
  })
})

interface HostSpies {
  onTabChange: (id: string) => void
  onBack: () => void
  onItemBack: () => void
}

/** 分区的内容：自己有一项可以打开（打开后经 useStackedSubPage 报上去） */
function ItemHost({ onItemBack }: { onItemBack: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const page = useMemo<StackedSubPage | null>(
    () =>
      open
        ? {
            title: 'Item X',
            onBack: () => {
              onItemBack()
              setOpen(false)
            }
          }
        : null,
    [open, onItemBack]
  )
  useStackedSubPage(page)
  return createElement(
    'button',
    { type: 'button', 'data-open-item': '', onClick: () => setOpen(true) },
    open ? 'item open' : 'item closed'
  )
}

/** 像宿主那样持有「在不在列表上」：点一行进分区，onBack 回列表 */
function Host({
  initialList,
  spies
}: {
  initialList: boolean
  spies: HostSpies
}): React.JSX.Element {
  const [showList, setShowList] = useState(initialList)
  const [activeTab, setActiveTab] = useState('general')
  const tabs = useMemo<SettingsTab[]>(
    () => [
      {
        id: 'general',
        label: 'General',
        content: createElement(ItemHost, { onItemBack: spies.onItemBack })
      },
      { id: 'about', label: 'About', content: content('about') }
    ],
    [spies]
  )
  return createElement(SettingsContainer, {
    tabs,
    activeTab,
    title: 'Settings',
    onTabChange: (id: string) => {
      spies.onTabChange(id)
      setActiveTab(id)
      setShowList(false)
    },
    stacked: {
      showList,
      onBack: () => {
        spies.onBack()
        setShowList(true)
      }
    }
  })
}

describe('SettingsContainer stacked: the levels on the browser history', () => {
  let spies: { [K in keyof HostSpies]: ReturnType<typeof vi.fn> & HostSpies[K] }

  function mountHost(initialList = true): void {
    spies = {
      onTabChange: vi.fn() as never,
      onBack: vi.fn() as never,
      onItemBack: vi.fn() as never
    }
    act(() => root.render(createElement(Host, { initialList, spies })))
  }
  const openSection = (id: string): void => act(() => tabRow(id).click())
  const openItem = (): void => act(() => q('[data-open-item]')!.click())
  const onList = (): boolean =>
    q('[data-settings-back]') === null && q('[data-settings-nav]') !== null

  it('SC-17 list → section pushes one entry marked 1 that keeps a mark placed before', () => {
    window.history.replaceState({ shuvixMobileScope: true }, '')
    mountHost()
    const push = vi.spyOn(window.history, 'pushState')
    openSection('about')
    expect(push).toHaveBeenCalledTimes(1)
    expect(historyState()).toEqual({ shuvixMobileScope: true, [MARK]: 1 })
    expect(level()).toBe('section')
    expect(heading()).toBe('About')
  })

  it('SC-18 section → item pushes a second entry marked 2', () => {
    mountHost()
    openSection('general')
    const push = vi.spyOn(window.history, 'pushState')
    openItem()
    expect(push).toHaveBeenCalledTimes(1)
    expect(historyState()).toEqual({ [MARK]: 2 })
    expect(level()).toBe('item')
  })

  it('SC-25 with the history in place the item page’s header is unchanged: back named by the section, heading = the item', () => {
    mountHost()
    openSection('general')
    openItem()
    expect(level()).toBe('item')
    expect(backText()).toBe('General')
    expect(backAria()).toBe('General')
    expect(heading()).toBe('Item X')
  })

  it('SC-19 the back gesture goes one level at a time: item → section → list', async () => {
    mountHost()
    openSection('general')
    openItem()

    await back()
    expect(spies.onItemBack).toHaveBeenCalledTimes(1)
    expect(spies.onBack).not.toHaveBeenCalled()
    expect(level()).toBe('section')
    expect(heading()).toBe('General')
    expect(q('[data-open-item]')?.textContent).toBe('item closed')
    expect(historyState()).toEqual({ [MARK]: 1 })

    await back()
    expect(spies.onBack).toHaveBeenCalledTimes(1)
    expect(spies.onItemBack).toHaveBeenCalledTimes(1)
    expect(onList()).toBe(true)
    expect(historyState()).toBeNull()
  })

  it('SC-20 history.go(-2) from an item lands on the list in one step; both onBacks ran once', async () => {
    mountHost()
    openSection('general')
    openItem()
    const go = vi.spyOn(window.history, 'go')
    await awaitPop(() => window.history.go(-2))
    expect(onList()).toBe(true)
    expect(spies.onItemBack).toHaveBeenCalledTimes(1)
    expect(spies.onBack).toHaveBeenCalledTimes(1)
    expect(historyState()).toBeNull()
    // 界面已经对上历史：容器自己不再退
    expect(go).toHaveBeenCalledTimes(1)
  })

  it('SC-21 the back button on a pushed section: the list, go(-1) once, nothing more after the pop', async () => {
    mountHost()
    openSection('about')
    const go = vi.spyOn(window.history, 'go')
    await awaitPop(clickBack)
    expect(onList()).toBe(true)
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-1)
    expect(spies.onBack).toHaveBeenCalledTimes(1)
    expect(historyState()).toBeNull()
  })

  it('SC-22 the back button on an item: the item closes, go(-1), still in the section on the entry marked 1', async () => {
    mountHost()
    openSection('general')
    openItem()
    const go = vi.spyOn(window.history, 'go')
    await awaitPop(clickBack)
    expect(spies.onItemBack).toHaveBeenCalledTimes(1)
    expect(spies.onBack).not.toHaveBeenCalled()
    expect(go).toHaveBeenCalledTimes(1)
    expect(go).toHaveBeenCalledWith(-1)
    expect(level()).toBe('section')
    expect(heading()).toBe('General')
    expect(historyState()).toEqual({ [MARK]: 1 })
  })

  it('SC-23 mounted on a section (the baseline): nothing pushed; the back button shows the list without touching the history', () => {
    const push = vi.spyOn(window.history, 'pushState')
    const go = vi.spyOn(window.history, 'go')
    const historyBack = vi.spyOn(window.history, 'back')
    mountHost(false)
    expect(level()).toBe('section')
    expect(push).not.toHaveBeenCalled()

    clickBack()
    expect(onList()).toBe(true)
    expect(spies.onBack).toHaveBeenCalledTimes(1)
    expect(go).not.toHaveBeenCalled()
    expect(historyBack).not.toHaveBeenCalled()
    expect(historyState()).toBeNull()
  })
})

/**
 * `onOpen`（2026-11-17）：叠放布局的分区列表里点这一行不进分区，而是宿主自己做一件事（手机上的「浏览器」整屏推入
 * 它自己的一摞页面）。桌面的左侧导航不看它。
 */
describe('SettingsContainer stacked: a tab with onOpen', () => {
  it('SC-O1 a click on a row with onOpen calls it and not onTabChange', () => {
    const onOpen = vi.fn()
    const onTabChange = vi.fn()
    const tabs = [plainTab('a'), plainTab('pushed', { content: null, onOpen })]
    render({ tabs, activeTab: 'a', onTabChange, stacked: { showList: true, onBack: vi.fn() } })
    act(() => tabRow('pushed').click())
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onTabChange).not.toHaveBeenCalled()
  })

  it('SC-O2 a row without onOpen in the same list still calls onTabChange(id)', () => {
    const onOpen = vi.fn()
    const onTabChange = vi.fn()
    const tabs = [plainTab('a'), plainTab('pushed', { content: null, onOpen })]
    render({ tabs, activeTab: 'a', onTabChange, stacked: { showList: true, onBack: vi.fn() } })
    act(() => tabRow('a').click())
    expect(onTabChange.mock.calls).toEqual([['a']])
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('SC-O3 a tab with onOpen and no content draws its row: label, icon and the optional value', () => {
    const tabs = [
      plainTab('pushed', {
        content: null,
        onOpen: vi.fn(),
        icon: createElement('i', { 'data-icon': 'pushed' }),
        value: '2 tabs'
      }),
      plainTab('bare', { content: null, onOpen: vi.fn() })
    ]
    render({ tabs, activeTab: 'pushed', stacked: { showList: true, onBack: vi.fn() } })
    const row = tabRow('pushed')
    expect(row.querySelector('[data-tab-label]')?.textContent).toBe('Label pushed')
    expect(row.querySelector('[data-icon="pushed"]')).not.toBeNull()
    expect(row.querySelector('[data-settings-tab-value]')?.textContent).toBe('2 tabs')
    expect(tabRow('bare').querySelector('[data-settings-tab-value]')).toBeNull()
    expect(tabRow('bare').querySelector('[data-tab-label]')?.textContent).toBe('Label bare')
  })

  it('SC-O4 the desktop nav ignores onOpen: a click calls onTabChange', () => {
    const onOpen = vi.fn()
    const onTabChange = vi.fn()
    const tabs = [plainTab('a'), plainTab('pushed', { onOpen })]
    render({ tabs, activeTab: 'a', onTabChange })
    const button = qa('[data-settings-nav] button').find((el) =>
      (el.textContent ?? '').includes('Label pushed')
    )!
    act(() => button.click())
    expect(onTabChange.mock.calls).toEqual([['pushed']])
    expect(onOpen).not.toHaveBeenCalled()
  })
})
