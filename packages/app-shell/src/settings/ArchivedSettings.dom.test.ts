// @vitest-environment jsdom
/**
 * ArchivedSettings —— 已归档设置页的子分类标签条：「项目」由它自己画，宿主经 `extraTabs` 交进别的归档对象
 * （桌面：已归档的小组件），内容整块由宿主画。
 *
 *   AS-1 没有 extraTabs → 只有一个「Projects」标签；有归档项目就列出来，没有就是 settings.projectsNoArchived
 *   AS-2 extraTabs [{key:'widgets',…}] → 标签依次 Projects、Widgets；点 Widgets 显示宿主内容、项目列表不见；
 *        点回 Projects 回到项目列表
 *
 * `../sidebar/useProjects` 与 `@shuvix/chat-ui`（getChatApi / useChatHost / useChatStore —— PanelTabBar 的专注淡化要它们）
 * 是替身；ResizeObserver 打桩（jsdom 没有）。文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { Boxes } from 'lucide-react'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

const mocks = vi.hoisted(() => ({
  archivedProjects: [] as Array<{ id: string; name: string }>,
  update: vi.fn()
}))

vi.mock('../sidebar/useProjects', () => ({
  useProjects: () => ({ projects: [], archivedProjects: mocks.archivedProjects, reload: vi.fn() })
}))
vi.mock('@shuvix/chat-ui', () => ({
  getChatApi: () => ({ project: { update: mocks.update } }),
  useChatHost: () => ({ appearance: { focusMode: false } }),
  useChatStore: (selector: (s: { activeSessionId: string | null }) => unknown) =>
    selector({ activeSessionId: null })
}))

import { ArchivedSettings, type ArchivedSettingsProps } from './ArchivedSettings'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function render(props: ArchivedSettingsProps = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(ArchivedSettings, props))
  })
}

/** 标签条上的按钮（PanelTabBar 另有一份隐藏的测宽副本，不在按钮里） */
const tabLabels = (): string[] =>
  [...container.querySelectorAll('button')]
    .map((b) => b.textContent?.trim() ?? '')
    .filter((text) => text.length > 0)

const tabButton = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label
  )
  if (!found) throw new Error(`no tab ${label}`)
  return found
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
  globalThis.ResizeObserver ??= class {
    observe(): void {
      /* 不测布局 */
    }
    unobserve(): void {
      /* 不测布局 */
    }
    disconnect(): void {
      /* 不测布局 */
    }
  } as unknown as typeof ResizeObserver
})

beforeEach(() => {
  mocks.archivedProjects = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('只有项目（AS-1）', () => {
  it('AS-1 没有 extraTabs → 只有 Projects 一个标签；没有归档项目 → 空提示', async () => {
    await render()
    expect(tabLabels()).toEqual([en.settings.archivedSubTabProjects])
    expect(container.textContent).toContain(en.settings.projectsNoArchived)
  })

  it('AS-1 有归档项目 → 列出来', async () => {
    mocks.archivedProjects = [
      { id: 'p1', name: 'Old Project' },
      { id: 'p2', name: 'Older Project' }
    ]
    await render()
    expect(container.textContent).toContain('Old Project')
    expect(container.textContent).toContain('Older Project')
    expect(container.textContent).not.toContain(en.settings.projectsNoArchived)
  })
})

describe('宿主给的子分类（AS-2）', () => {
  const widgetsTab = {
    key: 'widgets',
    label: 'Widgets',
    Icon: Boxes,
    content: createElement('div', { 'data-testid': 'archived-widgets' }, 'widget rows here')
  }

  it('AS-2 标签依次 Projects、Widgets；点 Widgets 显示宿主内容，点回 Projects 回到项目列表', async () => {
    mocks.archivedProjects = [{ id: 'p1', name: 'Old Project' }]
    await render({ extraTabs: [widgetsTab] })

    expect(tabLabels()).toEqual([en.settings.archivedSubTabProjects, 'Widgets'])
    expect(container.textContent).toContain('Old Project')
    expect(container.querySelector('[data-testid="archived-widgets"]')).toBeNull()

    await click(tabButton('Widgets'))
    expect(container.querySelector('[data-testid="archived-widgets"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Old Project')

    await click(tabButton(en.settings.archivedSubTabProjects))
    expect(container.querySelector('[data-testid="archived-widgets"]')).toBeNull()
    expect(container.textContent).toContain('Old Project')
  })

  it('AS-2 点 Widgets 时没有归档项目的空提示也不在', async () => {
    await render({ extraTabs: [widgetsTab] })
    expect(container.textContent).toContain(en.settings.projectsNoArchived)
    await click(tabButton('Widgets'))
    expect(container.textContent).not.toContain(en.settings.projectsNoArchived)
    expect(container.textContent).toContain('widget rows here')
  })
})
