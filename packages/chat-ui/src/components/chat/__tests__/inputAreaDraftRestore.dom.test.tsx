// @vitest-environment jsdom
/**
 * 回退之后的草稿回填（P3-10b-18，edit-resend）DOM 测试（jsdom）。
 *
 * confirmRollback 经 `requestDraftRestore(content, tokens)` 交给 InputArea：内容里的粘贴 / @ 标记重建成明文，
 * 粘贴芯片与 @ 引用重新登记（发送时能再构造出等价的 Token），信号随即清掉。回车发出去的 `agent.prompt`
 * 带着与原来相同的内容与 Token —— 编辑后重发不丢信息。
 *
 * 发送时 uid 按次序重新起名（@ 引用 a0…、粘贴 p0…）；原消息用的正是这两个名字，所以逐字相等可断言。
 *
 * 后端整个是假的（同 inputAreaWelcomeSend.dom.test.tsx）：`window.api` 同时充当 HostApi 与
 * SessionChannelApi，调用记进 timeline；包入口 `@shuvix/chat-ui` 顶掉。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { resolveTokensForCopy } from '@shuvix/chat-protocol/utils/inlineTokens'

interface Call {
  name: string
  args: unknown[]
}

vi.mock('@shuvix/chat-ui', () => {
  const api = (): unknown => (globalThis as unknown as { window: { api: unknown } }).window.api
  return {
    getHostApi: api,
    getSessionChannelApi: api,
    useChatHost: () => ({
      models: {
        activeProvider: 'prov-1',
        activeModel: 'model-m',
        setActiveProvider: vi.fn(),
        setActiveModel: vi.fn()
      }
    })
  }
})

import { useChatStore, type Session } from '../../../stores/chatStore'
import { InputArea, type InputAreaProps } from '../InputArea'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 'existing'

const AT: InlineToken = {
  type: 'at',
  id: 'src/a.ts',
  displayText: 'a.ts',
  payload: '[workspace file: src/a.ts]',
  name: 'a.ts'
}
const PASTE: InlineToken = {
  type: 'paste',
  id: 'paste-1',
  displayText: '[粘贴文本 #1 · 3 行]',
  payload: 'line one\nline two\nline three',
  name: '[粘贴文本 #1 · 3 行]'
}
const CONTENT = 'see {{shuvixInlineToken:a0}} and {{shuvixInlineToken:p0}} end'
const TOKENS: Record<string, InlineToken> = { a0: AT, p0: PASTE }

let timeline: Call[] = []

function record<A extends unknown[], R>(name: string, impl: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    timeline.push({ name, args })
    return impl(...args)
  }
}

const row = (id: string): Session =>
  ({
    id,
    title: id,
    projectId: null,
    parentId: null,
    storageKind: 'durable-sqlite-1',
    settings: { enabledTools: [] },
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: 0
  }) as Session

function buildApi(): Record<string, unknown> {
  return {
    session: { list: record('session.list', async () => [row(SID)]) },
    agent: {
      prompt: record('agent.prompt', async () => ({ success: true })),
      abort: record('agent.abort', async () => ({ success: true }))
    },
    tools: { list: record('tools.list', async () => []) },
    files: { scan: record('files.scan', async () => ({ root: null, paths: [] })) },
    mentions: { listKnowledgeEntries: record('mentions.listKnowledgeEntries', async () => []) },
    events: { subscribe: record('events.subscribe', () => () => {}) },
    app: { openSettings: record('app.openSettings', () => {}) }
  }
}

const callsOf = (name: string): unknown[][] =>
  timeline.filter((c) => c.name === name).map((c) => c.args)

let container: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(): Promise<void> {
  await act(async () => {
    const Area = InputArea as (props: InputAreaProps) => React.JSX.Element
    root.render(createElement(Area, { inline: true }))
  })
  await flush()
}

const textarea = (): HTMLTextAreaElement => {
  const el = container.querySelector('textarea')
  if (!el) throw new Error('textarea not rendered')
  return el
}

async function pressEnter(): Promise<void> {
  await act(async () => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await flush()
  await flush()
}

const store = (): ReturnType<typeof useChatStore.getState> => useChatStore.getState()

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  timeline = []
  ;(window as unknown as { api: unknown }).api = buildApi()
  useChatStore.setState({
    sessions: [row(SID)],
    sessionAgentCreated: {},
    sessionClosing: {},
    sessionStreams: {},
    sessionPendingPrompt: {},
    slashCommands: [],
    draftRestoreRequest: null,
    inputText: '',
    pendingImages: []
  })
  store().setActiveSessionId(SID)
  store().setInputText('')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('P3-10b-18 回退之后的草稿回填（edit-resend）', () => {
  it('P3-10b-18 requestDraftRestore(粘贴 + @ 标记, Token) → 明文进输入框、芯片与引用重新登记、信号清掉；回车发出的内容与 Token 与原来相同', async () => {
    await mount()
    await act(async () => {
      store().requestDraftRestore(CONTENT, TOKENS)
    })
    await flush()

    expect(textarea().value).toBe('see @a.ts and [粘贴文本 #1 · 3 行] end')
    expect(store().inputText).toBe('see @a.ts and [粘贴文本 #1 · 3 行] end')
    expect(store().draftRestoreRequest).toBeNull()

    await pressEnter()

    const prompts = callsOf('agent.prompt') as Array<
      [{ sessionId: string; text: string; inlineTokens?: Record<string, InlineToken> }]
    >
    expect(prompts).toHaveLength(1)
    const [sent] = prompts[0]!
    expect(sent.sessionId).toBe(SID)
    expect(sent.text).toBe(CONTENT)
    expect(sent.inlineTokens).toEqual(TOKENS)
    // 给模型 / 复制看的展开结果也一样（粘贴原文、文件引用都还在）
    expect(resolveTokensForCopy(sent.text, sent.inlineTokens)).toBe(
      resolveTokensForCopy(CONTENT, TOKENS)
    )
  })
})
