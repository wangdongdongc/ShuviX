// @vitest-environment jsdom
/**
 * 手机布局的产物页与产物详情页（mobile/MobileArtifactsPage.tsx，jsdom）。
 *
 * 契约：
 * - 列表页：这场会话的产物一张卡片，直接子会话的各一张（卡片上面写「子会话 · 标题」），顺序是清单给的。一行两排：
 *   标题，下面「文件名 · 第几版 · 最近一版的时刻」（没有时刻就没有那一段）。点一行 → `onOpenArtifact`；长按是复制
 *   路径。清单还没到：不画行也不说「没有」；到了是空的才说；
 * - 详情页（key = `<会话 id>/<文件名>`）：大标题是产物的标题，下面那行同上，内容是对话里引用的那个渲染器（给的是
 *   产出它的那场会话的 id）；有了新版就重取。清单到了却没有这一件 → `onBack()` 一次；清单还没到不算。
 *
 *   MA-1..6   列表页
 *   MA-7..10  详情页
 *
 * `@shuvix/chat-ui` / `@shuvix/app-shell` 换成替身：`useSessionArtifacts` 交回用例定的清单（按会话），`ArtifactPreview`
 * 记 props 与挂载次数，`listTimeLabel` 交回固定的字；MobilePage、panelPure 是真的。真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { SessionArtifact } from '@shuvix/chat-protocol/artifacts'

type Props = Record<string, unknown>
interface MenuItem {
  id?: string
  label?: string
}

const rec = vi.hoisted(() => ({
  /** 会话 id → 清单（undefined = 还没取到） */
  rows: {} as Record<string, unknown[] | undefined>,
  asked: [] as Array<string | null>,
  previews: [] as Array<Record<string, unknown>>,
  previewMounts: 0,
  menus: [] as Array<{ items: MenuItem[]; pick: (id: string) => void }>,
  copied: [] as string[]
}))

vi.mock('@shuvix/chat-ui', async () => {
  const { createElement: h, useState } = await import('react')
  return {
    copyToClipboard: (text: string) => {
      rec.copied.push(text)
    },
    isTaskFinished: () => false,
    ArtifactPreview: (props: Props) => {
      useState(() => ++rec.previewMounts)
      rec.previews.push(props)
      return h('div', { 'data-stub-preview': String(props.name) })
    }
  }
})

vi.mock('@shuvix/app-shell', () => ({
  basename: (p: string) => p.split('/').pop() ?? '',
  listTimeLabel: (ms: number) => `T${ms}`,
  useSessionArtifacts: (sessionId: string | null) => {
    rec.asked.push(sessionId)
    return sessionId ? rec.rows[sessionId] : undefined
  },
  useContextMenu:
    () =>
    (_e: unknown, items: MenuItem[], pick: (id: string) => void): Promise<void> => {
      rec.menus.push({ items, pick })
      return Promise.resolve()
    }
}))

import {
  MobileArtifactDetailPage,
  MobileArtifactsPage,
  type MobileArtifactDetailPageProps,
  type MobileArtifactsPageProps
} from '../MobileArtifactsPage'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const M = en.mobile

const onBack = vi.fn<() => void>()
const onOpenArtifact = vi.fn<(artifact: SessionArtifact) => void>()

let container: HTMLDivElement
let root: Root
let mounted = false

const art = (over: Partial<SessionArtifact> = {}): SessionArtifact => ({
  sessionId: 's1',
  name: 'a.svg',
  title: 'Figure A',
  path: '/art/s1/a.svg',
  versions: 2,
  updatedAt: 5000,
  ...over
})
const OWN = art()
const OWN2 = art({ name: 'b.html', title: 'Page B', path: '/art/s1/b.html', versions: 1 })
const SUB = art({
  sessionId: 'sub1',
  subSessionTitle: 'Child run',
  title: 'Sub figure',
  path: '/art/sub1/a.svg',
  versions: 3,
  updatedAt: 7000
})

function renderList(over: Partial<MobileArtifactsPageProps> = {}): void {
  act(() =>
    root.render(
      createElement(MobileArtifactsPage, { sessionId: 's1', onBack, onOpenArtifact, ...over })
    )
  )
  mounted = true
}
function renderDetail(over: Partial<MobileArtifactDetailPageProps> = {}): void {
  act(() =>
    root.render(
      createElement(MobileArtifactDetailPage, {
        sessionId: 's1',
        artifactKey: 's1/a.svg',
        onBack,
        ...over
      })
    )
  )
  mounted = true
}
function unmount(): void {
  if (!mounted) return
  act(() => root.unmount())
  mounted = false
}

