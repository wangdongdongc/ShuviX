// @vitest-environment jsdom
/**
 * 后台任务面板的派生 agent 详情经 agent 视图流式渲染（P3-14 渲染端，13–21；docs/pi-durable/p3-1314-test-design.md）。
 *
 *   P3-14-13 订阅的生命周期：收起不订；展开恰订一次 `{kind:'agent', agentId}`；收起退订一次；展开另一条 = 挪过去；
 *            `taskRevealRequest` 与点开同效
 *   P3-14-14 已落盘与实时正文：落盘的只画一次；实时正文在 MarkdownStreamingContext=true 里、带光标；SUB-1 在
 *            视图驱动下照样成立；落定之后没有流式块、一张卡，展开着的工具卡 / 思考块还是原来那几个 DOM 节点
 *   P3-14-15 工具：实时卡里在跑的工具 → 一张 running 的工具卡（带参数）；落盘之后同一个 toolCallId 恰一张、带结果
 *   P3-14-16 起始指令不重复（PIN-15）：register 的 prompt 气泡一个（带内联 Token 标签），视图里那条（带契约段）跳过
 *   P3-14-17 追问看得见（补 P3-08 PIN-07 的缺口）：subAgentPrompt 一次；子 agent 的 agent_start → running、输入框
 *            收起；视图长出追问与回答、各画一次（没有 user_message）；sub_session_end → done、输入框回来
 *   P3-14-18 忙比过期的状态优先（PIN-14）：status done + run busy → 没有输入框；idle / interrupted → 有
 *   P3-14-19 重建过的渲染端（PIN-13）：任务行在、没有登记条目 → 详情从视图渲染（含第一条用户条目），不说「不在了」，
 *            不建条目
 *   P3-14-20 订阅失败 / 不可用：service_not_found → 「不在了」的文案、不抛；中途 unavailable → 画过的消息留着、
 *            不再流式、登记条目不删
 *   P3-14-21 hook agent 的行（没有 parentToolCallId）走同一条路；同一份视图来两次 → 每条消息对象不变、DOM 不重挂
 *
 * 渠道是 chat-ui 的 `fakeServer`（真 chord 服务端）经 `setSessionChannelApi` 注入；余项事件经真的 `useAgentEvents`
 * （渠道的 `agent.onEvent` 交出监听器，用例直接喂事件）。文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），
 * 一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { SessionChannelApi } from '@shuvix/chat-protocol/chatApi'
import type { SyncTarget } from '@shuvix/chat-protocol/sync'
import type { AgentView } from '@shuvix/chat-protocol/types/sessionView'
import type { TaskInfo } from '@shuvix/chat-protocol/types/task'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'

vi.mock('mermaid', () => ({ default: { initialize: () => {}, render: () => {} } }))

import {
  ChatHostProvider,
  setSessionChannelApi,
  useAgentEvents,
  useBgTaskStore,
  useChatStore,
  useSubSessionStore,
  type ChatHostValue
} from '@shuvix/chat-ui'
import { BgTaskPanel } from './BgTaskPanel'
import { fakeServer, type FakeServer } from '../../../chat-ui/src/sync/__tests__/support/fakeServer'
import {
  assistant,
  liveCard,
  text,
  thinking,
  toolBlock,
  user
} from '../../../chat-ui/src/__tests__/support/views'

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

/** ChatHostProvider，children 在类型上可选（见 subAgentStream.dom.test.ts 的说明） */
const HostProvider = ChatHostProvider as (props: {
  value: ChatHostValue
  children?: ReactNode
}) => React.JSX.Element

const target = (agentId: string): SyncTarget => ({ kind: 'agent', agentId })

function agentTask(agentId: string, overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    taskId: agentId,
    kind: 'agent',
    sessionId: 's1',
    title: `Agent ${agentId}`,
    status: 'running',
    detached: false,
    startedAt: 1,
    endedAt: null,
    subject: { kind: 'agent', profileName: `prof-${agentId}`, depth: 1, parentToolCallId: 'tc-1' },
    ...overrides
  }
}

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

