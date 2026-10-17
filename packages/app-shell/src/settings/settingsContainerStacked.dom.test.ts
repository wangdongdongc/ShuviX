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
