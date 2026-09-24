// @vitest-environment jsdom
/**
 * SubSessionStream（派生 agent 的转写视图）的**流式正文**也要告诉代码块「还没写完」（SUB-1）。
 *
 * 主对话里这件事由 AssistantBubble 做：流式时提供 MarkdownStreamingContext + MarkdownSourceContext，
 * 代码块据此判断自己的围栏闭合了没有。子代理面板曾经直接渲 ReactMarkdown、不给这两个上下文 ——
 * 于是代码块读到的缺省值是「没在流式」，一块写了一半的 ```interactive 立刻挂成 iframe，每来一片
 * 新文字就整块重载一次（半截脚本跑起来只会报错）。修法是这里套上与 AssistantBubble 同一对上下文。
 *
 * 钉三件事：流式中没闭合 → 只有占位、没有 iframe；流式中已闭合 → 挂上（正控制组：证明这条路
 * 确实走得到交互图，且宿主开关生效，否则「没有 iframe」恒绿）；写完了 → 挂上。
 *
 * 包入口 `@shuvix/chat-ui` 用真的（上下文与 CodeBlock 必须是同一份模块）；`mermaid` 顶掉。
 * 文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），所以不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

vi.mock('mermaid', () => ({ default: { initialize: () => {}, render: () => {} } }))

import { ChatHostProvider, type ChatHostValue, type SubSessionState } from '@shuvix/chat-ui'
import { SubSessionStream } from './SubAgentStream'

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

const subOf = (streamingContent: string, isStreaming: boolean): SubSessionState => ({
  subSessionId: 'sub-1',
  parentSessionId: 'parent-1',
  subAgentName: 'coding',
  displayName: 'Coding',
  description: '',
  systemPrompt: 'system',
  prompt: 'draw it',
  status: 'running',
  startedAt: 1,
  messages: [],
  streamingContent,
  streamingThinking: '',
  isStreaming,
  streamingToolCall: null,
  completedStreamingToolCalls: [],
  toolExecutions: []
})

/**
 * 就是 ChatHostProvider，只是把 children 在类型上标成可选：它的 props 里 children 是必填的，
 * 而 createElement 从第三个参数传进来的 children 类型检查看不见（写进 props 又过不了
 * react/no-children-prop）。
 */
const HostProvider = ChatHostProvider as (props: {
  value: ChatHostValue
  children?: ReactNode
}) => React.JSX.Element

let container: HTMLDivElement
let root: Root

function show(streamingContent: string, isStreaming: boolean): void {
  act(() => {
    root.render(
      createElement(
        HostProvider,
        { value: HOST },
        createElement(SubSessionStream, {
          sub: subOf(streamingContent, isStreaming),
          focusLast: false
        })
      )
    )
  })
}

const iframes = (): HTMLIFrameElement[] => [...container.querySelectorAll('iframe')]
const pending = (): Element | null => container.querySelector('[data-interactive-pending]')

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } } })
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('子代理面板的流式正文（SUB-1）', () => {
  it('SUB-1 流式中、```interactive 还没闭合：只有占位，没有 iframe；闭合后才挂；写完仍在', () => {
    const head = 'Here is the figure:\n\n```interactive\n<p id="sub1">x</p>\n<script>\nlet n = 1'
    show(head, true)
    expect(pending(), '流式中没闭合应当是占位').not.toBeNull()
    expect(iframes()).toHaveLength(0)

    // 正控制组：同一条路径、闭合之后确实会挂上（证明宿主开关与分发都生效）
    const closed = `${head}\n</script>\n\`\`\`\n\nDone.`
    show(closed, true)
    expect(iframes()).toHaveLength(1)
    expect(pending()).toBeNull()

    show(closed, false)
    expect(iframes()).toHaveLength(1)
  })
})
