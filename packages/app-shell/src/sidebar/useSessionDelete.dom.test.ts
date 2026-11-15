// @vitest-environment jsdom
/**
 * useSessionDelete —— 会话删除全流程（侧栏行菜单与手机布局的详情页共用；jsdom）。
 *
 * 契约：空会话（没有消息、没有子会话）直接删；有消息、或有子会话（哪怕自己是空的 —— 级联删掉的是别的对话）先弹
 * 确认框，确认才删；删 = 宿主的 `session.delete` + 从 store 里移除它和它的子会话。
 *
 *   SD-1 没有消息、没有子会话：直接删，不弹框
 *   SD-2 有消息：弹框；确认之前什么都不删
 *   SD-3 空的父会话带着子会话：弹框并写明子会话一起删；确认后子会话与父会话都从 store 里移除
 *   SD-4 取消：什么都不删，框收起
 *
 * `@shuvix/chat-ui` 换成替身（getChatApi / 只有 getState 的 useChatStore / 立即关闭的 useDialogClose）；ConfirmDialog 是真的。
 * 真 en 文案。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, Fragment, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

const hoisted = vi.hoisted(() => ({
  sessions: [] as Array<{ id: string; parentId: string | null }>,
  messageList: vi.fn(),
  sessionDelete: vi.fn(),
  removeSession: vi.fn()
}))

vi.mock('@shuvix/chat-ui', () => ({
  getChatApi: () => ({
    message: { list: hoisted.messageList },
    session: { delete: hoisted.sessionDelete }
  }),
  useChatStore: {
    getState: () => ({ sessions: hoisted.sessions, removeSession: hoisted.removeSession })
  },
  // ConfirmDialog 用它：立即关闭，不等退场动画
  useDialogClose: (onClose: () => void) => ({ closing: false, handleClose: onClose })
}))

import { useSessionDelete, type UseSessionDeleteReturn } from './useSessionDelete'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const S = en.sidebar

let container: HTMLDivElement
let root: Root
/** 钩子最近一次交回的那一份（在 effect 里记下，渲染期间不动外面的变量） */
const latest: { api: UseSessionDeleteReturn | null } = { api: null }

function Probe(): React.JSX.Element {
  const api = useSessionDelete()
  useEffect(() => {
    latest.api = api
  })
  return createElement(Fragment, null, api.deleteDialog)
}

async function requestDelete(id: string): Promise<void> {
  await act(async () => {
    await latest.api!.requestDelete(id)
  })
}
const dialog = (): HTMLElement | null => container.querySelector<HTMLElement>('.dialog-panel')
const button = (text: string): HTMLButtonElement => {
  const hit = [...container.querySelectorAll('button')].find((b) => b.textContent === text)
  if (!hit) throw new Error(`button ${text} not rendered`)
  return hit
}
async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click()
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
  hoisted.sessions = [{ id: 's1', parentId: null }]
  hoisted.messageList.mockReset().mockResolvedValue([])
  hoisted.sessionDelete.mockReset().mockResolvedValue(undefined)
  hoisted.removeSession.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(createElement(Probe)))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useSessionDelete', () => {
  it('SD-1 no messages and no sub-sessions: deleted at once, no dialog', async () => {
    await requestDelete('s1')
    expect(hoisted.messageList).toHaveBeenCalledWith('s1')
    expect(hoisted.sessionDelete).toHaveBeenCalledExactlyOnceWith('s1')
    expect(hoisted.removeSession).toHaveBeenCalledExactlyOnceWith('s1')
    expect(hoisted.sessionDelete.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.removeSession.mock.invocationCallOrder[0]
    )
    expect(dialog()).toBeNull()
  })

  it('SD-2 a session with messages asks first; nothing is deleted until confirmed', async () => {
    hoisted.messageList.mockResolvedValue([{ id: 'm1' }])
    await requestDelete('s1')
    expect(dialog()).not.toBeNull()
    expect(dialog()!.querySelector('h3')!.textContent).toBe(S.confirmDelete)
    expect(dialog()!.textContent).toContain(S.deleteWarningBold)
    expect(dialog()!.textContent).not.toContain(
      i18n.t('sidebar.deleteSubSessionsWarning', { count: 1 })
    )
    expect(hoisted.sessionDelete).not.toHaveBeenCalled()
    expect(hoisted.removeSession).not.toHaveBeenCalled()

    await click(button(en.common.delete))
    expect(hoisted.sessionDelete).toHaveBeenCalledExactlyOnceWith('s1')
    expect(hoisted.removeSession).toHaveBeenCalledExactlyOnceWith('s1')
    expect(dialog()).toBeNull()
  })

  it('SD-3 an empty parent with a sub-session asks, naming the sub-session; confirming removes child and parent', async () => {
    hoisted.sessions = [
      { id: 's1', parentId: null },
      { id: 'child', parentId: 's1' },
      { id: 'other', parentId: null }
    ]
    await requestDelete('s1')
    expect(dialog()).not.toBeNull()
    expect(dialog()!.textContent).toContain(
      i18n.t('sidebar.deleteSubSessionsWarning', { count: 1 })
    )
    expect(hoisted.sessionDelete).not.toHaveBeenCalled()

    await click(button(en.common.delete))
    // 宿主删父时级联删子：只调一次，删的是父会话
    expect(hoisted.sessionDelete).toHaveBeenCalledExactlyOnceWith('s1')
    expect(hoisted.removeSession.mock.calls).toEqual([['child'], ['s1']])
    expect(dialog()).toBeNull()
  })

  it('SD-4 cancel deletes nothing and closes the dialog', async () => {
    hoisted.messageList.mockResolvedValue([{ id: 'm1' }])
    await requestDelete('s1')
    await click(button(en.common.cancel))
    expect(dialog()).toBeNull()
    expect(hoisted.sessionDelete).not.toHaveBeenCalled()
    expect(hoisted.removeSession).not.toHaveBeenCalled()
  })
})