function register(
  agentId: string,
  extra: { prompt?: string; promptInlineTokens?: Record<string, InlineToken>; tool?: boolean } = {}
): void {
  useSubSessionStore.getState().register({
    subSessionId: agentId,
    parentSessionId: 's1',
    ...(extra.tool === false ? {} : { parentToolCallId: 'tc-1' }),
    subAgentName: `prof-${agentId}`,
    displayName: `Agent ${agentId}`,
    description: 'd',
    systemPrompt: 'SYSTEM PROMPT',
    prompt: extra.prompt ?? 'do X',
    ...(extra.promptInlineTokens === undefined
      ? {}
      : { promptInlineTokens: extra.promptInlineTokens })
  })
}

let container: HTMLDivElement
let root: Root
let server: FakeServer
let emit: (event: ChatEvent) => void
const subAgentPrompt = vi.fn(async (_params: { subSessionId: string; text: string }) => ({
  success: true
}))

function Events(): null {
  useAgentEvents()
  return null
}

function inject(s: FakeServer): void {
  setSessionChannelApi({
    sync: s.channel,
    agent: {
      onEvent: (cb: (event: ChatEvent) => void) => {
        emit = (event) => act(() => cb(event))
        return () => {}
      },
      subAgentPrompt
    },
    events: { subscribe: () => () => {} },
    bgTask: { readLog: async () => ({ text: '', nextByte: 0, exists: true }) }
  } as unknown as SessionChannelApi)
}

function render(): void {
  act(() => {
    root.render(
      createElement(
        HostProvider,
        { value: HOST },
        createElement(Events),
        createElement(BgTaskPanel, { sessionId: 's1' })
      )
    )
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await server.settle()
  })
}

