// @vitest-environment jsdom
/**
 * 会话面板的「产物」页（`ArtifactsPanel`，jsdom）。清单本身（缓存、刷新时机）在 sessionArtifacts.dom.test，
 * 这里把 `useSessionArtifacts` 换成直接交回给定的行，只看页面怎么画、怎么点。
 *
 *   AP-1 行的第二行：`名字 · v3 · 时刻`（今天只写时刻，更早的写日期）
 *   AP-2 锚点 `data-artifact-row=<文件名>`；updatedAt 为 0 时末尾不留一个孤零零的 ` · `
 *   AP-3 分组：本会话「Artifacts N」在前，再是「Sub-session · 标题 N」；父子同名各是一行；子会话那行的预览
 *        按**子会话**的 sessionId 去读
 *   AP-4 只有子会话的产物：只有子会话那一组，没有空的本会话组
 *   AP-5 点一行就地展开、再点收起，展开互斥；预览按 {sessionId, name} 读；预览里不重复标题
 *   AP-6 键盘：行上 Enter / Space 切换；⋮ 上按 Enter 不切换；右键不切换
 *   AP-7 菜单（宿主有 revealPath）：[在文件夹中显示, 复制路径]，分别调 revealPath(path) / copyToClipboard(path)；
 *        ⋮ 打开的是同一份菜单
 *   AP-8 宿主没有 revealPath：菜单里只有「复制路径」
 *   AP-9 展开期间有了新的一版：预览重挂（再读一次），行仍展开
 *   AP-10 揭示请求（chatStore.revealArtifact）：挂着时来 → 独占展开 `<会话>/<名字>` 那一行（子会话组的也行，
 *         父子同名时只展开子会话那件）；挂载前就发出、还没人处理的 → 挂载即展开；处理过的 → 重挂不再展开
 *
 * 右键菜单经 ContextMenuProvider 的 `render` 注入，按预设回一个 id（模拟用户点了它）—— 脚手架照
 * projectSessionGroupsReport.dom.test。宿主面（`getHostApi()`）落在 `setChatApi` 注入的桩上；
 * `copyToClipboard` 换成 spy（别去碰跑测试那台机器的剪贴板）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'
import type { SessionArtifact } from '@shuvix/chat-protocol/artifacts'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'

const state = vi.hoisted(() => ({
  rows: undefined as SessionArtifact[] | undefined,
  asked: [] as Array<string | null>
}))

vi.mock('./sessionArtifacts', () => ({
  useSessionArtifacts: (sessionId: string | null) => {
    state.asked.push(sessionId)
    return state.rows
  }
}))
vi.mock('@shuvix/chat-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shuvix/chat-ui')>()),
  copyToClipboard: vi.fn()
}))

import {
  ChatHostProvider,
  copyToClipboard,
  setChatApi,
  useChatStore,
  type ChatHostValue
} from '@shuvix/chat-ui'
import { ArtifactsPanel } from './ArtifactsPanel'
import { ContextMenuProvider } from '../contextmenu/ContextMenuProvider'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const HOST: ChatHostValue = {
  appearance: { theme: 'light', darkTheme: 'd', lightTheme: 'l', fontSize: 14, focusMode: false },
  models: {
    activeProvider: '',
    activeModel: '',
    setActiveProvider: () => {},
    setActiveModel: () => {}
  },
  interactiveFigures: true
}
const HostProvider = ChatHostProvider as (props: {
  value: ChatHostValue
  children?: ReactNode
}) => React.JSX.Element

// ── 时间：只假 Date（今天 = 2026-10-24 15:30 本地时间）────────────────────────

const NOW = new Date(2026, 9, 24, 15, 30)
const TODAY_10_05 = new Date(2026, 9, 24, 10, 5).getTime()
const OLDER = new Date(2026, 9, 20, 9, 0).getTime()
const timeLabel = (ts: number): string =>
  new Date(ts).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
const dateLabel = (ts: number): string =>
  new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric' })

// ── 宿主桩 ────────────────────────────────────────────────────────────────

const SVG = (label: string): string =>
  `<svg viewBox="0 0 4 4" aria-label="${label}" xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>`

const read = vi.fn(async (p: { sessionId: string; name: string }) => ({
  name: p.name,
  title: `Title of ${p.name}`,
  content: p.name.endsWith('.svg') ? SVG(`Title of ${p.name}`) : `# Title of ${p.name}\nbody`
}))
const revealPath = vi.fn(async (_path: string) => {})

function install(opts: { reveal: boolean }): void {
  setChatApi({
    artifact: { read, list: async () => [] },
    app: opts.reveal ? { revealPath } : {}
  } as unknown as ChatApi)
}

const art = (
  name: string,
  extra: Partial<SessionArtifact> = {},
  sessionId = 'parent'
): SessionArtifact => ({
  sessionId,
  name,
  title: `Title of ${name}`,
  path: `/home/u/.shuvix/artifacts/${sessionId}/${name}`,
  versions: 1,
  updatedAt: TODAY_10_05,
  ...extra
})

// ── 渲染与查询 ────────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root
let menus: ContextMenuItem[][]
let pick: string | null

function render(): void {
  type ProviderProps = ComponentProps<typeof ContextMenuProvider>
  const provider: Omit<ProviderProps, 'children'> = {
    render: async (items: ContextMenuItem[]) => {
      menus.push(items)
      return items.some((it) => it.id === pick) ? pick : null
    }
  }
  act(() => {
    root.render(
      createElement(
        HostProvider,
        { value: HOST },
        createElement(
          ContextMenuProvider,
          provider as ProviderProps,
          createElement(ArtifactsPanel, { sessionId: 'parent' })
        )
      )
    )
  })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

const panel = (): HTMLElement => container.querySelector<HTMLElement>('[data-artifacts-panel]')!
const groups = (): Array<{ label: string; count: number; rows: string[] }> =>
  [...panel().children].map((g) => ({
    label: g.querySelector('span.truncate')?.textContent ?? '',
    count: Number(g.querySelector('.tabular-nums')?.textContent),
    rows: [...g.querySelectorAll('[data-artifact-row]')].map(
      (r) => r.getAttribute('data-artifact-row') ?? ''
    )
  }))
/** 第 n 组（缺省第一组）里叫 name 的那一行 */
const rowEl = (name: string, group = 0): HTMLElement => {
  const g = panel().children[group]
  const found = g?.querySelector<HTMLElement>(`[data-artifact-row=${JSON.stringify(name)}]`)
  if (!found) throw new Error(`row ${name} not in group ${group}`)
  return found
}
const toggleOf = (row: HTMLElement): HTMLElement => row.firstElementChild as HTMLElement
const menuButtonOf = (row: HTMLElement): HTMLButtonElement =>
  toggleOf(row).querySelector<HTMLButtonElement>('button')!
