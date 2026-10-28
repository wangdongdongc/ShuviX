// @vitest-environment jsdom
/**
 * 会话权限表卡（SessionAclSection；jsdom）。
 *
 *   SAS-1 按来源排：工作目录、笔记本文档、你授予的、widget 在前；知识库、技能、会话目录收在「显示另外 N 项」后面，
 *         点开全摆出来、再点收起；defaultExpanded 一开始就全摆
 *   SAS-2 能改访问方式的行（工作目录、笔记本文档、授予的）有只读 / 读写切换，其余只写着访问方式；只有授予的行有删除
 *   SAS-3 切访问方式：调 setAclAccess、界面立刻跟着变；后端不答应 → 重取
 *   SAS-4 删除：调 removeAclEntry、行立刻消失
 *   SAS-5 添加：点「添加路径」出表单；输路径、选读写、回车 → grantAcl（来源由后端记成 user）；失败显示原因、表单留着；
 *         成功收起表单并重取
 *   SAS-6 宿主有文件夹选择框才有「选择文件夹」，选了填进路径
 *   SAS-7 这条会话的 session.configChanged → 重取；别的会话的不理
 *   SAS-8 行的标签：system 按槽位、知识库带库名（内置库用它的显示名）、widget 带 id
 *   XS-68 会话种类的行（kind: 'session'）另起一卡「Session access」（见文件末尾的 describe）
 *   WT4-UI-06..09 组件种类的行（kind: 'widget'）另起一卡「Widget access」；widgetDir 路径行（见文件末尾的 describe）
 *
 * `@shuvix/chat-ui` 换成替身（getChatApi / getHostApi / useAppEvent）；i18n 走真 en 资源。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AclEntry } from '@shuvix/chat-protocol/sessionAcl'

const hoisted = vi.hoisted(() => ({
  entries: [] as AclEntry[],
  listAcl: vi.fn(),
  grantAcl: vi.fn(),
  setAclAccess: vi.fn(),
  removeAclEntry: vi.fn(),
  host: null as null | { app: { openDirectoryDialog?: () => Promise<string | null> } },
  handlers: new Map<string, (event: { sessionId: string }) => void>()
}))

vi.mock('@shuvix/chat-ui', () => ({
  getChatApi: () => ({
    session: {
      listAcl: hoisted.listAcl,
      grantAcl: hoisted.grantAcl,
      setAclAccess: hoisted.setAclAccess,
      removeAclEntry: hoisted.removeAclEntry
    }
  }),
  getHostApi: () => hoisted.host,
  useAppEvent: (type: string, handler: (event: { sessionId: string }) => void) => {
    hoisted.handlers.set(type, handler)
  }
}))

import { SessionAclSection } from './SessionAclSection'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 's1'
let seq = 0
function row(source: AclEntry['source'], target: string, over: Partial<AclEntry> = {}): AclEntry {
  seq += 1
  return {
    id: `e${seq}`,
    sessionId: SID,
    kind: 'path',
    target,
    access: 'write',
    source,
    sourceKey: '',
    createdAt: seq,
    updatedAt: seq,
    ...over
  }
}

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false }
  })
})

beforeEach(() => {
  seq = 0
  hoisted.entries = [
    row('system', '/tmp/s1', { sourceKey: 'tmp' }),
    row('skill', '/skills', { access: 'read', sourceKey: '/skills' }),
    row('user', '/data', { access: 'read' }),
    row('knowledge', '/kb/notes', { sourceKey: 'notes' }),
    row('workdir', '/Users/u/proj'),
    row('widget', '/w/clock', { sourceKey: 'clock-face' })
  ]
  hoisted.listAcl.mockReset().mockImplementation(async () => hoisted.entries.map((e) => ({ ...e })))
  hoisted.grantAcl.mockReset().mockResolvedValue({ success: true, entry: null })
  hoisted.setAclAccess.mockReset().mockResolvedValue({ success: true })
  hoisted.removeAclEntry.mockReset().mockResolvedValue({ success: true })
  hoisted.host = null
  hoisted.handlers.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(props: { defaultExpanded?: boolean } = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(SessionAclSection, { sessionId: SID, ...props }))
  })
}

const sources = (): string[] =>
  [...container.querySelectorAll<HTMLElement>('[data-acl-entry]')].map(
    (el) => el.dataset.aclSource!
  )
const rowOf = (source: string): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-acl-source="${source}"]`)!
const buttonText = (scope: ParentNode, text: string): HTMLButtonElement | undefined =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent === text)

describe('SessionAclSection', () => {
  it('SAS-1 前面的行总在；其余收在「显示另外 N 项」后面；defaultExpanded 全摆', async () => {
    await render()
    expect(sources()).toEqual(['workdir', 'user', 'widget'])
    const toggle = container.querySelector<HTMLButtonElement>('[data-acl-toggle]')!
    expect(toggle.textContent).toBe(i18n.t('sessionAcl.showAll', { count: 3 }))
    act(() => toggle.click())
    expect(sources()).toEqual(['workdir', 'user', 'widget', 'knowledge', 'skill', 'system'])
    expect(toggle.textContent).toBe(en.sessionAcl.showLess)
    act(() => toggle.click())
    expect(sources()).toEqual(['workdir', 'user', 'widget'])

    act(() => root.unmount())
    root = createRoot(container)
    await render({ defaultExpanded: true })
    expect(sources()).toEqual(['workdir', 'user', 'widget', 'knowledge', 'skill', 'system'])
  })

  it('SAS-2 切换与删除只给允许的行', async () => {
    await render({ defaultExpanded: true })
    for (const source of ['workdir', 'user', 'widget']) {
      expect(buttonText(rowOf(source), en.sessionAcl.read), source).toBeDefined()
      expect(buttonText(rowOf(source), en.sessionAcl.write), source).toBeDefined()
    }
    for (const source of ['knowledge', 'skill', 'system']) {
      expect(rowOf(source).querySelectorAll('button'), source).toHaveLength(0)
    }
    expect(rowOf('skill').textContent).toContain(en.sessionAcl.read)
    expect(rowOf('user').querySelector('[data-acl-remove]')).not.toBeNull()
    expect(rowOf('widget').querySelector('[data-acl-remove]')).not.toBeNull()
    expect(rowOf('workdir').querySelector('[data-acl-remove]')).toBeNull()
  })

  it('SAS-3 切访问方式：调 setAclAccess，界面立刻变；后端不答应 → 重取', async () => {
    await render()
    const workdir = rowOf('workdir')
    await act(async () => buttonText(workdir, en.sessionAcl.read)!.click())
    expect(hoisted.setAclAccess).toHaveBeenCalledWith({ id: SID, entryId: 'e5', access: 'read' })
    expect(rowOf('workdir').dataset.aclAccess).toBe('read')

    hoisted.setAclAccess.mockResolvedValue({ success: false })
    const calls = hoisted.listAcl.mock.calls.length
    await act(async () => buttonText(rowOf('user'), en.sessionAcl.write)!.click())
    expect(hoisted.listAcl.mock.calls.length).toBe(calls + 1)
  })

  it('SAS-4 删除：调 removeAclEntry，行立刻消失', async () => {
    await render()
    await act(async () =>
      rowOf('user').querySelector<HTMLButtonElement>('[data-acl-remove]')!.click()
    )
    expect(hoisted.removeAclEntry).toHaveBeenCalledWith({ id: SID, entryId: 'e3' })
    expect(sources()).toEqual(['workdir', 'widget'])
  })

  it('SAS-5 添加：回车提交；失败显示原因；成功收起并重取', async () => {
    await render()
    expect(container.querySelector('[data-acl-add-form]')).toBeNull()
    act(() => container.querySelector<HTMLButtonElement>('[data-acl-add]')!.click())
    const form = container.querySelector<HTMLElement>('[data-acl-add-form]')!
    const input = form.querySelector('input')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(input, '  relative/path ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => buttonText(form, en.sessionAcl.write)!.click())

    hoisted.grantAcl.mockResolvedValueOnce({ success: false, entry: null })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(hoisted.grantAcl).toHaveBeenLastCalledWith({
      id: SID,
      target: 'relative/path',
      access: 'write'
    })
    expect(container.textContent).toContain(en.sessionAcl.addFailed)
    expect(container.querySelector('[data-acl-add-form]')).not.toBeNull()

    act(() => {
      setValue.call(input, '/Users/u/data')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const calls = hoisted.listAcl.mock.calls.length
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-acl-add-confirm]')!.click()
    )
    expect(hoisted.grantAcl).toHaveBeenLastCalledWith({
      id: SID,
      target: '/Users/u/data',
      access: 'write'
    })
    expect(container.querySelector('[data-acl-add-form]')).toBeNull()
    expect(hoisted.listAcl.mock.calls.length).toBe(calls + 1)
  })

  it('SAS-6 有文件夹选择框才有「选择文件夹」，选了填进路径', async () => {
    await render()
    act(() => container.querySelector<HTMLButtonElement>('[data-acl-add]')!.click())
    expect(buttonText(container, en.sessionAcl.browse)).toBeUndefined()

    act(() => root.unmount())
    root = createRoot(container)
    hoisted.host = { app: { openDirectoryDialog: async () => '/Users/u/picked' } }
    await render()
    act(() => container.querySelector<HTMLButtonElement>('[data-acl-add]')!.click())
    await act(async () => buttonText(container, en.sessionAcl.browse)!.click())
    expect(container.querySelector('input')!.value).toBe('/Users/u/picked')
  })

  it('SAS-7 这条会话的 configChanged 重取，别的会话不理', async () => {
    await render()
    const calls = hoisted.listAcl.mock.calls.length
    await act(async () => hoisted.handlers.get('session.configChanged')!({ sessionId: 'other' }))
    expect(hoisted.listAcl.mock.calls.length).toBe(calls)
    hoisted.entries = [row('workdir', '/Users/u/elsewhere')]
    await act(async () => hoisted.handlers.get('session.configChanged')!({ sessionId: SID }))
    expect(hoisted.listAcl.mock.calls.length).toBe(calls + 1)
    expect(sources()).toEqual(['workdir'])
    expect(container.textContent).toContain('/Users/u/elsewhere')
  })

  it('SAS-8 行的标签', async () => {
    hoisted.entries = [
      row('system', '/a', { sourceKey: 'toolResults' }),
      row('knowledge', '/b', { sourceKey: 'shuvix' }),
      row('knowledge', '/c', { sourceKey: 'notes' }),
      row('widget', '/d', { sourceKey: 'clock-face' }),
      row('document', '/e.md')
    ]
    await render({ defaultExpanded: true })
    const text = container.textContent ?? ''
    expect(text).toContain(en.sessionAcl.source.toolResults)
    expect(text).toContain(
      i18n.t('sessionAcl.source.knowledge', { name: en.knowledge.builtinBaseName })
    )
    expect(text).toContain(i18n.t('sessionAcl.source.knowledge', { name: 'notes' }))
    expect(text).toContain(i18n.t('sessionAcl.source.widget', { name: 'clock-face' }))
    expect(text).toContain(en.sessionAcl.source.document)
  })
})

/**
 * 会话种类的行（它免询问查看 / 对话的别的会话）：
 *
 *   XS-68 另起一卡「Session access」（[data-session-acl-sessions]），一行摆目标会话的标题（targetTitle）与 id，
 *         没有标题 →「Untitled session」；Read / Talk 切换反映 access，切换调 setAclAccess({ id, entryId, access })；
 *         删除调 removeAclEntry、行立刻消失（删光了整卡消失）；没有会话行 → 没有这一卡；
 *         会话行不进路径列表，也不算进「显示另外 N 项」
 */
