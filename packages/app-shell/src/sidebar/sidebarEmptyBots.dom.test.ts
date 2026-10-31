// @vitest-environment jsdom
/**
 * 共享侧栏的空态（一个会话、一个项目都没有）与「Bots」分节（Sidebar.tsx → ProjectSessionGroups `botsOnly`，jsdom）。
 *
 * 契约：空态时项目分组整个不画，换成「打开一个文件夹」的提示（点它 → onOpenFolder）。注入了 `bots` 时「Bots」分节
 * 照样画在提示上面 —— bot 文件可能已经有了，那里是开第一条对话的地方；没有 `bots` 就只有提示。
 *
 *   SE-1 空态 + bots：`[data-sidebar-section="bots"]`（带它的 bot 组）在提示之上、groupsPrepend 之下；没有「项目」分节、
 *        没有「临时对话」组；提示点了 → onOpenFolder；注册表是空的 → 分节里是「还没有 bot」那一行
 *   SE-2 空态、不给 bots：只有提示，没有任何分组
 *   SE-3 对照组：有一个项目时不是空态 —— 没有提示，Bots 分节与「项目」分节都在
 *
 * ProjectSessionGroups 是真的（分节确实画出来）；`@shuvix/chat-ui` 换成侧栏与分组会碰的那几样（同
 * projectSessionGroupsBots 那份测试）。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

const store = vi.hoisted(() => ({
  sessions: [] as unknown[],
  activeSessionId: null as string | null
}))

vi.mock('@shuvix/chat-ui', async () => {
  const { createElement: h } = await import('react')
  const state = (): Record<string, unknown> => ({
    ...store,
    setSessions: () => {},
    setActiveSessionId: () => {}
  })
  return {
    RedactedText: ({ text }: { text: string }) => text,
    RedactionSessionProvider: ({ children }: { children: unknown }) => children,
    BotAvatar: ({ name }: { name: string }) => h('span', { 'data-avatar': name }),
    getChatApi: () => ({
      app: {
        platform: 'web',
        onNewChat: () => () => undefined,
        onNewProject: () => () => undefined
      },
      session: { create: async () => ({ id: 'x' }), list: async () => [] },
      message: { list: async () => [] }
    }),
    useChatStore: Object.assign(
      (selector: (s: Record<string, unknown>) => unknown) => selector(state()),
      { getState: state }
    ),
    selectStreamingSessions: () => ({}),
    selectInterruptedSessions: () => ({}),
    selectAllPendingCounts: () => ({}),
    useChatHost: () => ({ appearance: { focusMode: false } }),
    useAppEvent: () => {}
  }
})

import { Sidebar, type SidebarProps } from './Sidebar'
import type { BotsSectionCaps } from './ProjectSessionGroups'
import type { BotRegistry } from './useBotRegistry'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function botsCaps(registry: BotRegistry): BotsSectionCaps {
  return {
    adapter: {
      list: vi.fn(async () => registry),
      open: vi.fn(),
      create: vi.fn(),
      openFolder: vi.fn(),
      newSession: vi.fn(),
      archive: vi.fn(),
      deleteFile: vi.fn()
    }
  }
}

async function render(props: Partial<SidebarProps>): Promise<void> {
  act(() =>
    root.render(
      createElement(Sidebar, {
        projects: [],
        onOpenFolder: () => {},
        onOpenSettings: () => {},
        groupsPrepend: createElement('div', { 'data-prepend': '' }),
        ...props
      })
    )
  )
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

const q = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel)
/** 空态提示（那颗写着 emptyHint 的按钮） */
const hint = (): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === en.sidebar.emptyHint
  )
/** a 在 DOM 里排在 b 前面 */
const before = (a: Element, b: Element): boolean =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
const sectionLabels = (): string[] =>
  [...container.querySelectorAll('[data-group="section"]')].map((el) => el.textContent ?? '')

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  store.sessions = []
  store.activeSessionId = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('shared Sidebar empty state and the Bots section', () => {
  it('SE-1 empty + bots: the Bots section renders above the hint (below groupsPrepend); no Projects section, no temp group', async () => {
    const onOpenFolder = vi.fn()
    const bots = botsCaps({
      bots: [{ name: 'scout', displayName: 'Scout', description: '', fileName: 'scout.md' }],
      shadowed: [],
      invalid: []
    })
    await render({ bots, onOpenFolder })

    const section = q('[data-sidebar-section="bots"]')
    expect(section).not.toBeNull()
    expect(section!.querySelector('[data-bot-group="scout"]')).not.toBeNull()
    expect(section!.querySelector('[data-bot-new-chat]')).not.toBeNull()
    expect(bots.adapter.list).toHaveBeenCalledTimes(1)

    const h = hint()
    expect(h).toBeDefined()
    expect(before(section!, h!)).toBe(true)
    expect(before(q('[data-prepend]')!, section!)).toBe(true)

    expect(sectionLabels().some((l) => l.startsWith(en.sidebar.projects))).toBe(false)
    expect(sectionLabels().some((l) => l.startsWith(en.sidebar.botsGroup))).toBe(true)
    expect(q('[data-group="temp"]')).toBeNull()
    expect(q('[data-group="project"]')).toBeNull()

    act(() => h!.click())
    expect(onOpenFolder).toHaveBeenCalledTimes(1)
  })

  it('SE-1 empty + bots with an empty registry: the section still renders, with its "no bots yet" row', async () => {
    await render({ bots: botsCaps({ bots: [], shadowed: [], invalid: [] }) })
    const section = q('[data-sidebar-section="bots"]')
    expect(section).not.toBeNull()
    expect(section!.querySelector('[data-bots-empty]')?.textContent).toBe(en.sidebar.botsEmpty)
    expect(before(section!, hint()!)).toBe(true)
  })

  it('SE-2 empty without bots: only the hint, no groups at all', async () => {
    await render({})
    expect(hint()).toBeDefined()
    expect(q('[data-sidebar-section="bots"]')).toBeNull()
    expect(q('[data-group]')).toBeNull()
  })

  it('SE-3 control: one project → not empty; no hint, both the Bots and the Projects sections', async () => {
    await render({
      projects: [{ id: 'p1', name: 'Proj' }],
      bots: botsCaps({ bots: [], shadowed: [], invalid: [] })
    })
    expect(hint()).toBeUndefined()
    expect(q('[data-sidebar-section="bots"]')).not.toBeNull()
    expect(sectionLabels().some((l) => l.startsWith(en.sidebar.projects))).toBe(true)
    expect(q('[data-group="project"]')).not.toBeNull()
  })
})
