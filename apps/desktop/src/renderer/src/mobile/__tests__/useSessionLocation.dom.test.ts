// @vitest-environment jsdom
/**
 * 一条会话在哪干活（mobile/useSessionLocation.ts，jsdom）—— 对话页顶栏的小字与详情页「位置」那一行共用。
 *
 * 契约：位置看这条会话的项目上下文 = 所属项目，否则引用的工作项目（bot 会话，和它开出来的子会话）→ 项目名
 * （归档的也算；没名字 →「Unnamed Project」）；项目在清单里找不到时是空串 —— 清单可能还没取回来，不能先说它
 * 「未命名」或「已删除」。没有项目：bot 会话是「Temporary」，别的是「Chats」。
 *
 *   SL-1   没有会话
 *   SL-2 / SL-3 项目会话：项目名，归档的项目也给名字
 *   SL-4..6 清单没到 / 清单里没有 → 空；清单到了就补上
 *   SL-7   项目没名字
 *   SL-8   不属于项目的会话
 *   SL-9..11 bot 会话的工作项目：在、归档、不在清单里
 *   SL-12..14 bot 会话没有工作项目；空白的工作项目算没有；空白的 bot 名不算 bot 会话
 *   SL-15  所属项目盖过多出来的 workProject
 *   SL-16  bot 开出来的子会话（没有 bot、projectId 空、带 workProject）：那个工作项目
 *
 * `@shuvix/app-shell` 只给 useProjects；chat-protocol 是真的；真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { Session } from '@shuvix/chat-ui'

interface ProjectRow {
  id: string
  name: string
}
const rec = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; name: string }>,
  archivedProjects: [] as Array<{ id: string; name: string }>
}))

vi.mock('@shuvix/app-shell', () => ({
  useProjects: () => ({ projects: rec.projects, archivedProjects: rec.archivedProjects })
}))

import { useSessionLocation } from '../useSessionLocation'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const S = en.sidebar
const PROJ: ProjectRow[] = [{ id: 'p1', name: 'Proj' }]
const ARCH: ProjectRow[] = [{ id: 'arch', name: 'Old' }]

let container: HTMLDivElement
let root: Root

const s = (over: Record<string, unknown> = {}): Session =>
  ({ id: 's1', title: 'T', projectId: null, parentId: null, settings: {}, ...over }) as Session

function Probe({ session }: { session: Session | undefined }): React.JSX.Element {
  return h('output', { 'data-loc': '' }, useSessionLocation(session))
}
function locationOf(session: Session | undefined): string {
  act(() => root.render(h(Probe, { session })))
  return container.querySelector('[data-loc]')!.textContent ?? ''
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  rec.projects = PROJ
  rec.archivedProjects = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useSessionLocation: project sessions', () => {
  it('SL-1 no session → empty', () => {
    expect(locationOf(undefined)).toBe('')
  })

  it('SL-2 a project session shows the project name', () => {
    expect(locationOf(s({ projectId: 'p1' }))).toBe('Proj')
  })

  it("SL-3 an archived project's name is still shown", () => {
    rec.archivedProjects = ARCH
    expect(locationOf(s({ projectId: 'arch' }))).toBe('Old')
  })

  it('SL-4 empty while the project list has not loaded: neither "unnamed" nor "deleted"', () => {
    rec.projects = []
    const text = locationOf(s({ projectId: 'p1' }))
    expect(text).toBe('')
    expect(text).not.toBe(S.unnamedProject)
    expect(text).not.toBe(S.botProjectGone)
  })

  it('SL-5 empty when the project is not in the loaded list', () => {
    expect(locationOf(s({ projectId: 'gone' }))).toBe('')
  })

  it('SL-6 the location fills in once the list arrives', () => {
    rec.projects = []
    const session = s({ projectId: 'p1' })
    expect(locationOf(session)).toBe('')
    rec.projects = PROJ
    expect(locationOf(session)).toBe('Proj')
  })

  it('SL-7 a listed project with no name is the unnamed project', () => {
    rec.projects = [{ id: 'p1', name: '' }]
    expect(locationOf(s({ projectId: 'p1' }))).toBe(S.unnamedProject)
  })

  it('SL-8 a session outside any project is in Chats, without waiting for the list', () => {
    rec.projects = []
    expect(locationOf(s())).toBe(S.tempChats)
  })

  it('SL-15 the own project wins over a stray workProject', () => {
    rec.archivedProjects = ARCH
    expect(locationOf(s({ projectId: 'p1', settings: { workProject: 'arch' } }))).toBe('Proj')
  })
})

describe('useSessionLocation: bot sessions and their sub-sessions', () => {
  it('SL-9 a bot session shows its work project', () => {
    expect(locationOf(s({ settings: { bot: 'scout', workProject: 'p1' } }))).toBe('Proj')
  })

  it('SL-10 a bot session whose work project is archived still shows its name', () => {
    rec.archivedProjects = ARCH
    expect(locationOf(s({ settings: { bot: 'scout', workProject: 'arch' } }))).toBe('Old')
  })

  it('SL-11 a bot session whose work project is not in the list is empty, never "Project deleted"', () => {
    const session = s({ settings: { bot: 'scout', workProject: 'gone' } })
    expect(locationOf(session)).toBe('')
    rec.projects = []
    const text = locationOf(session)
    expect(text).toBe('')
    expect(text).not.toBe(S.botProjectGone)
  })

  it('SL-12 a bot session with no work project is Temporary', () => {
    rec.projects = []
    expect(locationOf(s({ settings: { bot: 'scout' } }))).toBe(S.botTempLocation)
  })

  it('SL-13 a blank work project counts as none', () => {
    expect(locationOf(s({ settings: { bot: 'scout', workProject: '  ' } }))).toBe(S.botTempLocation)
  })

  it('SL-14 a blank bot name is not a bot session', () => {
    expect(locationOf(s({ settings: { bot: '  ' } }))).toBe(S.tempChats)
  })

  it("SL-16 a bot's sub-session (no bot, no own project, a copied workProject) shows that project", () => {
    expect(locationOf(s({ parentId: 'bot-root', settings: { workProject: 'p1' } }))).toBe('Proj')
    // 引用的项目不在清单里：同样先不写
    expect(locationOf(s({ parentId: 'bot-root', settings: { workProject: 'gone' } }))).toBe('')
  })
})
