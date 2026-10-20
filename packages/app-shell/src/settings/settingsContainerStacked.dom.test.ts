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
 *   SC-2 分区视图：返回键（标题文字 + aria-label）→ onBack；头部是当前分区名；只有当前分区的内容；
 *        不认识的 activeTab → tabs[0]
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
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
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

  it('SC-2 the section view: a back button named by the title, the active label in the header, only the active content', () => {
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
    // 头部 = 返回键 + 当前分区名
    const header = back!.parentElement!
    expect((header.textContent ?? '').replace('Settings', '').trim()).toBe('Voice')
    expect(contents()).toEqual(['voice'])
    expect(qa('[data-settings-tab]')).toEqual([])

    act(() => back!.click())
    expect(onBack).toHaveBeenCalledTimes(1)

    // 不认识的 activeTab → tabs[0]
    render({ activeTab: 'nope', stacked: { showList: false, onBack } })
    expect(contents()).toEqual(['general'])
    const header2 = q('[data-settings-back]')!.parentElement!
    expect((header2.textContent ?? '').replace('Settings', '').trim()).toBe('General')
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
