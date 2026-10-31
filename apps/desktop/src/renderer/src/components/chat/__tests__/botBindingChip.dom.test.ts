// @vitest-environment jsdom
/**
 * bot 会话头部的两枚胶囊（components/chat/BotBindingChip.tsx，jsdom）：身份（头像 + 显示名，md 不在就灰显）与工作位置
 * （2026-10-31：bot 会话只归属 bot，这一条在哪干活）。
 *
 *   CH-1  不是 bot 会话 → 什么都不画；身份胶囊显示注册表里的显示名，名字不在注册表里 → data-bot-bound-missing，
 *         `bot.changed` 重查；位置胶囊 `data-bot-location`：引用的项目在（侧栏里的或归档的）→ project + 项目名（没名字 →
 *         「Unnamed Project」）；没有引用 → temp +「Temporary」；引用的项目不在 → gone，先是「Project deleted」，取到
 *         session.getById 的工作目录后是「Project deleted · <文件夹名>」（悬停提示带完整路径）；点它 → 现取 getById 的
 *         workingDirectory → getHostApi().app.openFolder(那个目录)，取不到就不开；
 *         同一个挂着的胶囊从非 bot 会话切到 bot 会话（ChatView 对每条会话都挂它）照常画出来
 *
 * `@shuvix/chat-ui` 换成替身（按 selector 读的 store、BotAvatar、getChatApi / getHostApi 的 spy、记下 bot.changed 处理函数的
 * useAppEvent）；`@shuvix/app-shell` 只给 useProjects；`window.api.bot.list` 是 spy。真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

const rec = vi.hoisted(() => ({
  sessions: [] as Array<{ id: string; settings: Record<string, unknown> }>,
  projects: [] as Array<{ id: string; name: string }>,
  archivedProjects: [] as Array<{ id: string; name: string }>,
  handlers: new Map<string, () => void>(),
  getById: null as unknown as (id: string) => Promise<{ workingDirectory?: string } | undefined>,
  openFolder: null as unknown as (dir: string) => Promise<void>
}))

vi.mock('@shuvix/chat-ui', async () => {
  const { createElement: h } = await import('react')
  return {
    BotAvatar: ({ name }: { name: string }) => h('span', { 'data-avatar': name }),
    useChatStore: (selector: (s: { sessions: typeof rec.sessions }) => unknown) =>
      selector({ sessions: rec.sessions }),
    useAppEvent: (type: string, handler: () => void) => {
      rec.handlers.set(type, handler)
    },
    getChatApi: () => ({ session: { getById: (id: string) => rec.getById(id) } }),
    getHostApi: () => ({ app: { openFolder: (dir: string) => rec.openFolder(dir) } })
  }
})
vi.mock('@shuvix/app-shell', () => ({
  useProjects: () => ({ projects: rec.projects, archivedProjects: rec.archivedProjects })
}))

import { BotBindingChip } from '../BotBindingChip'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const S = en.sidebar
const botList = vi.fn<() => Promise<{ bots: Array<{ name: string; displayName: string }> }>>()
const getById = vi.fn<(id: string) => Promise<{ workingDirectory?: string } | undefined>>()
const openFolder = vi.fn<(dir: string) => Promise<void>>()

let container: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}
async function mount(sessionId: string): Promise<void> {
  act(() => root.render(createElement(BotBindingChip, { sessionId })))
  await flush()
}
const $ = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel)
const locationChip = (): HTMLElement => $('[data-bot-location]')!

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  rec.sessions = []
  rec.projects = [{ id: 'p1', name: 'Proj' }]
  rec.archivedProjects = []
  rec.handlers.clear()
  botList.mockReset().mockResolvedValue({ bots: [{ name: 'scout', displayName: 'Scout' }] })
  getById.mockReset().mockResolvedValue({ workingDirectory: '/work/old-root' })
  openFolder.mockReset().mockResolvedValue(undefined)
  rec.getById = getById
  rec.openFolder = openFolder
  ;(window as unknown as { api: unknown }).api = { bot: { list: botList } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('CH-1 bot session header chips', () => {
  it('CH-1 not a bot session → renders nothing and asks for nothing', async () => {
    rec.sessions = [{ id: 's1', settings: { workProject: 'p1' } }]
    await mount('s1')
    expect(container.innerHTML).toBe('')
    expect(botList).not.toHaveBeenCalled()
    expect(getById).not.toHaveBeenCalled()
  })

  it('CH-1 identity: the registry display name; a name not in the registry is marked missing; bot.changed re-queries', async () => {
    rec.sessions = [{ id: 's1', settings: { bot: 'scout' } }]
    await mount('s1')
    const bound = $('[data-bot-bound="scout"]')!
    expect(bound.textContent).toBe('Scout')
    expect(bound.hasAttribute('data-bot-bound-missing')).toBe(false)

    botList.mockResolvedValue({ bots: [] })
    await act(async () => {
      rec.handlers.get('bot.changed')!()
    })
    await flush()
    expect(botList).toHaveBeenCalledTimes(2)
    expect($('[data-bot-bound="scout"]')!.hasAttribute('data-bot-bound-missing')).toBe(true)
    expect($('[data-bot-bound="scout"]')!.textContent).toBe('scout')
  })

  it.each<[string, Record<string, unknown>, Array<{ id: string; name: string }>, string, string]>([
    ['a listed project', { workProject: 'p1' }, [], 'project', 'Proj'],
    [
      'an archived project',
      { workProject: 'arch' },
      [{ id: 'arch', name: 'Old' }],
      'project',
      'Old'
    ],
    [
      'an unnamed project',
      { workProject: 'blank' },
      [{ id: 'blank', name: '' }],
      'project',
      S.unnamedProject
    ],
    ['no reference', {}, [], 'temp', S.botTempLocation]
  ])('CH-1 location: %s', async (_label, settings, archived, kind, text) => {
    rec.archivedProjects = archived
    rec.sessions = [{ id: 's1', settings: { bot: 'scout', ...settings } }]
    await mount('s1')
    expect(locationChip().getAttribute('data-bot-location')).toBe(kind)
    expect(locationChip().textContent).toBe(text)
    // 项目还在 / 临时：不去取路径快照
    expect(getById).not.toHaveBeenCalled()
  })

  it('CH-1 location: the referenced project is gone → "Project deleted · <folder>" from the session working directory', async () => {
    let resolve!: (v: { workingDirectory?: string }) => void
    getById.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    rec.sessions = [{ id: 's1', settings: { bot: 'scout', workProject: 'gone' } }]
    await mount('s1')
    expect(locationChip().getAttribute('data-bot-location')).toBe('gone')
    expect(locationChip().textContent).toBe(S.botProjectGone)

    await act(async () => {
      resolve({ workingDirectory: '/work/acme-site/' })
    })
    await flush()
    expect(getById).toHaveBeenCalledWith('s1')
    expect(locationChip().textContent).toBe(`${S.botProjectGone} · acme-site`)
    expect(locationChip().getAttribute('title')).toBe(
      `${S.botProjectGone} · acme-site\n/work/acme-site/`
    )
  })

  it('CH-1 clicking the location chip opens the session working directory; no directory → nothing opens', async () => {
    rec.sessions = [{ id: 's1', settings: { bot: 'scout', workProject: 'p1' } }]
    await mount('s1')
    getById.mockResolvedValueOnce({ workingDirectory: '/work/p1' })
    await act(async () => {
      locationChip().click()
    })
    await flush()
    expect(getById).toHaveBeenCalledWith('s1')
    expect(openFolder.mock.calls).toEqual([['/work/p1']])

    getById.mockResolvedValueOnce(undefined)
    await act(async () => {
      locationChip().click()
    })
    await flush()
    expect(openFolder).toHaveBeenCalledTimes(1)
  })

  it('CH-1 the same mounted chip switching from a plain session to a bot session renders the chips', async () => {
    // ChatView 对每条活动会话都挂这一枚胶囊（非 bot 会话自己画空），切会话只换 sessionId
    rec.sessions = [
      { id: 'plain', settings: {} },
      { id: 'b1', settings: { bot: 'scout', workProject: 'gone' } }
    ]
    await mount('plain')
    expect(container.innerHTML).toBe('')
    await mount('b1')
    expect($('[data-bot-bound="scout"]')).not.toBeNull()
    expect(locationChip().getAttribute('data-bot-location')).toBe('gone')
    // 再切回去
    await mount('plain')
    expect(container.innerHTML).toBe('')
  })
})