const q = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel)
const qa = (sel: string): HTMLElement[] => Array.from(container.querySelectorAll<HTMLElement>(sel))
const text = (sel: string): string | null => q(sel)?.textContent ?? null
function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
const row = (key: string): HTMLElement =>
  q(`[data-mobile-artifact-row][data-artifact-key="${key}"]`)!
const count = (): string | null => text('[data-mobile-artifacts-count]')

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  window.history.replaceState(null, '')
  rec.rows = {}
  rec.asked.length = 0
  rec.previews.length = 0
  rec.previewMounts = 0
  rec.menus.length = 0
  rec.copied.length = 0
  onBack.mockReset()
  onOpenArtifact.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = false
})

afterEach(() => {
  unmount()
  container.remove()
  vi.restoreAllMocks()
})

describe('MobileArtifactsPage: the list', () => {
  it('MA-1 not loaded yet: no rows, no "none" text, an empty toolbar', () => {
    renderList()
    expect(q('[data-mobile-panel="artifacts"]')).not.toBeNull()
    expect(rec.asked.at(-1)).toBe('s1')
    expect(qa('[data-mobile-artifact-row]')).toEqual([])
    expect(q('[data-mobile-artifacts-empty]')).toBeNull()
    expect(count()).toBe('')
    expect(text('[data-mobile-panel-title]')).toBe(M.artifacts)
    expect(text('[data-mobile-panel-back]')).toBe(M.detailsBack)
    click(q('[data-mobile-panel-back]')!)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('MA-2 loaded and empty: says so', () => {
    rec.rows.s1 = []
    renderList()
    expect(text('[data-mobile-artifacts-empty]')).toBe(M.noArtifacts)
    expect(qa('[data-mobile-artifact-group]')).toEqual([])
    expect(count()).toBe('')
  })

  it("MA-3 own artifacts first without a label, then each sub-session's under its title", () => {
    rec.rows.s1 = [OWN, OWN2, SUB]
    renderList()
    const groups = qa('[data-mobile-artifact-group]')
    expect(groups.map((el) => el.getAttribute('data-mobile-artifact-group'))).toEqual([
      's1',
      'sub1'
    ])
    expect(groups[0].firstElementChild!.querySelector('[data-mobile-artifact-row]')).not.toBeNull()
    expect(groups[1].firstElementChild!.textContent).toBe(
      i18n.t('panel.artifactsSubSession', { title: 'Child run' })
    )
    expect(groups[0].textContent).not.toContain('Sub-session')
    expect(
      qa('[data-mobile-artifact-row]').map((el) => [
        el.getAttribute('data-mobile-artifact-row'),
        el.getAttribute('data-artifact-key')
      ])
    ).toEqual([
      ['a.svg', 's1/a.svg'],
      ['b.html', 's1/b.html'],
      ['a.svg', 'sub1/a.svg']
    ])
    expect(row('s1/a.svg').textContent).toContain('Figure A')
    expect(row('sub1/a.svg').textContent).toContain('Sub figure')
    expect(q('[data-mobile-artifacts-empty]')).toBeNull()
    expect(count()).toBe('3 artifacts')
  })

  it('MA-3 one artifact: the singular count', () => {
    rec.rows.s1 = [OWN]
    renderList()
    expect(count()).toBe('1 artifact')
  })

  it('MA-4 the second line: name · version · time; no time, no trailing separator', () => {
    rec.rows.s1 = [OWN, art({ name: 'old.csv', title: 'Old', versions: 1, updatedAt: 0 })]
    renderList()
    expect(row('s1/a.svg').querySelector('[data-artifact-meta]')!.textContent).toBe(
      'a.svg · v2 · T5000'
    )
    expect(row('s1/old.csv').querySelector('[data-artifact-meta]')!.textContent).toBe(
      'old.csv · v1'
    )
  })

  it("MA-5 a tap opens that row's artifact", () => {
    rec.rows.s1 = [OWN, SUB]
    renderList()
    click(row('sub1/a.svg'))
    expect(onOpenArtifact).toHaveBeenCalledTimes(1)
    expect(onOpenArtifact.mock.calls[0][0]).toBe(SUB)
  })

  it('MA-6 the row menu is one item: copy path', () => {
    rec.rows.s1 = [OWN, SUB]
    renderList()
    act(() => {
      row('sub1/a.svg').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      )
    })
    const menu = rec.menus.at(-1)!
    expect(menu.items).toEqual([{ id: 'copy-path', label: en.panel.artifactsCopyPath }])
    act(() => menu.pick('copy-path'))
    expect(rec.copied).toEqual(['/art/sub1/a.svg'])
    expect(onOpenArtifact).not.toHaveBeenCalled()
  })
})

describe('MobileArtifactDetailPage', () => {
  it('MA-7 the detail of an own artifact', () => {
    rec.rows.s1 = [OWN, SUB]
    renderDetail()
    expect(q('[data-mobile-panel="artifact"]')).not.toBeNull()
    expect(text('[data-mobile-panel-title]')).toBe('Figure A')
    expect(text('[data-mobile-panel-subtitle]')).toBe('a.svg · v2 · T5000')
    expect(text('[data-mobile-panel-back]')).toBe(M.artifacts)
    const body = q('[data-mobile-artifact-detail]')!
    expect(body.getAttribute('data-mobile-artifact-detail')).toBe('a.svg')
    expect(body.querySelector('[data-stub-preview="a.svg"]')).not.toBeNull()
    expect(rec.previews.at(-1)).toEqual({
      sessionId: 's1',
      name: 'a.svg',
      hideTitle: true,
      framed: false
    })
    click(q('[data-mobile-panel-back]')!)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it("MA-7 a sub-session's artifact is previewed with the sub-session's id", () => {
    rec.rows.s1 = [OWN, SUB]
    renderDetail({ artifactKey: 'sub1/a.svg' })
    expect(rec.asked.at(-1)).toBe('s1')
    expect(text('[data-mobile-panel-title]')).toBe('Sub figure')
    expect(text('[data-mobile-panel-subtitle]')).toBe('a.svg · v3 · T7000')
    expect(rec.previews.at(-1)).toEqual({
      sessionId: 'sub1',
      name: 'a.svg',
      hideTitle: true,
      framed: false
    })
  })

  it.each<[string, Partial<SessionArtifact>]>([
    ['a new version', { versions: 3 }],
    ['a new time', { updatedAt: 9000 }]
  ])('MA-8 %s remounts the preview', (_label, over) => {
    rec.rows.s1 = [OWN, OWN2]
    renderDetail()
    expect(rec.previewMounts).toBe(1)
    rec.rows.s1 = [{ ...OWN, ...over }, OWN2]
    renderDetail()
    expect(rec.previewMounts).toBe(2)
  })

  it('MA-8 a change to another row does not remount it', () => {
    rec.rows.s1 = [OWN, OWN2]
    renderDetail()
    rec.rows.s1 = [{ ...OWN }, { ...OWN2, versions: 9, updatedAt: 9999 }, SUB]
    renderDetail()
    expect(rec.previewMounts).toBe(1)
    expect(onBack).not.toHaveBeenCalled()
  })

  it('MA-9 the list is there without this artifact: back once, nothing drawn', () => {
    rec.rows.s1 = [OWN2]
    renderDetail()
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(container.innerHTML).toBe('')
    renderDetail()
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('MA-9 the same name in another session is not this artifact', () => {
    rec.rows.s1 = [SUB]
    renderDetail()
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(q('[data-mobile-panel="artifact"]')).toBeNull()
  })

  it('MA-9 the artifact going away while the page is open: back once', () => {
    rec.rows.s1 = [OWN]
    renderDetail()
    expect(onBack).not.toHaveBeenCalled()
    rec.rows.s1 = []
    renderDetail()
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(container.innerHTML).toBe('')
  })

  it('MA-10 the list not loaded yet: nothing drawn, and no going back; then it loads with it', () => {
    renderDetail()
    expect(container.innerHTML).toBe('')
    expect(onBack).not.toHaveBeenCalled()
    rec.rows.s1 = [OWN]
    renderDetail()
    expect(q('[data-mobile-panel="artifact"]')).not.toBeNull()
    expect(onBack).not.toHaveBeenCalled()
  })

  it('MA-10 the list not loaded yet, then it loads without it: back once', () => {
    renderDetail()
    expect(onBack).not.toHaveBeenCalled()
    rec.rows.s1 = [OWN2]
    renderDetail()
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(container.innerHTML).toBe('')
  })
})
