// @vitest-environment jsdom
/**
 * 知识库条目行的信任徽标（2026-10-12，jsdom）—— KnowledgeTreeView 的 renderBadges。
 *
 * 契约：信任档来自条目视图（`trustTier` 按为当前内容背书的那几条章判、`verifiedCurrent` 按时序判）。
 *   - 核实仍当前：人工审阅 → 绿色 BadgeCheck（`knowledge.badgeVerified`），机器确认（`submit` 过了写手那道门）
 *     → 天蓝 CircleCheck（`knowledge.badgeMachineConfirmed`）；
 *   - 核实不再当前（核实后又被修改）：不论旧章是谁盖的，都只出一枚灰色 BadgeCheck
 *     （`knowledge.badgeVerifiedOutdated`）—— 改写后的内容谁也没背书，不能因为旧章是人工的就亮绿；
 *   - unverified：没有任何信任徽标。
 * 徽标是 `span[aria-label]`（= title），顺序固定：draft / deprecated → 信任 → stale。
 *
 *   KB-1 机器确认且当前；KB-2 人工审阅且当前；KB-3 不再当前（两种档）；KB-4 unverified；
 *   KB-5 与别的徽标共存的顺序；KB-6 三个文案键三语齐全且互不相同
 *
 * 挂的是 ProjectKnowledgeFolder（点开文件夹看本项目的行）；`@shuvix/chat-ui` 替掉 useAppEvent /
 * useChatStore / useChatHost，同 ProjectKnowledgeFolder.dom.test。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentProps, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import type { KnowledgeEntry } from '@shuvix/chat-protocol/knowledge'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'

vi.mock('@shuvix/chat-ui', () => ({
  useAppEvent: () => {},
  useChatStore: (selector: (s: { sessions: never[]; activeSessionId: null }) => unknown) =>
    selector({ sessions: [], activeSessionId: null }),
  useChatHost: () => ({ appearance: { focusMode: false } })
}))

import { ProjectKnowledgeFolder } from './ProjectKnowledgeFolder'
import type { KnowledgeGroupAdapter, KnowledgeListing } from './KnowledgeTreeView'
import { ContextMenuProvider } from '../contextmenu/ContextMenuProvider'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const entry = (name: string, overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry => ({
  path: `projects/p1/${name}.md`,
  bundle: 'projects/p1',
  type: 'Memory',
  title: name,
  description: '',
  status: 'stable',
  tags: [],
  trustTier: 'unverified',
  verifiedCurrent: false,
  stale: false,
  ...overrides
})

const ENTRIES: KnowledgeEntry[] = [
  entry('machine', { trustTier: 'machine-confirmed', verifiedCurrent: true }),
  entry('human', { trustTier: 'human-reviewed', verifiedCurrent: true }),
  entry('human-old', { trustTier: 'human-reviewed', verifiedCurrent: false }),
  entry('machine-old', { trustTier: 'machine-confirmed', verifiedCurrent: false }),
  // 不一致的数据（宿主不会这样给，但渲染不该据此亮出任何信任徽标）
  entry('odd', { trustTier: 'unverified', verifiedCurrent: true }),
  entry('plain'),
  entry('draft-stale', {
    status: 'draft',
    trustTier: 'machine-confirmed',
    verifiedCurrent: true,
    stale: true
  }),
  entry('deprecated-old', {
    status: 'deprecated',
    trustTier: 'human-reviewed',
    verifiedCurrent: false,
    stale: true
  })
]

const LISTING: KnowledgeListing = {
  entries: ENTRIES,
  root: '/kb-shuvix',
  userRoot: '/kb-user',
  dirs: ['projects', 'projects/p1'],
  bundleNames: { 'projects/p1': 'Proj One' }
}

const K = en.knowledge

let container: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(child: ReactElement): Promise<void> {
  await act(async () => {
    type ProviderProps = ComponentProps<typeof ContextMenuProvider>
    const props: Omit<ProviderProps, 'children'> = {
      render: async (_items: ContextMenuItem[]) => null
    }
    root.render(createElement(ContextMenuProvider, props as ProviderProps, child))
  })
  await flush()
}

/** 渲染项目库文件夹并点开；返回文件夹正文 */
async function openFolder(): Promise<HTMLElement> {
  const adapter: KnowledgeGroupAdapter = {
    list: vi.fn(async () => LISTING),
    open: vi.fn(),
    openFolder: vi.fn(),
    createEntry: vi.fn(async () => ({ success: true }))
  }
  await render(createElement(ProjectKnowledgeFolder, { projectId: 'p1', adapter, enabled: true }))
  const folder = container.querySelector('[data-project-knowledge="p1"]') as HTMLElement
  await act(async () => {
    folder.click()
  })
  await flush()
  return folder.nextElementSibling as HTMLElement
}

