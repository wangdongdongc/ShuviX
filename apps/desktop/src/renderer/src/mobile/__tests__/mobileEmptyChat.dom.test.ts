// @vitest-environment jsdom
/**
 * 手机布局的空对话页（mobile/MobileEmptyChat.tsx，jsdom）。
 *
 * 契约：一句提示（bot 会话是它的自我介绍），下面一张入口卡片；每行写着现在的状态，点它直接推入详情里对应的那一页
 * （`onOpenSection(section)`）。扩展能力：有 MCP 可勾才有，值 = 勾着几台，一台没勾是「关着」那句话；知识库：有库
 * 可选才有，值 = 选着的、还在的库数，一个没有是「没选」那句话；访问权限（路径）：恒在，值 = 权限表里路径那几行的数，
 * 没取到时空着。会话访问 / 小组件访问没有入口。渠道端（没有 HostApi）不摆卡片。
 *
 *   ME-1..4   提示、bot 介绍、没有宿主、store 里没有这条会话
 *   ME-5..7   扩展能力那一行
 *   ME-8..12  知识库那一行
 *   ME-13..15 路径那一行
 *   ME-16..20 行的顺序、标签、点一行、行的形状、没有的行
 *   ME-21..23 换了会话 id、值跟着钩子变、会话后来成了 bot 会话
 *
 * `@shuvix/chat-ui`（`useChatStore` 是真 zustand store）、`@shuvix/app-shell`、`../useMcpSummary`、
 * `WelcomeView` 的 `BotEmptyState` 都是替身；`boundBotOf` 是真的。真 en 文案。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

interface StoreApi {
  getState: () => { sessions: Array<Record<string, unknown>> }
  setState: (patch: { sessions: Array<Record<string, unknown>> }) => void
}
interface Knowledge {
  options: Array<{ name: string }>
  selected: string[]
}

const rec = vi.hoisted(() => ({
  store: null as unknown as StoreApi,
  host: {} as object | null,
  mcp: { total: 0, selected: 0 },
  knowledge: { options: [], selected: [] } as Knowledge,
  acl: null as { paths: number; sessions: number; widgets: number } | null,
  mcpIds: [] as string[],
  knowledgeIds: [] as string[],
  aclIds: [] as string[],
  bots: [] as Array<Record<string, unknown>>,
  cardMounts: 0
}))

vi.mock('@shuvix/chat-ui', async () => {
  const { create } = await import('zustand')
  const useChatStore = create<{ sessions: Array<Record<string, unknown>> }>(() => ({
    sessions: []
  }))
  rec.store = useChatStore as unknown as StoreApi
  return {
    useChatStore,
    getHostApi: () => rec.host,
    useSessionKnowledgeBases: (sessionId: string) => {
      rec.knowledgeIds.push(sessionId)
      return rec.knowledge
    }
  }
})
vi.mock('@shuvix/app-shell', () => ({
  useSessionAclCounts: (sessionId: string) => {
    rec.aclIds.push(sessionId)
    return rec.acl
  }
}))
vi.mock('../useMcpSummary', async () => {
  const { useState } = await import('react')
  return {
    useMcpSummary: (sessionId: string) => {
      // 卡片那个组件每挂一次数一次（这个钩子只在卡片里用）
      useState(() => ++rec.cardMounts)
      rec.mcpIds.push(sessionId)
      return rec.mcp
    }
  }
})
vi.mock('../../components/chat/WelcomeView', async () => {
  const { createElement: h } = await import('react')
  return {
    BotEmptyState: (props: Record<string, unknown>) => {
      rec.bots.push(props)
      return h('div', { 'data-stub-bot-intro': String(props.bot) })
    }
  }
})

import { MobileEmptyChat } from '../MobileEmptyChat'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const M = en.mobile
const onOpenSection = vi.fn<(section: string) => void>()

let container: HTMLDivElement
let root: Root

const session = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 's1',
  title: 'Chat',
  projectId: null,
  parentId: null,
  settings: {},
  ...over
})
function render(sessionId = 's1'): void {
  act(() =>
    root.render(
      createElement(MobileEmptyChat, {
        sessionId,
        onOpenSection: onOpenSection as never
      })
    )
  )
}

const q = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel)
const rowOf = (section: string): HTMLElement | null => q(`[data-mobile-empty-row="${section}"]`)
const rows = (): Array<string | null> =>
  Array.from(container.querySelectorAll('[data-mobile-empty-row]')).map((el) =>
    el.getAttribute('data-mobile-empty-row')
  )
const valueOf = (section: string): string | null =>
  rowOf(section)?.querySelector('[data-mobile-empty-value]')?.textContent ?? null
const labelOf = (section: string): string | null =>
  rowOf(section)?.querySelector('span')?.textContent ?? null
const hint = (): HTMLElement | null =>
  Array.from(container.querySelectorAll('p')).find((p) => p.textContent === en.chat.emptyHint) ??
  null
const botIntro = (): HTMLElement | null => q('[data-stub-bot-intro]')
const bases = (...names: string[]): Array<{ name: string }> => names.map((name) => ({ name }))
function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
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
  rec.store.setState({ sessions: [session()] })
  rec.host = {}
  rec.mcp = { total: 0, selected: 0 }
  rec.knowledge = { options: [], selected: [] }
  rec.acl = null
  rec.mcpIds.length = 0
  rec.knowledgeIds.length = 0
  rec.aclIds.length = 0
  rec.bots.length = 0
  rec.cardMounts = 0
  onOpenSection.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('MobileEmptyChat: the hint and the card', () => {
  it('ME-1 a plain session: the hint over one entry card', () => {
    render()
    expect(q('[data-mobile-empty-chat]')).not.toBeNull()
    expect(hint()).not.toBeNull()
    expect(botIntro()).toBeNull()
    expect(container.querySelectorAll('[data-mobile-empty-card]')).toHaveLength(1)
  })

  it("ME-2 a bot session: the bot's introduction instead of the hint, the card stays", () => {
    rec.store.setState({ sessions: [session({ settings: { bot: 'daily' } })] })
    render()
    expect(botIntro()!.getAttribute('data-stub-bot-intro')).toBe('daily')
    expect(rec.bots.at(-1)).toMatchObject({ bot: 'daily' })
    expect(hint()).toBeNull()
    expect(container.querySelectorAll('[data-mobile-empty-card]')).toHaveLength(1)
  })

  it('ME-3 without a host there is no card and no rows; the hint is still there', () => {
    rec.host = null
    rec.mcp = { total: 2, selected: 1 }
    rec.knowledge = { options: bases('a'), selected: ['a'] }
    render()
    expect(q('[data-mobile-empty-card]')).toBeNull()
    expect(rows()).toEqual([])
    expect(hint()).not.toBeNull()
  })

  it('ME-3 without a host a bot session keeps its introduction, with no card', () => {
    rec.host = null
    rec.store.setState({ sessions: [session({ settings: { bot: 'daily' } })] })
    render()
    expect(botIntro()).not.toBeNull()
    expect(q('[data-mobile-empty-card]')).toBeNull()
  })

  it('ME-4 a session that is not in the store is treated as a plain one', () => {
    rec.store.setState({ sessions: [] })
    expect(() => render('ghost')).not.toThrow()
    expect(hint()).not.toBeNull()
    expect(botIntro()).toBeNull()
    expect(q('[data-mobile-empty-card]')).not.toBeNull()
  })
})

describe('MobileEmptyChat: the extensions row', () => {
  it('ME-5 no MCP server to pick: no row', () => {
    render()
    expect(rowOf('extensions')).toBeNull()
  })

  it('ME-6 servers but none selected: the row says so in words', () => {
    rec.mcp = { total: 3, selected: 0 }
    render()
    expect(valueOf('extensions')).toBe(M.emptyExtensionsOff)
  })

  it('ME-7 the number of selected servers', () => {
    rec.mcp = { total: 3, selected: 2 }
    render()
    expect(valueOf('extensions')).toBe('2')
  })
})

describe('MobileEmptyChat: the knowledge row', () => {
  it('ME-8 no base to pick: no row, even with names left in the selection', () => {
    rec.knowledge = { options: [], selected: ['gone', 'older'] }
    render()
    expect(rowOf('knowledge')).toBeNull()
  })

  it('ME-9 bases but none selected: the row says so in words', () => {
    rec.knowledge = { options: bases('a', 'b'), selected: [] }
    render()
    expect(valueOf('knowledge')).toBe(M.emptyKnowledgeNone)
  })

  it('ME-10 only bases that still exist are counted', () => {
    rec.knowledge = { options: bases('a', 'b'), selected: ['a', 'gone'] }
    render()
    expect(valueOf('knowledge')).toBe('1')
  })

  it('ME-11 a selection of bases that are all gone reads as none, not 0', () => {
    rec.knowledge = { options: bases('a'), selected: ['gone'] }
    render()
    expect(valueOf('knowledge')).toBe(M.emptyKnowledgeNone)
  })

  it('ME-12 every base selected', () => {
    rec.knowledge = { options: bases('a', 'b'), selected: ['a', 'b'] }
    render()
    expect(valueOf('knowledge')).toBe('2')
  })
})

describe('MobileEmptyChat: the file access row', () => {
  it('ME-13 while the permission table has not loaded the value is empty', () => {
    render()
    expect(rowOf('paths')).not.toBeNull()
    expect(valueOf('paths')).toBe('')
  })

  it.each<[{ paths: number; sessions: number; widgets: number }, string]>([
    [{ paths: 0, sessions: 0, widgets: 0 }, '0'],
    [{ paths: 4, sessions: 9, widgets: 9 }, '4']
  ])('ME-14 the value is the number of path rows only (%o)', (acl, text) => {
    rec.acl = acl
    render()
    expect(valueOf('paths')).toBe(text)
  })

  it('ME-15 with nothing else to pick it is the only row', () => {
    render()
    expect(rows()).toEqual(['paths'])
  })
})

describe('MobileEmptyChat: the rows', () => {
  const all = (): void => {
    rec.mcp = { total: 3, selected: 2 }
    rec.knowledge = { options: bases('a', 'b'), selected: ['a'] }
    rec.acl = { paths: 4, sessions: 1, widgets: 1 }
  }

  it('ME-16 the order: extensions, knowledge, file access', () => {
    all()
    render()
    expect(rows()).toEqual(['extensions', 'knowledge', 'paths'])
  })

  it('ME-17 the labels are the session-settings ones', () => {
    all()
    render()
    expect(labelOf('extensions')).toBe(en.sessionConfig.extensionsGroup)
    expect(labelOf('knowledge')).toBe(en.sessionConfig.knowledgeGroup)
    expect(labelOf('paths')).toBe(en.sessionAcl.title)
  })

  it.each(['extensions', 'knowledge', 'paths'])(
    'ME-18 tapping %s opens that section',
    (section) => {
      all()
      render()
      click(rowOf(section)!)
      expect(onOpenSection).toHaveBeenCalledTimes(1)
      expect(onOpenSection).toHaveBeenCalledWith(section)
    }
  )

  it('ME-19 every row is a plain button with exactly one value', () => {
    all()
    render()
    for (const section of rows()) {
      const el = rowOf(section!)!
      expect(el.tagName).toBe('BUTTON')
      expect(el.getAttribute('type')).toBe('button')
      expect(el.querySelectorAll('[data-mobile-empty-value]')).toHaveLength(1)
    }
  })

  it('ME-20 session access and widget access have no entry', () => {
    all()
    render()
    expect(rowOf('sessions')).toBeNull()
    expect(rowOf('widgets')).toBeNull()
  })
})

describe('MobileEmptyChat: following its inputs', () => {
  it('ME-21 the hooks are asked about the session given, and about the new one after a change', () => {
    render('s1')
    expect(rec.mcpIds.at(-1)).toBe('s1')
    expect(rec.knowledgeIds.at(-1)).toBe('s1')
    expect(rec.aclIds.at(-1)).toBe('s1')
    render('s2')
    expect(rec.mcpIds.at(-1)).toBe('s2')
    expect(rec.knowledgeIds.at(-1)).toBe('s2')
    expect(rec.aclIds.at(-1)).toBe('s2')
  })

  it('ME-22 the values follow the hooks', () => {
    rec.mcp = { total: 2, selected: 0 }
    render()
    expect(valueOf('extensions')).toBe(M.emptyExtensionsOff)
    rec.mcp = { total: 2, selected: 1 }
    rec.acl = { paths: 3, sessions: 0, widgets: 0 }
    render()
    expect(valueOf('extensions')).toBe('1')
    expect(valueOf('paths')).toBe('3')
  })

  it('ME-23 a session that becomes a bot session switches to the introduction; the card is kept', () => {
    render()
    expect(hint()).not.toBeNull()
    expect(rec.cardMounts).toBe(1)
    act(() => rec.store.setState({ sessions: [session({ settings: { bot: 'daily' } })] }))
    expect(hint()).toBeNull()
    expect(botIntro()!.getAttribute('data-stub-bot-intro')).toBe('daily')
    expect(q('[data-mobile-empty-card]')).not.toBeNull()
    expect(rec.cardMounts).toBe(1)
  })
})
