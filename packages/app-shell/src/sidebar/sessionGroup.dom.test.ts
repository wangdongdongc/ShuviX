// @vitest-environment jsdom
/**
 * SessionGroup 的导航行（`nav`，手机布局的顶层列表）：组头不再就地展开，点它是「进这一组」。
 *
 *   SG-1/2  `data-group-nav` = 这一组的 key，行尾是会话数（0 / 没给不画）与一个箭头
 *   SG-3    点组头调 `nav.onOpen`，不调 `onToggle`
 *   SG-4    正文不画（折叠与否都一样）
 *   SG-5/6  没有「+」、没有 ⋮；右键组头照旧开菜单
 *   SG-7    `temp` 形态给了 nav 也画成一行（对话气泡图标），不再是摊开的分节
 *   SG-8    `bot` 形态：自带的头像、名字、会话数、箭头
 *   SG-9    项目的导航行永远画合上的文件夹
 *   SG-10/11 不给 nav：与原来一样（项目可折叠、有「+」；temp 是摊开的分节）
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { SessionGroup, type SessionGroupProps } from './SessionGroup'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function render(props: Partial<SessionGroupProps>): void {
  act(() =>
    root.render(
      createElement(
        SessionGroup,
        { label: 'Proj', variant: 'project', ...props } as SessionGroupProps,
        createElement('div', { 'data-child': '' })
      )
    )
  )
}

const header = (): HTMLElement => container.querySelector<HTMLElement>('[data-group]')!
const headerButton = (): HTMLButtonElement | null =>
  header().querySelector<HTMLButtonElement>(':scope > button:not([data-group-add])')
const count = (): HTMLElement | null => container.querySelector<HTMLElement>('[data-group-count]')
const chevron = (): Element | null => container.querySelector('svg.lucide-chevron-right')
const child = (): Element | null => container.querySelector('[data-child]')
const menuButton = (): Element | null =>
  container.querySelector(`button[aria-label="${en.sidebar.moreActions}"]`)
const contextMenu = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
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

describe('SessionGroup nav rows', () => {
  it('SG-1 a project nav row carries its key, the count and a chevron', () => {
    render({ nav: { key: 'p1', count: 3, onOpen: () => {} } })
    expect(container.querySelector('[data-group="project"][data-group-nav="p1"]')).toBe(header())
    expect(count()!.textContent).toBe('3')
    expect(chevron()).not.toBeNull()
    expect(header().contains(chevron())).toBe(true)
    expect(header().textContent).toContain('Proj')
  })

  it.each<[string, number | undefined]>([
    ['0', 0],
    ['omitted', undefined]
  ])('SG-2 count %s: no count, the chevron stays', (_label, value) => {
    render({ nav: { key: 'p1', count: value, onOpen: () => {} } })
    expect(count()).toBeNull()
    expect(chevron()).not.toBeNull()
  })

  it('SG-3 clicking the header opens the group and does not toggle it', () => {
    const onOpen = vi.fn()
    const onToggle = vi.fn()
    render({ nav: { key: 'p1', count: 3, onOpen }, onToggle })
    act(() => headerButton()!.click())
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it.each<[string, boolean]>([
    ['collapsed', true],
    ['expanded', false]
  ])('SG-4 %s: the children are not mounted', (_label, collapsed) => {
    render({ nav: { key: 'p1', onOpen: () => {} }, collapsed })
    expect(child()).toBeNull()
  })

  it('SG-5 a nav row has no add button', () => {
    render({ nav: { key: 'p1', onOpen: () => {} }, onAdd: vi.fn(), addLabel: 'New chat' })
    expect(container.querySelector('[data-group-add]')).toBeNull()
    expect(container.querySelector('[data-has-add]')).toBeNull()
  })

  it('SG-6 a nav row has no ⋮ button, but a context menu on the header still opens the menu', () => {
    const onMenu = vi.fn()
    render({ nav: { key: 'p1', onOpen: () => {} }, onMenu })
    expect(menuButton()).toBeNull()
    contextMenu(header())
    expect(onMenu).toHaveBeenCalledTimes(1)
  })

  it('SG-7 a temp nav row is a row with a chat-bubble icon, not a flat section', () => {
    const onOpen = vi.fn()
    render({ variant: 'temp', label: 'Chats', nav: { key: '__no_project__', count: 2, onOpen } })
    const row = container.querySelector<HTMLElement>('[data-group="temp"][data-group-nav]')
    expect(row).not.toBeNull()
    expect(row!.getAttribute('data-group-nav')).toBe('__no_project__')
    expect(row!.querySelector('button')).not.toBeNull()
    expect(row!.querySelector('svg.lucide-message-square')).not.toBeNull()
    expect(row!.classList.contains('sb-section')).toBe(false)
    expect(count()!.textContent).toBe('2')
    act(() => headerButton()!.click())
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(child()).toBeNull()
  })

  it('SG-8 a bot nav row keeps its own icon, the label, the count and the chevron', () => {
    render({
      variant: 'bot',
      label: 'Scout',
      icon: createElement('span', { 'data-avatar': '' }),
      nav: { key: 'bot:scout', count: 4, onOpen: () => {} }
    })
    expect(container.querySelector('[data-group="bot"][data-group-nav="bot:scout"]')).not.toBeNull()
    expect(header().querySelector('[data-avatar]')).not.toBeNull()
    expect(header().textContent).toContain('Scout')
    expect(count()!.textContent).toBe('4')
    expect(chevron()).not.toBeNull()
  })

  it('SG-9 a project nav row draws the closed folder even when not collapsed', () => {
    render({ nav: { key: 'p1', onOpen: () => {} }, collapsed: false })
    expect(header().querySelector('svg.lucide-folder-closed')).not.toBeNull()
    expect(header().querySelector('svg.lucide-folder-open')).toBeNull()
  })
})

describe('SessionGroup without nav (desktop)', () => {
  it('SG-10 a project group: no nav anchors, children mounted, add button, click toggles', () => {
    const onToggle = vi.fn()
    const onAdd = vi.fn()
    render({ collapsed: false, onToggle, onAdd, addLabel: 'New chat', onMenu: vi.fn() })
    expect(container.querySelector('[data-group-nav]')).toBeNull()
    expect(chevron()).toBeNull()
    expect(count()).toBeNull()
    expect(child()).not.toBeNull()
    expect(container.querySelector('[data-group-add]')).not.toBeNull()
    expect(menuButton()).not.toBeNull()
    expect(header().querySelector('svg.lucide-folder-open')).not.toBeNull()
    act(() => headerButton()!.click())
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('SG-11 a temp group: a flat section with no button wrapper, children mounted', () => {
    render({ variant: 'temp', label: 'Chats' })
    const section = container.querySelector<HTMLElement>('[data-group="temp"]')!
    expect(section.classList.contains('sb-section')).toBe(true)
    expect(section.hasAttribute('data-group-nav')).toBe(false)
    expect(section.querySelector('button')).toBeNull()
    expect(section.querySelector('svg')).toBeNull()
    expect(child()).not.toBeNull()
  })
})
