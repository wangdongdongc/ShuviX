// @vitest-environment jsdom
/**
 * 一条后台任务的详情 `BgTaskDetail`（BgTaskPanel.tsx 导出，2026-11-16）：面板里是行下面展开的那一块，手机布局把它
 * 单独推成一页（`page`）。
 *
 *   AS-1a 派生 agent：它的对话（经 agent 视图）
 *   AS-1b 子会话：什么都不画（它是一条真正的会话，没有详情）
 *   AS-1c 命令：输出块；缺省压在 `max-h-56` 里，带 `page` 时放高（`max-h-[62dvh]`）
 *   AS-2  手机那几页用到的东西都从包的入口导出
 *
 * 渠道是 chat-ui 的 `fakeServer`（同 bgTaskPanelAgent.dom.test.ts）；`bgTask.readLog` 交回一段固定的输出。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { SessionChannelApi } from '@shuvix/chat-protocol/chatApi'
import type { AgentView } from '@shuvix/chat-protocol/types/sessionView'
import type { TaskInfo } from '@shuvix/chat-protocol/types/task'
import {
  ChatHostProvider,
  setSessionChannelApi,
  useSubSessionStore,
  type ChatHostValue
} from '@shuvix/chat-ui'
import { BgTaskDetail } from './BgTaskPanel'
import * as entry from '../index'
import { fakeServer, type FakeServer } from '../../../chat-ui/src/sync/__tests__/support/fakeServer'
import { assistant, text, user } from '../../../chat-ui/src/__tests__/support/views'

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

const base = { sessionId: 's1', detached: false, startedAt: 1, endedAt: null } as const

const agentTask: TaskInfo = {
  ...base,
  taskId: 'a1',
  kind: 'agent',
  title: 'Agent a1',
  status: 'running',
  subject: { kind: 'agent', profileName: 'prof-a1', depth: 1, parentToolCallId: 'tc-1' }
}
const bashTask: TaskInfo = {
  ...base,
  taskId: 'b1',
  kind: 'bash',
  title: 'echo b1',
  status: 'done',
  endedAt: 2,
  subject: {
    kind: 'bash',
    command: 'echo b1',
    cwd: '/w',
    pid: 1,
    logPath: '/logs/b1.log',
    exitCode: 0,
    signal: null,
    logCapped: false
  }
}
const subSessionTask = {
  ...base,
  taskId: 'ss1',
  kind: 'sub-session',
  title: 'Child',
  status: 'running',
  subject: { kind: 'sub-session', childSessionId: 'c1' }
} as unknown as TaskInfo

function agentView(agentId: string, overrides: Partial<AgentView> = {}): AgentView {
  return {
    v: 1,
    agentId,
    sessionId: 's1',
    conversationId: 2,
    messages: [],
    live: null,
    toolRuns: {},
    run: { state: 'idle' },
    context: { usedTokens: null },
    ...overrides
  }
}

let container: HTMLDivElement
let root: Root
let server: FakeServer
const readLog = vi.fn(async (_params: { toolCallId: string }) => ({
  text: 'OUTPUT-LINE',
  nextByte: 11,
  exists: true
}))

async function render(task: TaskInfo, page?: boolean): Promise<void> {
  act(() => {
    root.render(
      createElement(
        HostProvider,
        { value: HOST },
        createElement(BgTaskDetail, page === undefined ? { task } : { task, page })
      )
    )
  })
  await act(async () => {
    await server.settle()
  })
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } } })
})

beforeEach(() => {
  useSubSessionStore.setState({ subSessions: {} })
  readLog.mockClear()
  server = fakeServer()
  setSessionChannelApi({
    sync: server.channel,
    agent: { onEvent: () => () => {}, subAgentPrompt: async () => ({ success: true }) },
    events: { subscribe: () => () => {} },
    bgTask: { readLog }
  } as unknown as SessionChannelApi)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('BgTaskDetail', () => {
  it('AS-1a an agent task: its transcript, read through the agent view', async () => {
    server.serve(
      { kind: 'agent', agentId: 'a1' },
      agentView('a1', {
        messages: [user('u1', 'do X', 'a1'), assistant('m1', [text('ANSWER-ALPHA')], 'a1')]
      })
    )
    await render(agentTask)
    expect(server.subscriptions({ kind: 'agent', agentId: 'a1' })).toHaveLength(1)
    expect(container.textContent).toContain('ANSWER-ALPHA')
    expect(readLog).not.toHaveBeenCalled()
  })

  it('AS-1b a sub-session task renders nothing', async () => {
    await render(subSessionTask)
    expect(container.innerHTML).toBe('')
    expect(readLog).not.toHaveBeenCalled()
    expect(server.calls.filter((c) => c.startsWith('subscribe:'))).toEqual([])
  })

  it('AS-1c a command: the output block, capped at max-h-56 by default', async () => {
    await render(bashTask)
    expect(readLog).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: 'b1' }))
    expect(container.textContent).toContain('echo b1')
    expect(container.textContent).toContain('OUTPUT-LINE')
    expect(container.querySelector('.max-h-56')).not.toBeNull()
    expect(container.querySelector('[class*="62dvh"]')).toBeNull()
  })

  it('AS-1c with `page` the output block is the taller variant', async () => {
    await render(bashTask, true)
    expect(container.textContent).toContain('OUTPUT-LINE')
    expect(container.querySelector('[class*="max-h-[62dvh]"]')).not.toBeNull()
    expect(container.querySelector('.max-h-56')).toBeNull()
  })
})

describe('app-shell entry', () => {
  it('AS-2 exports what the phone pages use', () => {
    const exported = entry as unknown as Record<string, unknown>
    for (const name of [
      'BgTaskDetail',
      'useBlockedTaskIds',
      'useTaskKindLabel',
      'orderTasks',
      'endedAgo',
      'useSessionArtifacts'
    ]) {
      expect(typeof exported[name], name).toBe('function')
    }
    expect(typeof exported.FINISHED_PREVIEW).toBe('number')
    expect(exported.BgTaskDetail).toBe(BgTaskDetail)
  })
})