/** 一行的徽标（`span[aria-label]`，⋮ 按钮是 button 不算），按 DOM 顺序 */
const badgesOf = (scope: ParentNode, name: string): HTMLElement[] => {
  const row = scope.querySelector(`[data-knowledge-row="projects/p1/${name}.md"]`)
  if (!row) throw new Error(`row ${name} not rendered`)
  return [...row.querySelectorAll('span[aria-label]')] as HTMLElement[]
}
const labelsOf = (scope: ParentNode, name: string): string[] =>
  badgesOf(scope, name).map((el) => el.getAttribute('aria-label') ?? '')
/** 徽标里那枚图标的 class（lucide 的 `lucide-<name>` + 颜色类） */
const iconClassOf = (badge: HTMLElement): string =>
  badge.querySelector('svg')?.getAttribute('class') ?? ''

/** 三个信任文案 */
const TRUST_LABELS = [K.badgeMachineConfirmed, K.badgeVerified, K.badgeVerifiedOutdated]
const trustLabelsOf = (scope: ParentNode, name: string): string[] =>
  labelsOf(scope, name).filter((label) => TRUST_LABELS.includes(label))

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

describe('知识库条目行的信任徽标', () => {
  it('KB-1 机器确认且仍当前 → 恰一枚天蓝 CircleCheck（badgeMachineConfirmed），没有人工 / 过期那两枚', async () => {
    const body = await openFolder()
    expect(trustLabelsOf(body, 'machine')).toEqual([K.badgeMachineConfirmed])
    const [badge] = badgesOf(body, 'machine')
    expect(badge.getAttribute('title')).toBe(K.badgeMachineConfirmed)
    expect(iconClassOf(badge)).toContain('lucide-circle-check')
    expect(iconClassOf(badge)).toContain('text-sky-500/70')
  })

  it('KB-2 人工审阅且仍当前 → 恰一枚绿色 BadgeCheck（badgeVerified）', async () => {
    const body = await openFolder()
    expect(trustLabelsOf(body, 'human')).toEqual([K.badgeVerified])
    const [badge] = badgesOf(body, 'human')
    expect(iconClassOf(badge)).toContain('lucide-badge-check')
    expect(iconClassOf(badge)).toContain('text-emerald-500/80')
  })

  it('KB-3 核实不再当前：旧章是人工的还是机器的都只出一枚灰色 BadgeCheck（badgeVerifiedOutdated），不亮绿也不亮蓝', async () => {
    const body = await openFolder()
    for (const name of ['human-old', 'machine-old']) {
      expect(trustLabelsOf(body, name), name).toEqual([K.badgeVerifiedOutdated])
      const [badge] = badgesOf(body, name)
      expect(iconClassOf(badge), name).toContain('lucide-badge-check')
      expect(iconClassOf(badge), name).toContain('text-text-tertiary/40')
      expect(iconClassOf(badge), name).not.toContain('emerald')
      expect(iconClassOf(badge), name).not.toContain('sky')
    }
  })

  it('KB-4 unverified（哪怕 verifiedCurrent 说 true）→ 没有任何信任徽标', async () => {
    const body = await openFolder()
    expect(badgesOf(body, 'odd')).toEqual([])
    expect(badgesOf(body, 'plain')).toEqual([])
  })

  it('KB-5 与别的徽标共存时顺序固定：draft / deprecated → 信任 → stale', async () => {
    const body = await openFolder()
    expect(labelsOf(body, 'draft-stale')).toEqual([
      K.badgeDraft,
      K.badgeMachineConfirmed,
      K.badgeStale
    ])
    expect(labelsOf(body, 'deprecated-old')).toEqual([
      K.badgeDeprecated,
      K.badgeVerifiedOutdated,
      K.badgeStale
    ])
  })

  it('KB-6 三个信任文案在 en / zh / ja 都有、且同一语言里两两不同', () => {
    for (const [lang, locale] of [
      ['en', en],
      ['zh', zh],
      ['ja', ja]
    ] as const) {
      const k = locale.knowledge as Record<string, string>
      const labels = [k.badgeMachineConfirmed, k.badgeVerified, k.badgeVerifiedOutdated]
      for (const label of labels) {
        expect(typeof label, lang).toBe('string')
        expect(label.trim(), lang).not.toBe('')
      }
      expect(new Set(labels).size, lang).toBe(3)
    }
  })
})