const row = (agentId: string): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-subagent-run="prof-${agentId}"]`)!

async function toggle(agentId: string): Promise<void> {
  act(() => {
    row(agentId).querySelector<HTMLElement>('.cursor-pointer')!.click()
  })
  await settle()
}

const subscribes = (): string[] => server.calls.filter((c) => c.startsWith('subscribe:'))
const unsubscribes = (): string[] => server.calls.filter((c) => c.startsWith('unsubscribe:'))
const replyBox = (): HTMLTextAreaElement | null =>
  container.querySelector<HTMLTextAreaElement>('textarea')
const occurrences = (needle: string): number =>
  (container.textContent ?? '').split(needle).length - 1
const userBubbles = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('.justify-end > div')
]
const cursor = (): Element | null => container.querySelector('.markdown-body .animate-pulse')

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } } })
})

beforeEach(() => {
  useSubSessionStore.setState({ subSessions: {} })
  useBgTaskStore.setState({ tasks: {} })
  useChatStore.setState({ taskRevealRequest: null, slashCommands: [] })
  subAgentPrompt.mockClear()
  server = fakeServer()
  inject(server)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('P3-14-13 subscription lifetime', () => {
  it('collapsed: none; expand: one subscribe; collapse: one unsubscribe; another row moves it; reveal subscribes', async () => {
    for (const id of ['a1', 'a2']) {
      useBgTaskStore.getState().upsert(agentTask(id))
      register(id)
      server.serve(target(id), agentView(id))
    }
    render()
    await settle()
    expect(subscribes()).toEqual([])

    await toggle('a1')
    expect(server.subscriptions(target('a1'))).toHaveLength(1)
    expect(subscribes()).toHaveLength(1)
    await toggle('a1')
    expect(server.subscriptions(target('a1'))).toHaveLength(0)
    expect(unsubscribes()).toHaveLength(1)

    await toggle('a1')
    await toggle('a2')
    expect(server.subscriptions(target('a1'))).toHaveLength(0)
    expect(server.subscriptions(target('a2'))).toHaveLength(1)
    expect(unsubscribes()).toHaveLength(2)

    // 对话流里那张工具卡的行尾被点了 → 独占展开那条，与点开同效
    act(() => useChatStore.getState().revealTask('a1'))
    await settle()
    expect(server.subscriptions(target('a1'))).toHaveLength(1)
    expect(server.subscriptions(target('a2'))).toHaveLength(0)
  })
})

describe('P3-14-14 committed and live text', () => {
  it('committed once; live text streams with the cursor; settles into one card with the same expanded nodes', async () => {
    useBgTaskStore.getState().upsert(agentTask('a1'))
    register('a1')
    server.serve(
      target('a1'),
      agentView('a1', {
        messages: [
          user('u1', 'do X', 'a1'),
          assistant(
            'm1',
            [
              thinking('pondering'),
              toolBlock('t0', 'read', { path: 'f' }, { result: 'R0' }),
              text('alpha')
            ],
            'a1'
          )
        ],
        live: liveCard(9, [text('part')], undefined, 'a1'),
        run: { state: 'busy' }
      })
    )
    render()
    await toggle('a1')
    expect(occurrences('alpha')).toBe(1)
    expect(occurrences('part')).toBe(1)
    expect(cursor()).not.toBeNull()

    // 展开落盘卡里的工具卡与思考块，记下节点
    act(() => {
      container
        .querySelector<HTMLElement>('[data-tool-name="read"] [role], [data-tool-name="read"] > *')!
        .click()
    })
    const toolNode = container.querySelector('[data-tool-name="read"]')!
    expect(toolNode.textContent).toContain('R0')
    const thinkingNode = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('pondering')
    )!
    act(() => thinkingNode.click())

    // 落定：实时卡没了、跑完了、新的一条落盘
    act(() =>
      server.change(target('a1'), (draft) => {
        const view = draft as AgentView
        view.live = null
        view.run = { state: 'idle' }
        view.messages.push(assistant('m2', [text('part done')], 'a1'))
      })
    )
    await settle()
    expect(cursor()).toBeNull()
    expect(occurrences('part done')).toBe(1)
    expect(occurrences('part')).toBe(1)
    expect(container.querySelector('[data-tool-name="read"]')).toBe(toolNode)
    expect(toolNode.textContent).toContain('R0')
    expect(
      [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('pondering'))
    ).toBe(thinkingNode)
  })

  it('SUB-1 from the view: an unclosed ```interactive is only a placeholder; closed → exactly one iframe', async () => {
    useBgTaskStore.getState().upsert(agentTask('a1'))
    register('a1')
    const head = 'Here:\n\n```interactive\n<p id="x">x</p>\n<script>\nlet n = 1'
    server.serve(
      target('a1'),
      agentView('a1', { live: liveCard(9, [text(head)], undefined, 'a1'), run: { state: 'busy' } })
    )
    render()
    await toggle('a1')
    expect(container.querySelector('[data-interactive-pending]')).not.toBeNull()
    expect(container.querySelectorAll('iframe')).toHaveLength(0)
    act(() =>
      server.change(target('a1'), (draft) => {
        const view = draft as AgentView
        view.live = liveCard(9, [text(`${head}\n</script>\n\`\`\`\n\nDone.`)], undefined, 'a1')
      })
    )
    await settle()
    expect(container.querySelectorAll('iframe')).toHaveLength(1)
    expect(container.querySelector('[data-interactive-pending]')).toBeNull()
  })
})