describe('SessionAclSection 的会话访问（XS-68）', () => {
  const sessionRow = (target: string, over: Partial<AclEntry> = {}): AclEntry =>
    row('user', target, { kind: 'session', access: 'read', ...over })

  const sessionsCard = (): HTMLElement | null =>
    container.querySelector<HTMLElement>('[data-session-acl-sessions]')
  const sessionRows = (): HTMLElement[] => [
    ...container.querySelectorAll<HTMLElement>('[data-acl-kind="session"]')
  ]
  const sessionRowOf = (target: string): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-acl-kind="session"][data-acl-target="${target}"]`)
  /** SegmentedControl 选中的那一个（bg-bg-primary） */
  const selected = (scope: HTMLElement): string[] =>
    [...scope.querySelectorAll('button')]
      .filter((b) => b.className.split(/\s+/).includes('bg-bg-primary'))
      .map((b) => b.textContent ?? '')

  beforeEach(() => {
    seq = 0
    hoisted.entries = [
      row('workdir', '/Users/u/proj'),
      sessionRow('sess-target-1', { targetTitle: 'Release notes', access: 'write' }),
      row('system', '/tmp/s1', { sourceKey: 'tmp' }),
      sessionRow('sess-target-2'),
      row('user', '/data', { access: 'read' })
    ]
  })

  it('XS-68 另起一卡「Session access」：标题与 id；没有标题 →「Untitled session」', async () => {
    await render()
    const card = sessionsCard()!
    expect(card).not.toBeNull()
    expect(card.dataset.sessionAclSessions).toBe(SID)
    const section = card.closest('section')!
    expect(section.querySelector('h3')!.textContent).toBe(en.sessionAcl.sessionsTitle)
    expect(section.querySelector('h3')!.textContent).toBe('Session access')
    // 与「File access」不是同一卡
    expect(container.querySelector('[data-session-acl]')!.closest('section')).not.toBe(section)

    expect(sessionRows().map((el) => el.dataset.aclTarget)).toEqual([
      'sess-target-1',
      'sess-target-2'
    ])
    expect(sessionRows().every((el) => card.contains(el))).toBe(true)

    const titled = sessionRowOf('sess-target-1')!
    const [title, id] = [...titled.querySelectorAll<HTMLElement>('.truncate')]
    expect(title.textContent).toBe('Release notes')
    expect(id.textContent).toBe('sess-target-1')
    expect(id.classList.contains('font-mono')).toBe(true)

    const untitled = sessionRowOf('sess-target-2')!
    const [title2, id2] = [...untitled.querySelectorAll<HTMLElement>('.truncate')]
    expect(title2.textContent).toBe(en.sessionAcl.sessionUntitled)
    expect(title2.textContent).toBe('Untitled session')
    expect(id2.textContent).toBe('sess-target-2')
  })

  it('XS-68 Read / Talk 反映 access；切换调 setAclAccess({ id, entryId, access })，界面立刻变', async () => {
    await render()
    const talker = sessionRowOf('sess-target-1')!
    const reader = sessionRowOf('sess-target-2')!
    expect(talker.dataset.aclAccess).toBe('write')
    expect(selected(talker)).toEqual([en.sessionAcl.sessionWrite])
    expect(selected(talker)).toEqual(['Talk'])
    expect(reader.dataset.aclAccess).toBe('read')
    expect(selected(reader)).toEqual(['Read'])
    // 会话行的切换是 Read / Talk，不是路径的「Read only / Read & write」
    expect(buttonText(talker, en.sessionAcl.read)).toBeUndefined()
    expect(buttonText(talker, en.sessionAcl.write)).toBeUndefined()

    // 点已选中的那一个：不调
    await act(async () => buttonText(talker, 'Talk')!.click())
    expect(hoisted.setAclAccess).not.toHaveBeenCalled()

    await act(async () => buttonText(talker, 'Read')!.click())
    expect(hoisted.setAclAccess).toHaveBeenCalledTimes(1)
    expect(hoisted.setAclAccess).toHaveBeenCalledWith({ id: SID, entryId: 'e2', access: 'read' })
    expect(sessionRowOf('sess-target-1')!.dataset.aclAccess).toBe('read')
    expect(selected(sessionRowOf('sess-target-1')!)).toEqual(['Read'])

    await act(async () => buttonText(sessionRowOf('sess-target-2')!, 'Talk')!.click())
    expect(hoisted.setAclAccess).toHaveBeenLastCalledWith({
      id: SID,
      entryId: 'e4',
      access: 'write'
    })
    expect(sessionRowOf('sess-target-2')!.dataset.aclAccess).toBe('write')
  })

  it('XS-68 删除：调 removeAclEntry，行立刻消失；删光了整卡消失', async () => {
    await render()
    await act(async () =>
      sessionRowOf('sess-target-1')!.querySelector<HTMLButtonElement>('[data-acl-remove]')!.click()
    )
    expect(hoisted.removeAclEntry).toHaveBeenCalledWith({ id: SID, entryId: 'e2' })
    expect(sessionRowOf('sess-target-1')).toBeNull()
    expect(sessionRows().map((el) => el.dataset.aclTarget)).toEqual(['sess-target-2'])

    await act(async () =>
      sessionRowOf('sess-target-2')!.querySelector<HTMLButtonElement>('[data-acl-remove]')!.click()
    )
    expect(hoisted.removeAclEntry).toHaveBeenLastCalledWith({ id: SID, entryId: 'e4' })
    expect(sessionsCard()).toBeNull()
    expect(container.textContent).not.toContain(en.sessionAcl.sessionsTitle)
    // 路径列表不受影响
    expect(sources()).toEqual(['workdir', 'user'])
  })

  it('XS-68 没有会话行：没有「Session access」这一卡', async () => {
    hoisted.entries = [row('workdir', '/Users/u/proj'), row('user', '/data')]
    await render({ defaultExpanded: true })
    expect(sessionsCard()).toBeNull()
    expect(sessionRows()).toHaveLength(0)
    expect(container.textContent).not.toContain(en.sessionAcl.sessionsTitle)
    expect(container.querySelectorAll('section')).toHaveLength(1)
  })

  it('XS-68 会话行不进路径列表，也不算进「显示另外 N 项」', async () => {
    await render()
    const pathList = container.querySelector<HTMLElement>('[data-session-acl]')!
    expect(pathList.querySelector('[data-acl-kind="session"]')).toBeNull()
    // 会话行的来源也是 user（前排来源）—— 按种类分开，不按来源
    const pathRows = [...pathList.querySelectorAll<HTMLElement>('[data-acl-entry]')]
    expect(pathRows.map((el) => el.dataset.aclEntry)).toEqual(['e1', 'e5'])
    expect(pathRows.map((el) => el.dataset.aclSource)).toEqual(['workdir', 'user'])
    // 收着的只有 system 那一条路径行
    const toggle = container.querySelector<HTMLButtonElement>('[data-acl-toggle]')!
    expect(toggle.textContent).toBe(i18n.t('sessionAcl.showAll', { count: 1 }))

    act(() => toggle.click())
    const expanded = [...pathList.querySelectorAll<HTMLElement>('[data-acl-entry]')]
    expect(expanded.map((el) => el.dataset.aclEntry)).toEqual(['e1', 'e5', 'e3'])
    expect(pathList.querySelector('[data-acl-kind="session"]')).toBeNull()

    // 只有会话行与前排路径行：没有「显示另外 N 项」
    act(() => root.unmount())
    root = createRoot(container)
    hoisted.entries = [row('workdir', '/Users/u/proj'), sessionRow('sess-only')]
    await render()
    expect(container.querySelector('[data-acl-toggle]')).toBeNull()
    expect(sessionRows()).toHaveLength(1)
  })
})

/**
 * 组件种类的行（它免询问只读 / 读写的组件）与读写授权派生出的组件文件夹（widgetDir 路径行）：
 *
 *   WT4-UI-06 另起一卡「Widget access」（[data-session-acl-widgets=<sid>]），与「File access」「Session access」都不是
 *             同一卡；行带 data-acl-kind="widget" / data-acl-target / data-acl-access，第一行是组件名（targetTitle），
 *             没有名字 →「Deleted widget」，第二行是等宽的 id；没有组件行 → 没有这一卡
 *   WT4-UI-07 Read / Read & write 反映 access；切换调 setAclAccess({ id, entryId, access })、界面立刻变（点已选中的不调）；
 *             删除调 removeAclEntry、行立刻消失，删光了整卡消失
 *   WT4-UI-08 组件行、会话行与一串收着的路径行混在一起：组件行不进路径列表、不算进「显示另外 N 项」；
 *             会话行照旧是 Read / Talk 与「Untitled session」
 *   WT4-UI-09 widgetDir 路径行：不用展开就在（前排来源）；标签「Widget folder <id>」；没有删除、没有访问方式切换
 */
describe('SessionAclSection 的组件访问', () => {
  const widgetRow = (target: string, over: Partial<AclEntry> = {}): AclEntry =>
    row('user', target, { kind: 'widget', access: 'read', ...over })
  const sessionRow = (target: string, over: Partial<AclEntry> = {}): AclEntry =>
    row('user', target, { kind: 'session', access: 'read', ...over })

  const widgetsCard = (): HTMLElement | null =>
    container.querySelector<HTMLElement>('[data-session-acl-widgets]')
  const widgetRows = (): HTMLElement[] => [
    ...container.querySelectorAll<HTMLElement>('[data-acl-kind="widget"]')
  ]
  const widgetRowOf = (target: string): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-acl-kind="widget"][data-acl-target="${target}"]`)
  /** 「File access」那一卡里的路径行的来源（sources() 数的是整张表，组件 / 会话行也带 data-acl-entry） */
  const pathSources = (): string[] =>
    [
      ...(container
        .querySelector('[data-session-acl]')
        ?.querySelectorAll<HTMLElement>('[data-acl-entry]') ?? [])
    ].map((el) => el.dataset.aclSource!)
  /** SegmentedControl 选中的那一个（bg-bg-primary） */
  const selected = (scope: HTMLElement): string[] =>
    [...scope.querySelectorAll('button')]
      .filter((b) => b.className.split(/\s+/).includes('bg-bg-primary'))
      .map((b) => b.textContent ?? '')

  beforeEach(() => {
    seq = 0
    hoisted.entries = [
      row('workdir', '/Users/u/proj'),
      widgetRow('reading-list', { targetTitle: 'Reading list', access: 'write' }),
      row('system', '/tmp/s1', { sourceKey: 'tmp' }),
      widgetRow('gone-widget'),
      row('user', '/data', { access: 'read' })
    ]
  })

  it('WT4-UI-06 另起一卡「Widget access」：名字与 id；没有名字 →「Deleted widget」', async () => {
    await render()
    const card = widgetsCard()!
    expect(card).not.toBeNull()
    expect(card.dataset.sessionAclWidgets).toBe(SID)
    const section = card.closest('section')!
    expect(section.querySelector('h3')!.textContent).toBe(en.sessionAcl.widgetsTitle)
    expect(section.querySelector('h3')!.textContent).toBe('Widget access')
    // 与「File access」不是同一卡；这里没有会话行，也就没有「Session access」
    expect(container.querySelector('[data-session-acl]')!.closest('section')).not.toBe(section)
    expect(container.querySelector('[data-session-acl-sessions]')).toBeNull()

    expect(widgetRows().map((el) => el.dataset.aclTarget)).toEqual(['reading-list', 'gone-widget'])
    expect(widgetRows().every((el) => card.contains(el))).toBe(true)
    expect(widgetRows().map((el) => el.dataset.aclEntry)).toEqual(['e2', 'e4'])
    expect(widgetRows().map((el) => el.dataset.aclAccess)).toEqual(['write', 'read'])

    const named = widgetRowOf('reading-list')!
    const [title, id] = [...named.querySelectorAll<HTMLElement>('.truncate')]
    expect(title.textContent).toBe('Reading list')
    expect(id.textContent).toBe('reading-list')
    expect(id.classList.contains('font-mono')).toBe(true)

    const unnamed = widgetRowOf('gone-widget')!
    const [title2, id2] = [...unnamed.querySelectorAll<HTMLElement>('.truncate')]
    expect(title2.textContent).toBe(en.sessionAcl.widgetUnnamed)
    expect(title2.textContent).toBe('Deleted widget')
    expect(id2.textContent).toBe('gone-widget')
    expect(id2.classList.contains('font-mono')).toBe(true)
  })

  it('WT4-UI-06 没有组件行：没有「Widget access」这一卡', async () => {
    hoisted.entries = [row('workdir', '/Users/u/proj'), row('user', '/data')]
    await render({ defaultExpanded: true })
    expect(widgetsCard()).toBeNull()
    expect(widgetRows()).toHaveLength(0)
    expect(container.textContent).not.toContain(en.sessionAcl.widgetsTitle)
    expect(container.querySelectorAll('section')).toHaveLength(1)
  })

  it('WT4-UI-07 Read / Read & write 反映 access；切换调 setAclAccess，界面立刻变', async () => {
    await render()
    const writer = widgetRowOf('reading-list')!
    const reader = widgetRowOf('gone-widget')!
    expect(selected(writer)).toEqual([en.sessionAcl.widgetWrite])
    expect(selected(writer)).toEqual(['Read & write'])
    expect(selected(reader)).toEqual([en.sessionAcl.widgetRead])
    expect(selected(reader)).toEqual(['Read'])
    // 组件行的两档是 Read / Read & write，不是会话的 Talk
    expect(buttonText(writer, en.sessionAcl.sessionWrite)).toBeUndefined()

    // 点已选中的那一个：不调
    await act(async () => buttonText(writer, 'Read & write')!.click())
    expect(hoisted.setAclAccess).not.toHaveBeenCalled()

    await act(async () => buttonText(writer, 'Read')!.click())
    expect(hoisted.setAclAccess).toHaveBeenCalledTimes(1)
    expect(hoisted.setAclAccess).toHaveBeenCalledWith({ id: SID, entryId: 'e2', access: 'read' })
    expect(widgetRowOf('reading-list')!.dataset.aclAccess).toBe('read')
    expect(selected(widgetRowOf('reading-list')!)).toEqual(['Read'])

    await act(async () => buttonText(widgetRowOf('gone-widget')!, 'Read & write')!.click())
    expect(hoisted.setAclAccess).toHaveBeenLastCalledWith({
      id: SID,
      entryId: 'e4',
      access: 'write'
    })
    expect(widgetRowOf('gone-widget')!.dataset.aclAccess).toBe('write')
    expect(selected(widgetRowOf('gone-widget')!)).toEqual(['Read & write'])
  })

  it('WT4-UI-07 删除：调 removeAclEntry，行立刻消失；删光了整卡消失', async () => {
    await render()
    await act(async () =>
      widgetRowOf('reading-list')!.querySelector<HTMLButtonElement>('[data-acl-remove]')!.click()
    )
    expect(hoisted.removeAclEntry).toHaveBeenCalledWith({ id: SID, entryId: 'e2' })
    expect(widgetRowOf('reading-list')).toBeNull()
    expect(widgetRows().map((el) => el.dataset.aclTarget)).toEqual(['gone-widget'])
    expect(widgetsCard()).not.toBeNull()

    await act(async () =>
      widgetRowOf('gone-widget')!.querySelector<HTMLButtonElement>('[data-acl-remove]')!.click()
    )
    expect(hoisted.removeAclEntry).toHaveBeenLastCalledWith({ id: SID, entryId: 'e4' })
    expect(widgetsCard()).toBeNull()
    expect(container.textContent).not.toContain(en.sessionAcl.widgetsTitle)
    // 路径列表不受影响
    expect(pathSources()).toEqual(['workdir', 'user'])
  })

  it('WT4-UI-08 组件行不进路径列表、不算进「显示另外 N 项」；会话行照旧 Read / Talk', async () => {
    seq = 0
    hoisted.entries = [
      row('workdir', '/Users/u/proj'),
      widgetRow('reading-list', { targetTitle: 'Reading list' }),
      row('system', '/tmp/s1', { sourceKey: 'tmp' }),
      sessionRow('sess-target-1', { access: 'write' }),
      row('skill', '/skills', { access: 'read', sourceKey: '/skills' }),
      widgetRow('photo-wall', { source: 'widget', sourceKey: 'photo-wall', access: 'write' }),
      row('knowledge', '/kb/notes', { sourceKey: 'notes' }),
      row('system', '/out', { sourceKey: 'artifacts' })
    ]
    await render()
    const pathList = container.querySelector<HTMLElement>('[data-session-acl]')!
    expect(pathList.querySelector('[data-acl-kind="widget"]')).toBeNull()
    // 组件行的来源（user / widget）都是前排来源 —— 按种类分开，不按来源
    expect(pathSources()).toEqual(['workdir'])
    const toggle = container.querySelector<HTMLButtonElement>('[data-acl-toggle]')!
    // 收着的只有四条路径行（system ×2、skill、knowledge）
    expect(toggle.textContent).toBe(i18n.t('sessionAcl.showAll', { count: 4 }))

    act(() => toggle.click())
    expect(pathSources()).toEqual(['workdir', 'knowledge', 'skill', 'system', 'system'])
    expect(pathList.querySelector('[data-acl-kind="widget"]')).toBeNull()
    expect(pathList.querySelector('[data-acl-kind="session"]')).toBeNull()

    // 组件行全在自己那一卡里
    const card = widgetsCard()!
    expect(widgetRows().map((el) => el.dataset.aclTarget)).toEqual(['reading-list', 'photo-wall'])
    expect(widgetRows().every((el) => card.contains(el))).toBe(true)

    // 会话行：自己那一卡，Read / Talk，没有标题 →「Untitled session」
    const sessionsCard = container.querySelector<HTMLElement>('[data-session-acl-sessions]')!
    const talker = sessionsCard.querySelector<HTMLElement>('[data-acl-kind="session"]')!
    expect(talker.dataset.aclTarget).toBe('sess-target-1')
    expect(selected(talker)).toEqual(['Talk'])
    expect(buttonText(talker, 'Read')).toBeDefined()
    expect(buttonText(talker, 'Read & write')).toBeUndefined()
    const [title] = [...talker.querySelectorAll<HTMLElement>('.truncate')]
    expect(title.textContent).toBe('Untitled session')
    expect(sessionsCard.querySelector('[data-acl-kind="widget"]')).toBeNull()
    expect(card.querySelector('[data-acl-kind="session"]')).toBeNull()
    expect(container.querySelectorAll('section')).toHaveLength(3)
  })

  it('WT4-UI-09 widgetDir 路径行：前排、「Widget folder <id>」、不能删也不能切换', async () => {
    seq = 0
    hoisted.entries = [
      row('system', '/tmp/s1', { sourceKey: 'tmp' }),
      row('widgetDir', '/Users/u/.shuvix/widgets/reading-list', {
        sourceKey: 'reading-list',
        access: 'write'
      }),
      row('workdir', '/Users/u/proj'),
      widgetRow('reading-list', { targetTitle: 'Reading list', access: 'write' })
    ]
    await render()
    // 不用展开就在
    expect(pathSources()).toEqual(['workdir', 'widgetDir'])
    expect(container.querySelector('[data-acl-toggle]')).not.toBeNull()
    const dir = rowOf('widgetDir')
    expect(container.querySelector('[data-session-acl]')!.contains(dir)).toBe(true)
    expect(dir.dataset.aclAccess).toBe('write')
    expect(dir.textContent).toContain(
      i18n.t('sessionAcl.source.widgetDir', { name: 'reading-list' })
    )
    expect(dir.textContent).toContain('Widget folder reading-list')
    expect(dir.textContent).toContain('/Users/u/.shuvix/widgets/reading-list')
    // 访问方式只写着，没有切换、没有删除
    expect(dir.querySelectorAll('button')).toHaveLength(0)
    expect(dir.querySelector('[data-acl-remove]')).toBeNull()
    expect(dir.textContent).toContain(en.sessionAcl.write)
    expect(dir.querySelector('[title]')?.getAttribute('title')).toBe(en.sessionAcl.managed)
  })
})
