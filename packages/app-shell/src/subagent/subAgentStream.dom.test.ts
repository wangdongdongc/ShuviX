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
 * 已落盘转写的分组（GRP-1..4）：与主对话卡同一套 —— 连续的 assistant 消息由 `buildVisibleItems` 并成一段
 * （段在用户消息、错误行、不带工具块的终答处收口），段内块摊平交给 `groupConsecutiveSteps` → `StepGroupView`：
 * 相邻的思考 / 已成功完成的工具调用并成一行 `[data-step-group]`；中间文本、运行中、出错的调用切开一段；
 * 只有一步的不成组。断言按转写区的直接子节点逐个比对（每个分组都是那一层的直接子节点）。
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

import {
  ChatHostProvider,
  useChatStore,
  type ChatHostValue,
  type SubSessionState
} from '@shuvix/chat-ui'
import { SubSessionStream, withoutSpawnPrompt } from './SubAgentStream'
import type { ChatMessage } from '@shuvix/chat-ui'
import type { AssistantToolBlock } from '@shuvix/chat-protocol/types/chatMessage'
import {
  assistant,
  errorRow,
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

/** `extra` 盖在缺省值上（已落盘的 `messages`、`toolExecutions`、起始 `prompt` 等） */
const subOf = (
  streamingContent: string,
  isStreaming: boolean,
  extra: Partial<SubSessionState> = {}
): SubSessionState => ({
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
  toolExecutions: [],
  ...extra
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

function show(
  streamingContent: string,
  isStreaming: boolean,
  extra: Partial<SubSessionState> = {}
): void {
  act(() => {
    root.render(
      createElement(
        HostProvider,
        { value: HOST },
        createElement(SubSessionStream, {
          sub: subOf(streamingContent, isStreaming, extra),
          focusLast: false
        })
      )
    )
  })
}

const iframes = (): HTMLIFrameElement[] => [...container.querySelectorAll('iframe')]
const pending = (): Element | null => container.querySelector('[data-interactive-pending]')

/** 只画已落盘的转写（不在流式；状态 running，没有追问输入框） */
const showMessages = (messages: ChatMessage[], prompt = 'draw it'): void =>
  show('', false, { messages, prompt })

/** 工具卡认哪一次调用：参数里的 `tN.txt`（read 的 path / grep 的 pattern，折叠态摘要就是它） */
const callOf = (el: Element): string => /(t\d+)\.txt/.exec(el.textContent ?? '')?.[1] ?? '?'

/** 转写区的一个直接子节点 → 一句好比对的描述 */
function rowOf(el: Element): string {
  if (el.hasAttribute('data-step-group')) return `group:${el.getAttribute('data-group-size')}`
  if (el.hasAttribute('data-tool-name')) {
    return `tool:${el.getAttribute('data-tool-name')}:${el.getAttribute('data-tool-status')}:${callOf(el)}`
  }
  if (el.classList.contains('markdown-body')) return `text:${el.textContent?.trim()}`
  if (el.classList.contains('justify-end')) return `user:${el.textContent}`
  if (el.classList.contains('text-error/90')) return `error:${el.textContent}`
  return `other:${el.textContent}`
}

/** 转写区（起始气泡、已落盘的各项、流式块所在的那一层）的直接子节点，按 DOM 次序 */
function rows(): string[] {
  const anchor = container.querySelector('[data-step-group], [data-tool-name], .markdown-body')!
  return [...anchor.parentElement!.children].map(rowOf)
}

const groups = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-step-group]')
]
const occurrences = (needle: string): number =>
  (container.textContent ?? '').split(needle).length - 1
const userBubbles = (): string[] =>
  [...container.querySelectorAll('.justify-end > div')].map((b) => b.textContent ?? '')
const expand = (node: HTMLElement): void =>
  act(() => node.querySelector<HTMLElement>('button, [role="button"]')!.click())
/** 一次 read（参数 `tN.txt`）：已完成（结果 `result`）/ 出错 */
const read = (id: string, result = `R-${id}`, isError = false): AssistantToolBlock =>
  toolBlock(id, 'read', { path: `${id}.txt` }, isError ? { result, isError } : { result })
/** 还在跑的 read：结果没回填（`result === undefined`） */
const runningRead = (id: string): AssistantToolBlock => toolBlock(id, 'read', { path: `${id}.txt` })

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

describe('withoutSpawnPrompt（P3-14 PIN-15）', () => {
  const u = (id: string, content: string): ChatMessage => ({
    id,
    sessionId: 'sub-1',
    role: 'user',
    type: 'text',
    content,
    model: '',
    createdAt: 0,
    metadata: null
  })
  const a = (id: string): ChatMessage => ({
    id,
    sessionId: 'sub-1',
    role: 'assistant',
    type: 'message',
    blocks: [{ type: 'text', text: 'ok' }],
    content: 'ok',
    model: 'm',
    createdAt: 0,
    metadata: null
  })

  it('跳过第一条用户条目，当它就是 prompt（或 prompt + 空行 + 契约段）；之后同样文字的追问照常', () => {
    const list = [u('1', 'do X'), a('2'), u('3', 'do X'), a('4')]
    expect(withoutSpawnPrompt(list, 'do X').map((m) => m.id)).toEqual(['2', '3', '4'])
    expect(
      withoutSpawnPrompt([u('1', 'do X\n\nCONTRACT'), a('2')], 'do X').map((m) => m.id)
    ).toEqual(['2'])
  })

  it('没有 prompt、第一条用户条目不是它、或根本没有用户条目：原样交回（同一个数组）', () => {
    const list = [u('1', 'other'), a('2')]
    expect(withoutSpawnPrompt(list, '')).toBe(list)
    expect(withoutSpawnPrompt(list, 'do X')).toBe(list)
    expect(withoutSpawnPrompt([u('1', 'do Xtra')], 'do X')).toHaveLength(1)
    const none = [a('2')]
    expect(withoutSpawnPrompt(none, 'do X')).toBe(none)
  })
})

describe('已落盘转写的步骤合并（与主对话卡同一套，GRP-1..4）', () => {
  // 宿主下发的呈现表：有了它，折叠的工具卡才带摘要（参数里的 `tN.txt`），callOf 认得出是哪一次调用
  beforeEach(() => {
    useChatStore.setState({
      toolPresentations: {
        read: { label: 'Read', icon: 'FileText' },
        grep: { label: 'Grep', icon: 'Search' }
      }
    })
  })
  afterEach(() => {
    // 这时树还挂着（外层的 afterEach 才卸）：还原也要在 act 里
    act(() => useChatStore.setState({ toolPresentations: {} }))
  })

  it.each([
    ['do X', '登记过：视图里那条起始指令被跳过，只剩起始气泡'],
    ['', '没有登记条目：起始气泡不画，视图里那条照常画']
  ])('GRP-1 prompt %j（%s）：一次一个工具的三条消息并成一行，终答在它后面', (prompt) => {
    showMessages(
      [
        user('u1', 'do X', 'sub-1'),
        assistant('a1', [read('t1', 'R1')], 'sub-1'),
        // 空串结果（只交回图片的工具）也算已完成，照样并进去
        assistant('a2', [read('t2', '')], 'sub-1'),
        assistant('a3', [toolBlock('t3', 'grep', { pattern: 't3.txt' }, { result: 'G' })], 'sub-1'),
        assistant('a4', [text('answer')], 'sub-1')
      ],
      prompt
    )
    expect(userBubbles()).toEqual(['do X'])
    expect(rows()).toEqual(['user:do X', 'group:3', 'text:answer'])
    const [group] = groups()
    expect(groups()).toHaveLength(1)
    expect(group!.getAttribute('data-group-size')).toBe('3')
    expect(group!.getAttribute('data-group-state')).toBe('collapsed')
    expect(group!.querySelector('[data-group-count]')?.textContent).toBe('3')
    // 折起来时一张工具卡都没有
    expect(container.querySelectorAll('[data-tool-name]')).toHaveLength(0)
    expect(occurrences('answer')).toBe(1)

    expand(group!)
    expect(group!.getAttribute('data-group-state')).toBe('expanded')
    const cards = [...group!.querySelectorAll('[data-tool-name]')].map((el) => [
      el.getAttribute('data-tool-name'),
      el.getAttribute('data-tool-status'),
      callOf(el)
    ])
    expect(cards).toEqual([
      ['read', 'done', 't1'],
      ['read', 'done', 't2'],
      ['grep', 'done', 't3']
    ])
  })

  it('GRP-2 中间文本、出错与运行中的调用切开一段；只有一步的不成组', () => {
    showMessages([
      assistant('a1', [thinking('think'), read('t1')], 'sub-1'),
      assistant('a2', [read('t2')], 'sub-1'),
      assistant('a3', [text('mid'), read('t3')], 'sub-1'),
      assistant('a4', [read('t4')], 'sub-1'),
      assistant('a5', [read('t5', 'E5', true)], 'sub-1'),
      assistant('a6', [read('t6')], 'sub-1'),
      assistant('a7', [runningRead('t7')], 'sub-1')
    ])
    expect(rows()).toEqual([
      'user:draw it',
      'group:3',
      'text:mid',
      'group:2',
      'tool:read:error:t5',
      'tool:read:done:t6',
      'tool:read:running:t7'
    ])
    expect(groups().map((g) => g.getAttribute('data-group-size'))).toEqual(['3', '2'])
  })

  it('GRP-3 用户追问与错误行把连续的 assistant 消息切成几段，每段各自成组（没有一组跨过它们）', () => {
    showMessages([
      assistant('a1', [read('t1')], 'sub-1'),
      assistant('a2', [read('t2')], 'sub-1'),
      user('u2', 'more', 'sub-1'),
      assistant('a3', [read('t3')], 'sub-1'),
      assistant('a4', [read('t4')], 'sub-1'),
      errorRow('e1', 'boom', 'sub-1'),
      assistant('a5', [read('t5')], 'sub-1'),
      assistant('a6', [read('t6')], 'sub-1'),
      assistant('a7', [text('done')], 'sub-1')
    ])
    expect(groups().map((g) => g.getAttribute('data-group-size'))).toEqual(['2', '2', '2'])
    expect(rows()).toEqual([
      'user:draw it',
      'group:2',
      'user:more',
      'group:2',
      'error:boom',
      'group:2',
      'text:done'
    ])
  })

  it.each([
    [
      '只有思考的终答收口：它与前一条并成一段，下一条另起',
      [
        assistant('a1', [read('t1')], 'sub-1'),
        assistant('a2', [thinking('just thinking')], 'sub-1'),
        assistant('a3', [read('t3')], 'sub-1')
      ],
      ['user:draw it', 'group:2', 'tool:read:done:t3']
    ],
    [
      '空块的终答也收口：前后两张 read 各自一张卡',
      [
        assistant('a1', [read('t1')], 'sub-1'),
        assistant('a2', [], 'sub-1'),
        assistant('a3', [read('t3')], 'sub-1')
      ],
      ['user:draw it', 'tool:read:done:t1', 'tool:read:done:t3']
    ],
    [
      '两条终答各自一段',
      [assistant('a1', [text('one')], 'sub-1'), assistant('a2', [text('two')], 'sub-1')],
      ['user:draw it', 'text:one', 'text:two']
    ]
  ] as const)('GRP-4 段的边界：%s', (_name, messages, expected) => {
    showMessages([...messages])
    expect(rows()).toEqual(expected)
    // 没有哪一组跨过了收口那条（一组 3 步只会是 read + 思考 + read 并到了一起）
    expect(groups().map((g) => g.getAttribute('data-group-size'))).not.toContain('3')
  })
})