describe('P3-14-15 tool runs', () => {
  it('a running tool in the live card → one running tool card with args; after commit exactly one card with the result', async () => {
    useBgTaskStore.getState().upsert(agentTask('a1'))
    register('a1')
    server.serve(
      target('a1'),
      agentView('a1', {
        messages: [user('u1', 'do X', 'a1')],
        live: liveCard(9, [toolBlock('t1', 'read', { path: 'notes.txt' })], undefined, 'a1'),
        toolRuns: { t1: { toolCallId: 't1', toolName: 'read', status: 'running' } },
        run: { state: 'busy' }
      } as Partial<AgentView>)
    )
    render()
    await toggle('a1')
    const running = container.querySelectorAll('[data-tool-name="read"]')
    expect(running).toHaveLength(1)
    expect(running[0]!.getAttribute('data-tool-status')).toBe('running')
    // 参数在展开的详情里
    act(() => running[0]!.querySelector<HTMLElement>('*')!.click())
    expect(container.querySelector('[data-tool-name="read"]')!.textContent).toContain('notes.txt')

    act(() =>
      server.change(target('a1'), (draft) => {
        const view = draft as AgentView
        view.live = null
        view.run = { state: 'idle' }
        view.toolRuns = {
          t1: { toolCallId: 't1', toolName: 'read', status: 'done' }
        } as unknown as AgentView['toolRuns']
        view.messages.push(
          assistant(
            'm1',
            [toolBlock('t1', 'read', { path: 'notes.txt' }, { result: 'FILE BODY' })],
            'a1'
          )
        )
      })
    )
    await settle()
    const done = container.querySelectorAll('[data-tool-name="read"]')
    expect(done).toHaveLength(1)
    expect(done[0]!.getAttribute('data-tool-status')).toBe('done')
    expect(container.querySelectorAll('[data-tool-status="generating"]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-tool-status="pending"]')).toHaveLength(0)
  })
})

describe('P3-14-16 the spawn prompt bubble (PIN-15)', () => {
  it('exactly one user bubble for the prompt, with its token badges; the contract section is not shown', async () => {
    useBgTaskStore.getState().upsert(agentTask('a1'))
    const token: InlineToken = {
      type: 'cmd',
      id: 'review',
      displayText: '/review',
      payload: 'REVIEW PAYLOAD'
    }
    // register 的 prompt 与派发进子对话的正文同一串（带标记）；视图里那条在末尾多了契约段
    const prompt = '{{shuvixInlineToken:tk1}} do X'
    register('a1', { prompt, promptInlineTokens: { tk1: token } })
    server.serve(
      target('a1'),
      agentView('a1', {
        messages: [
          user('u1', `${prompt}\n\nCONTRACT SECTION: call next`, 'a1'),
          assistant('m1', [text('answer')], 'a1')
        ]
      })
    )
    render()
    await toggle('a1')
    const bubbles = userBubbles()
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0]!.textContent).toContain('do X')
    expect(bubbles[0]!.textContent).toContain('/review')
    expect(occurrences('REVIEW PAYLOAD')).toBe(0)
    expect(occurrences('CONTRACT SECTION')).toBe(0)
    expect(occurrences('answer')).toBe(1)
  })
})

describe('P3-14-17 follow-ups are visible (closes P3-08 PIN-07)', () => {
  it('send → subAgentPrompt once; agent_start → running, input gone; the view grows; sub_session_end → done, input back', async () => {
    useBgTaskStore.getState().upsert(agentTask('a1', { status: 'done', endedAt: 2 }))
    register('a1')
    useSubSessionStore.getState().markEnded({ subSessionId: 'a1', result: 'first' })
    server.serve(
      target('a1'),
      agentView('a1', {
        messages: [user('u1', 'do X', 'a1'), assistant('m1', [text('first')], 'a1')]
      })
    )
    render()
    await toggle('a1')
    const box = replyBox()!
    expect(box).not.toBeNull()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(box, 'more')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(subAgentPrompt).toHaveBeenCalledTimes(1)
    expect(subAgentPrompt.mock.calls[0]![0]).toMatchObject({ subSessionId: 'a1', text: 'more' })

    emit({ type: 'agent_start', sessionId: 'a1' } as ChatEvent)
    expect(useSubSessionStore.getState().subSessions.a1!.status).toBe('running')
    expect(replyBox()).toBeNull()

    act(() =>
      server.change(target('a1'), (draft) => {
        const view = draft as AgentView
        view.messages.push(user('u2', 'more', 'a1'), assistant('m2', [text('ok')], 'a1'))
      })
    )
    await settle()
    expect(userBubbles().filter((b) => b.textContent === 'more')).toHaveLength(1)
    expect(occurrences('ok')).toBe(1)

    emit({ type: 'agent_end', sessionId: 'a1', reason: 'ok' } as ChatEvent)
    emit({
      type: 'sub_session_end',
      sessionId: 'a1',
      parentSessionId: 's1',
      result: 'ok',
      isError: false
    } as ChatEvent)
    expect(useSubSessionStore.getState().subSessions.a1!.status).toBe('done')
    expect(replyBox()).not.toBeNull()
  })
})

