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
