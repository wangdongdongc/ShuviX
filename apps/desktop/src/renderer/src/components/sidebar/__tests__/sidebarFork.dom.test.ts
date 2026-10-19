// @vitest-environment jsdom
/**
 * 桌面侧栏的会话 fork（components/sidebar/Sidebar.tsx 接 `useSessionFork(handleSelectSession)`，jsdom）。
 *
 * 契约：共享侧栏拿到的 `onForkSession(id)` → 宿主的 `session.fork({sessionId: id})`（整段，不带 messageId），
 * 成功 → 刷新列表、经侧栏自己的选中入口切到新会话（写 store + 告诉 onOpenSession）；被拒 → overlays 里一个
 * 只有一颗按钮的说明框（标题 `chat.forkFailedTitle`、正文是原因的文案、按钮 `common.close`），点它关掉。
 *
 *   S-D1 选中「分支会话」→ session.fork({sessionId}) → 选中新 id（store + onOpenSession）
 *   S-D1 被拒 → 一颗按钮的说明框；Close 关掉；不选中任何会话
 *
 * 与 sidebarModes 同一套替身：整个 `@shuvix/app-shell` 换成记 props 的壳（共享 Sidebar 把 groupsPrepend /
 * overlays 画出来）；`@shuvix/chat-ui` 给按 selector 读的 store（setActiveSessionId 是 spy）与 getChatApi，
 * 但 `useSessionFork` / `forkRefusalKey` / `useDialogClose` 用 chat-ui 的**真**实现（按源码路径引入）——
 * fork 走 `window.api.session.fork`。确认框不替换：画的是 app-shell 真的 ConfirmDialog。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { SessionForkParams, SessionForkResult } from '@shuvix/chat-protocol/sessionFork'

type Props = Record<string, unknown>

const rec = vi.hoisted(() => ({
  shared: [] as Array<Record<string, unknown>>,
  storeSet: null as unknown as Mock<(id: string | null) => void>,
  state: {
    sessions: [] as Array<{ id: string; projectId?: string | null; settings: Props }>,
    activeSessionId: null as string | null
  }
}))

vi.mock('@shuvix/app-shell', async () => {
  const { createElement: h, Fragment } = await import('react')
  const group = () => () => h('div', { 'data-stub-group': '' })
  return {
    Sidebar: (props: Props) => {
      rec.shared.push(props)
      return h(
        'div',
        { 'data-stub-shared': '' },
        h(Fragment, null, props.groupsPrepend as never),
        h(Fragment, null, props.overlays as never)
      )
    },
    BotGroup: group(),
    AgentGroup: group(),
    PolicyGroup: group(),
    HookGroup: group(),
    SkillGroup: group(),
    KnowledgeGroup: group(),
    useProjects: () => ({ projects: [] }),
    useSessionDelete: () => ({ requestDelete: () => undefined, deleteDialog: null }),
    SessionConfigDialog: () => null
  }
})

vi.mock('@shuvix/chat-ui', async () => {
  const { vi: v } = await import('vitest')
  // 真的 fork 钩子与弹窗关闭动效（chat-ui 源码；包入口只导出 index，按路径引）
  const fork = await import('../../../../../../../../packages/chat-ui/src/hooks/useSessionFork')
  const dialog = await import('../../../../../../../../packages/chat-ui/src/hooks/useDialogClose')
  rec.storeSet = v.fn((id: string | null) => {
    rec.state.activeSessionId = id
  })
  const getState = (): Props => ({
    ...rec.state,
    setActiveSessionId: rec.storeSet,
    setSessions: (sessions: typeof rec.state.sessions) => {
      rec.state.sessions = sessions
    }
  })
  return {
    useChatStore: Object.assign((selector: (s: Props) => unknown) => selector(getState()), {
      getState
    }),
    getChatApi: () => ({
      session: { list: async () => rec.state.sessions, create: async () => ({ id: 'created' }) },
      project: { list: async () => [], create: async () => ({ id: 'p' }) },
      app: { openSettings: async () => undefined }
    }),
    useSessionFork: fork.useSessionFork,
    forkRefusalKey: fork.forkRefusalKey,
    useDialogClose: dialog.useDialogClose
  }
})

vi.mock('../ProjectEditDialog', () => ({ ProjectEditDialog: () => null }))
vi.mock('../SkillDirDialog', () => ({ SkillDirDialog: () => null }))

import { Sidebar, type SidebarProps } from '../Sidebar'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const NEW_ID = 'fork-1'

const api = {
  bot: {
    openNote: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(async () => ({ bots: [], invalid: [] })),
    openFolder: vi.fn()
  },
  pinChat: { focus: vi.fn() },
  session: {
    fork: vi.fn<(params: SessionForkParams) => Promise<SessionForkResult>>(),
    list: vi.fn(async () => [
      { id: 's1', projectId: 'p1', settings: {} },
      { id: NEW_ID, projectId: 'p1', settings: {} }
    ])
  }
}

let container: HTMLDivElement
let root: Root

const SidebarComponent = Sidebar as (props: SidebarProps) => React.JSX.Element

function render(props: SidebarProps = {}): void {
  act(() => root.render(createElement(SidebarComponent, props)))
}

const lastShared = (): Record<string, unknown> => rec.shared.at(-1)!
const dialog = (): HTMLElement | null => container.querySelector<HTMLElement>('.dialog-overlay')

async function pickFork(id: string): Promise<void> {
  const onForkSession = lastShared().onForkSession as ((id: string) => void) | undefined
  expect(typeof onForkSession).toBe('function')
  await act(async () => {
    onForkSession!(id)
  })
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  rec.shared.length = 0
  rec.state.sessions = []
  rec.state.activeSessionId = null
  rec.storeSet.mockClear()
  api.session.fork.mockReset()
  api.session.list.mockClear()
  ;(window as unknown as { api: unknown }).api = api
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('desktop Sidebar fork', () => {
  it('S-D1 选中「分支会话」→ session.fork({sessionId}) → 刷新列表、选中新会话（store + onOpenSession）', async () => {
    api.session.fork.mockResolvedValue({ success: true, sessionId: NEW_ID })
    const onOpenSession = vi.fn()
    render({ onOpenSession })
    await pickFork('s1')

    expect(api.session.fork).toHaveBeenCalledTimes(1)
    const params = api.session.fork.mock.calls[0][0]
    expect(params).toEqual({ sessionId: 's1' })
    expect(Object.keys(params)).toEqual(['sessionId'])
    expect(api.session.list).toHaveBeenCalledTimes(1)
    expect(rec.storeSet.mock.calls).toEqual([[NEW_ID]])
    expect(onOpenSession.mock.calls).toEqual([[NEW_ID]])
    expect(dialog()).toBeNull()
  })

  it('S-D1 被拒 → 一颗按钮的说明框（标题 / 原因文案 / Close）；Close 关掉；不选中任何会话', async () => {
    api.session.fork.mockResolvedValue({ success: false, reason: 'not_forkable' })
    const onOpenSession = vi.fn()
    render({ onOpenSession })
    expect(dialog()).toBeNull()
    await pickFork('s1')

    const d = dialog()
    expect(d).not.toBeNull()
    expect(d!.querySelector('h3')!.textContent).toBe(en.chat.forkFailedTitle)
    expect(d!.textContent).toContain(en.chat.forkNotForkable)
    const buttons = d!.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toBe(en.common.close)
    expect(api.session.list).not.toHaveBeenCalled()
    expect(rec.storeSet).not.toHaveBeenCalled()
    expect(onOpenSession).not.toHaveBeenCalled()

    await act(async () => {
      buttons[0].click()
    })
    expect(dialog()).toBeNull()
  })

  it('S-D1 fork 抛错 → 说明框写 chat.forkFailed', async () => {
    api.session.fork.mockRejectedValue(new Error('ipc'))
    render()
    await pickFork('s1')
    expect(dialog()).not.toBeNull()
    expect(dialog()!.textContent).toContain(en.chat.forkFailed)
    expect(rec.storeSet).not.toHaveBeenCalled()
  })
})