describe('P3-14-18 busy wins over a stale status (PIN-14)', () => {
  it.each([
    ['busy', false],
    ['idle', true],
    ['interrupted', true]
  ] as const)('status done + run.state %s → reply input shown: %s', async (state, shown) => {
    useBgTaskStore.getState().upsert(agentTask('a1', { status: 'done', endedAt: 2 }))
    register('a1')
    useSubSessionStore.getState().markEnded({ subSessionId: 'a1', result: 'r' })
    server.serve(
      target('a1'),
      agentView('a1', {
        messages: [user('u1', 'do X', 'a1'), assistant('m1', [text('r')], 'a1')],
        run: { state }
      })
    )
    render()
    await toggle('a1')
    expect(useSubSessionStore.getState().subSessions.a1!.status).toBe('done')
    expect(replyBox() !== null).toBe(shown)
  })
})

describe('P3-14-19 a recreated renderer (PIN-13)', () => {
  it('a task row without a register entry renders view.messages (first user entry included); no gone text; no entry created', async () => {
    useBgTaskStore.getState().upsert(agentTask('a1', { status: 'done', endedAt: 2 }))
    server.serve(
      target('a1'),
      agentView('a1', {
        messages: [user('u1', 'the spawn task', 'a1'), assistant('m1', [text('all done')], 'a1')]
      })
    )
    render()
    await toggle('a1')
    expect(userBubbles().map((b) => b.textContent)).toEqual(['the spawn task'])
    expect(occurrences('all done')).toBe(1)
    expect(container.querySelector('[data-subagent-gone]')).toBeNull()
    expect(useSubSessionStore.getState().subSessions.a1).toBeUndefined()
  })
})

describe('P3-14-20 subscription failure / unavailable', () => {
  it('service_not_found → the "no longer available" text; nothing throws', async () => {
    useBgTaskStore.getState().upsert(agentTask('a1', { status: 'done', endedAt: 2 }))
    server.serve(target('a1'), agentView('a1'))
    server.failSubscribe('service_not_found')
    render()
    await toggle('a1')
    const gone = container.querySelector('[data-subagent-gone]')
    expect(gone?.textContent).toBe('This agent is no longer available')
  })

  it('unavailable mid-view → rendered messages stay, streaming stops, the register entry stays', async () => {
    useBgTaskStore.getState().upsert(agentTask('a1'))
    register('a1')
    server.serve(
      target('a1'),
      agentView('a1', {
        messages: [user('u1', 'do X', 'a1'), assistant('m1', [text('kept')], 'a1')],
        live: liveCard(9, [text('streaming')], undefined, 'a1'),
        run: { state: 'busy' }
      })
    )
    render()
    await toggle('a1')
    expect(cursor()).not.toBeNull()
    act(() => server.withdraw(target('a1')))
    await settle()
    expect(occurrences('kept')).toBe(1)
    expect(cursor()).toBeNull()
    expect(occurrences('streaming')).toBe(0)
    const entry = useSubSessionStore.getState().subSessions.a1
    expect(entry).toBeDefined()
    expect(entry!.messages.map((m) => m.id)).toEqual(['u1', 'm1'])
    expect(entry!.isStreaming).toBe(false)
  })

  it('unavailable mid-view without a register entry → the last messages stay, streaming stops', async () => {
    useBgTaskStore.getState().upsert(agentTask('a1'))
    server.serve(
      target('a1'),
      agentView('a1', {
        messages: [user('u1', 'go', 'a1'), assistant('m1', [text('kept')], 'a1')],
        live: liveCard(9, [text('streaming')], undefined, 'a1'),
        run: { state: 'busy' }
      })
    )
    render()
    await toggle('a1')
    expect(cursor()).not.toBeNull()
    act(() => server.withdraw(target('a1')))
    await settle()
    expect(occurrences('kept')).toBe(1)
    expect(cursor()).toBeNull()
    expect(useSubSessionStore.getState().subSessions.a1).toBeUndefined()
  })
})

