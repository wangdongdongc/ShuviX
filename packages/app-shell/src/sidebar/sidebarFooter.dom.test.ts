// @vitest-environment jsdom
/**
 * 共享侧栏的 `hideFooter`（web 客户端的手机布局：设置是底部标签栏里单独的一页；jsdom）。
 *
 * 契约：缺省画底部设置栏（`[data-sidebar-settings]` + 宿主的 footerActions）；`hideFooter` → 整条都不画，
 * 宿主的浮层与分组前置插槽照旧在。
 *
 *   SB-1 缺省：[data-sidebar-settings] 与 footerActions 都在
 *   SB-2 hideFooter：两样都没有；overlays 与 groupsPrepend 照旧
 *
 * `@shuvix/chat-ui` 只给侧栏会碰的几样（getChatApi 的平台与菜单栏订阅、按 selector 读的 store、外观）；
 * 会话分组与 Bot 单选换成空替身（项目与会话都为空时画的是空态提示，不碰它们）。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

vi.mock('@shuvix/chat-ui', () => ({
  getChatApi: () => ({
    app: {
      platform: 'web',
      onNewChat: () => () => undefined,
      onNewProject: () => () => undefined
    },
    session: { create: vi.fn(), list: vi.fn() }
  }),
  useChatStore: Object.assign(
    (selector: (s: { sessions: never[]; activeSessionId: null }) => unknown) =>
      selector({ sessions: [], activeSessionId: null }),
    { getState: () => ({ setSessions: vi.fn(), setActiveSessionId: vi.fn() }) }
  ),
  useChatHost: () => ({ appearance: { focusMode: false } })
}))
vi.mock('./ProjectSessionGroups', () => ({
  ProjectSessionGroups: () => null,
  TEMP_GROUP_KEY: '__temp__'
}))
vi.mock('./BotSessionDialog', () => ({ BotSessionDialog: () => null }))

import { Sidebar, type SidebarProps } from './Sidebar'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function render(props: Partial<SidebarProps>): void {
  act(() =>
    root.render(
      createElement(Sidebar, {
        projects: [],
        onOpenFolder: () => {},
        onOpenSettings: () => {},
        footerActions: createElement('button', { 'data-footer-action': '' }),
        groupsPrepend: createElement('div', { 'data-prepend': '' }),
        overlays: createElement('div', { 'data-overlay': '' }),
        ...props
      })
    )
  )
}

const q = (sel: string): Element | null => container.querySelector(sel)

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

describe('shared Sidebar footer', () => {
  it('SB-1 by default the settings row and the host footer actions are there', () => {
    const onOpenSettings = vi.fn()
    render({ onOpenSettings })
    const settings = q('[data-sidebar-settings]') as HTMLButtonElement | null
    expect(settings).not.toBeNull()
    expect(settings!.textContent).toContain(en.sidebar.settings)
    expect(q('[data-footer-action]')).not.toBeNull()
    act(() => settings!.click())
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(q('[data-prepend]')).not.toBeNull()
    expect(q('[data-overlay]')).not.toBeNull()
  })

  it('SB-2 hideFooter drops both; overlays and groupsPrepend stay', () => {
    render({ hideFooter: true })
    expect(q('[data-sidebar-settings]')).toBeNull()
    expect(q('[data-footer-action]')).toBeNull()
    expect(container.textContent).not.toContain(en.sidebar.settings)
    expect(q('[data-prepend]')).not.toBeNull()
    expect(q('[data-overlay]')).not.toBeNull()
  })
})