const titleLine = (row: HTMLElement): string =>
  toggleOf(row).querySelector('.min-w-0')!.children[0].textContent ?? ''
const metaLine = (row: HTMLElement): string =>
  toggleOf(row).querySelector('.min-w-0')!.children[1].textContent ?? ''
const isExpanded = (row: HTMLElement): boolean =>
  row.getAttribute('data-artifact-expanded') === 'true'
const previewOf = (row: HTMLElement): HTMLElement | null =>
  (row.children[1] as HTMLElement | undefined) ?? null
const expandedNames = (): string[] =>
  [...panel().querySelectorAll<HTMLElement>('[data-artifact-row]')]
    .filter(isExpanded)
    .map((r) => r.getAttribute('data-artifact-row') ?? '')

function click(el: Element): void {
  act(() => {
    ;(el as HTMLElement).click()
  })
}
function key(el: Element, k: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}
function rightClick(el: Element): void {
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
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  state.rows = undefined
  state.asked = []
  menus = []
  pick = null
  read.mockClear()
  revealPath.mockClear()
  vi.mocked(copyToClipboard).mockClear()
  install({ reveal: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('ArtifactsPanel', () => {
  it('AP-1 第二行：名字 · v3 · 时刻（今天）/ 日期（更早）；标题在第一行', () => {
    state.rows = [
      art('chart.svg', { versions: 3, updatedAt: TODAY_10_05 }),
      art('notes.md', { versions: 1, updatedAt: OLDER })
    ]
    render()
    expect(state.asked.every((sid) => sid === 'parent')).toBe(true)
    expect(titleLine(rowEl('chart.svg'))).toBe('Title of chart.svg')
    expect(metaLine(rowEl('chart.svg'))).toBe(`chart.svg · v3 · ${timeLabel(TODAY_10_05)}`)
    expect(metaLine(rowEl('notes.md'))).toBe(`notes.md · v1 · ${dateLabel(OLDER)}`)
    // 两种写法确实不同（不是碰巧都落成同一种）
    expect(timeLabel(TODAY_10_05)).not.toBe(dateLabel(TODAY_10_05))
  })

  it('AP-2 锚点 data-artifact-row；updatedAt 为 0 → 末尾没有 " · "', () => {
    state.rows = [art('never-timed.csv', { versions: 2, updatedAt: 0 })]
    render()
    const row = rowEl('never-timed.csv')
    expect(row.getAttribute('data-artifact-row')).toBe('never-timed.csv')
    expect(row.getAttribute('data-artifact-expanded')).toBe('false')
    expect(metaLine(row)).toBe('never-timed.csv · v2')
  })

  it('AP-3 分组：本会话在前，再是子会话（带标题）；父子同名各一行；子会话那行按子会话 id 读预览', async () => {
    state.rows = [
      art('shared.svg'),
      art('own.md'),
      art('shared.svg', { subSessionTitle: 'Coding' }, 'child'),
      art('kid.json', { subSessionTitle: 'Coding' }, 'child')
    ]
    render()
    expect(groups()).toEqual([
      { label: 'Artifacts', count: 2, rows: ['shared.svg', 'own.md'] },
      { label: 'Sub-session · Coding', count: 2, rows: ['shared.svg', 'kid.json'] }
    ])

    click(toggleOf(rowEl('shared.svg', 1)))
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenLastCalledWith({ sessionId: 'child', name: 'shared.svg' })
    // 展开的是子会话那一行，不是父会话的同名那件
    expect(isExpanded(rowEl('shared.svg', 1))).toBe(true)
    expect(isExpanded(rowEl('shared.svg', 0))).toBe(false)

    click(toggleOf(rowEl('shared.svg', 0)))
    await flush()
    expect(read).toHaveBeenLastCalledWith({ sessionId: 'parent', name: 'shared.svg' })
    expect(isExpanded(rowEl('shared.svg', 0))).toBe(true)
    expect(isExpanded(rowEl('shared.svg', 1))).toBe(false)
  })

  it('AP-4 只有子会话的产物：只有那一组', () => {
    state.rows = [art('kid.svg', { subSessionTitle: 'Review' }, 'child')]
    render()
    expect(groups()).toEqual([{ label: 'Sub-session · Review', count: 1, rows: ['kid.svg'] }])
  })

  it('AP-5 点开 / 再点收起，展开互斥；预览按 {sessionId, name} 读；预览里不重复标题', async () => {
    state.rows = [art('alpha.svg'), art('beta.md')]
    render()
    expect(expandedNames()).toEqual([])
    expect(previewOf(rowEl('alpha.svg'))).toBeNull()

    click(toggleOf(rowEl('alpha.svg')))
    await flush()
    expect(expandedNames()).toEqual(['alpha.svg'])
    expect(read).toHaveBeenCalledWith({ sessionId: 'parent', name: 'alpha.svg' })
    const svgPreview = previewOf(rowEl('alpha.svg'))!
    expect(svgPreview.querySelector('svg')).not.toBeNull()
    expect(svgPreview.textContent).not.toContain('Title of alpha.svg')

    click(toggleOf(rowEl('beta.md')))
    await flush()
    expect(expandedNames()).toEqual(['beta.md'])
    expect(previewOf(rowEl('alpha.svg'))).toBeNull()
    const mdPreview = previewOf(rowEl('beta.md'))!
    expect(mdPreview.querySelector('pre')?.textContent).toBe('# Title of beta.md\nbody')
    // 源码里那行标题是内容；预览头上不再另写一遍
    expect(mdPreview.textContent?.split('Title of beta.md')).toHaveLength(2)

    click(toggleOf(rowEl('beta.md')))
    expect(expandedNames()).toEqual([])
  })

  it('AP-6 键盘：Enter / Space 切换；⋮ 上按 Enter、右键都不切换', async () => {
    state.rows = [art('alpha.svg')]
    render()
    const row = rowEl('alpha.svg')

    key(toggleOf(row), 'Enter')
    expect(isExpanded(rowEl('alpha.svg'))).toBe(true)
    key(toggleOf(rowEl('alpha.svg')), ' ')
    expect(isExpanded(rowEl('alpha.svg'))).toBe(false)
    key(toggleOf(rowEl('alpha.svg')), 'a')
    expect(isExpanded(rowEl('alpha.svg'))).toBe(false)

    key(menuButtonOf(rowEl('alpha.svg')), 'Enter')
    expect(isExpanded(rowEl('alpha.svg'))).toBe(false)

    rightClick(toggleOf(rowEl('alpha.svg')))
    await flush()
    expect(menus).toHaveLength(1)
    expect(isExpanded(rowEl('alpha.svg'))).toBe(false)

    // 点 ⋮ 打开菜单，也不切换
    click(menuButtonOf(rowEl('alpha.svg')))
    await flush()
    expect(menus).toHaveLength(2)
    expect(isExpanded(rowEl('alpha.svg'))).toBe(false)
  })

  it('AP-7 菜单（宿主有 revealPath）：在文件夹中显示 / 复制路径，各调各的；⋮ 是同一份菜单', async () => {
    const a = art('alpha.svg')
    state.rows = [a]
    render()

    pick = 'reveal'
    rightClick(toggleOf(rowEl('alpha.svg')))
    await flush()
    expect(menus[0].map((m) => [m.id, m.label])).toEqual([
      ['reveal', en.panel.artifactsReveal],
      ['copy-path', en.panel.artifactsCopyPath]
    ])
    expect(revealPath).toHaveBeenCalledTimes(1)
    expect(revealPath).toHaveBeenCalledWith(a.path)
    expect(copyToClipboard).not.toHaveBeenCalled()

    pick = 'copy-path'
    click(menuButtonOf(rowEl('alpha.svg')))
    await flush()
    expect(menus[1].map((m) => m.id)).toEqual(['reveal', 'copy-path'])
    expect(copyToClipboard).toHaveBeenCalledTimes(1)
    expect(copyToClipboard).toHaveBeenCalledWith(a.path)
    expect(revealPath).toHaveBeenCalledTimes(1)
  })

  it('AP-8 宿主没有 revealPath：菜单里只有复制路径', async () => {
    install({ reveal: false })
    const a = art('alpha.svg')
    state.rows = [a]
    render()
    pick = 'copy-path'
    rightClick(toggleOf(rowEl('alpha.svg')))
    await flush()
    expect(menus[0].map((m) => m.id)).toEqual(['copy-path'])
    expect(copyToClipboard).toHaveBeenCalledWith(a.path)
  })

  it('AP-9 展开期间有了新的一版：预览重挂（再读一次），行仍展开', async () => {
    state.rows = [art('alpha.svg', { versions: 3, updatedAt: TODAY_10_05 })]
    render()
    click(toggleOf(rowEl('alpha.svg')))
    await flush()
    expect(read).toHaveBeenCalledTimes(1)

    // 同一份清单再渲染一次（别的东西变了）：不重读
    render()
    await flush()
    expect(read).toHaveBeenCalledTimes(1)

    state.rows = [art('alpha.svg', { versions: 4, updatedAt: TODAY_10_05 + 60_000 })]
    render()
    await flush()
    expect(read).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenLastCalledWith({ sessionId: 'parent', name: 'alpha.svg' })
    expect(isExpanded(rowEl('alpha.svg'))).toBe(true)
    expect(previewOf(rowEl('alpha.svg'))?.querySelector('svg')).not.toBeNull()
    expect(metaLine(rowEl('alpha.svg'))).toBe(`alpha.svg · v4 · ${timeLabel(TODAY_10_05 + 60_000)}`)
  })

  it('AP-10 揭示请求：挂着时独占展开那一行（父子同名只展开子会话那件）；挂载前发出的挂载即展开；处理过的不再展开', async () => {
    state.rows = [
      art('shared.svg'),
      art('own.md'),
      art('shared.svg', { subSessionTitle: 'Coding' }, 'child')
    ]
    render()
    click(toggleOf(rowEl('own.md')))
    expect(expandedNames()).toEqual(['own.md'])

    // 挂着时来：子会话组里那件 shared.svg
    act(() => useChatStore.getState().revealArtifact('child', 'shared.svg'))
    await flush()
    expect(isExpanded(rowEl('shared.svg', 1))).toBe(true)
    expect(isExpanded(rowEl('shared.svg', 0))).toBe(false)
    expect(isExpanded(rowEl('own.md'))).toBe(false)
    expect(read).toHaveBeenLastCalledWith({ sessionId: 'child', name: 'shared.svg' })

    // 卸下（面板收起）之后才发出的请求：再挂上时补处理
    act(() => root.unmount())
    root = createRoot(container)
    act(() => useChatStore.getState().revealArtifact('parent', 'own.md'))
    render()
    await flush()
    expect(expandedNames()).toEqual(['own.md'])

    // 那条已经处理过：再收起、再打开，不再展开
    act(() => root.unmount())
    root = createRoot(container)
    render()
    await flush()
    expect(expandedNames()).toEqual([])

    // 没有这一行的名字：什么都不展开
    act(() => useChatStore.getState().revealArtifact('parent', 'gone.svg'))
    await flush()
    expect(expandedNames()).toEqual([])
  })
})