describe('agent-row anchors under the newest-first ordering', () => {
  it('data-subagent-run rows: running newest first, then finished by end time; data-subagent-expanded follows the toggle', async () => {
    const tasks = [
      agentTask('a1', { startedAt: 10 }),
      agentTask('a2', { startedAt: 20 }),
      agentTask('a3', { startedAt: 30, status: 'done', endedAt: 40 }),
      agentTask('a4', { startedAt: 5, status: 'error', endedAt: 50 })
    ]
    for (const task of tasks) {
      useBgTaskStore.getState().upsert(task)
      register(task.taskId)
      server.serve(target(task.taskId), agentView(task.taskId))
    }
    render()
    await settle()
    const anchors = (): HTMLElement[] => [
      ...container.querySelectorAll<HTMLElement>('[data-subagent-run]')
    ]
    const expandedOf = (): Record<string, string | null> =>
      Object.fromEntries(
        anchors().map((el) => [
          el.getAttribute('data-task-id'),
          el.getAttribute('data-subagent-expanded')
        ])
      )
    expect(anchors().map((el) => el.getAttribute('data-subagent-run'))).toEqual([
      'prof-a2',
      'prof-a1',
      'prof-a4',
      'prof-a3'
    ])
    for (const el of anchors()) {
      expect(el.getAttribute('data-task-row')).toBe('agent')
      expect(el.getAttribute('data-subagent-run')).toBe(`prof-${el.getAttribute('data-task-id')}`)
    }
    expect(expandedOf()).toEqual({ a1: 'false', a2: 'false', a3: 'false', a4: 'false' })

    await toggle('a1')
    expect(expandedOf()).toEqual({ a1: 'true', a2: 'false', a3: 'false', a4: 'false' })
    expect(server.subscriptions(target('a1'))).toHaveLength(1)

    await toggle('a4')
    expect(expandedOf()).toEqual({ a1: 'false', a2: 'false', a3: 'false', a4: 'true' })
    expect(server.subscriptions(target('a1'))).toHaveLength(0)
    expect(server.subscriptions(target('a4'))).toHaveLength(1)
  })
})

describe('P3-14-21 hook-agent rows (no parentToolCallId)', () => {
  it('stream through the same path; the same view applied twice keeps every message object and DOM node', async () => {
    useBgTaskStore.getState().upsert(
      agentTask('h1', {
        subject: { kind: 'agent', profileName: 'prof-h1', depth: 1 }
      })
    )
    register('h1', { tool: false, prompt: 'title it' })
    server.serve(
      target('h1'),
      agentView('h1', {
        messages: [user('u1', 'title it', 'h1'), assistant('m1', [text('A Title')], 'h1')],
        live: liveCard(9, [text('more')], undefined, 'h1'),
        run: { state: 'busy' }
      })
    )
    render()
    await toggle('h1')
    expect(occurrences('A Title')).toBe(1)
    expect(occurrences('more')).toBe(1)
    const before = useSubSessionStore.getState().subSessions.h1!
    const node = [...container.querySelectorAll('.markdown-body')].find((n) =>
      n.textContent?.includes('A Title')
    )!
    // 同一份值再来一次（reset 帧带着整份快照）
    server.reset(server.subscriptions(target('h1'))[0]!)
    await settle()
    const after = useSubSessionStore.getState().subSessions.h1!
    expect(after.messages).toBe(before.messages)
    after.messages.forEach((m, i) => expect(m).toBe(before.messages[i]))
    expect(
      [...container.querySelectorAll('.markdown-body')].find((n) =>
        n.textContent?.includes('A Title')
      )
    ).toBe(node)
  })
})
