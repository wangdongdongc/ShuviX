// @vitest-environment jsdom
/**
 * AssistantBubble 与流式状态（jsdom）：**只有流式卡读流式状态**。
 *
 * 运行中的会话每秒推来十来次更新（流式正文 / 思考 / 正在生成的工具调用 / MCP 连接）。已落定的卡若也订阅
 * 这些值，每次都跟着重渲染 —— 卡里每段中间文本重新解析 markdown、每个代码块重新高亮，一轮越长越卡。
 * 钉的是这条分界的两面：
 *
 *   A-1 / A-2 已落定的卡（isStreaming 不给 / 给 false）：一整串流式更新下渲染次数恒为 1、终答只解析一次，
 *             卡里不出现流式行（MCP 连接、待执行 / 生成中的工具行、光标）；同一棵树里的流式卡是正控制组
 *   A-3…A-6   流式卡照常跟着走：正文 + 光标、思考 + 生成中光标、待执行 / 生成中的工具行（生成中时正文不带
 *             光标）、MCP 连接行
 *   A-7       流式卡原位落定（同一次提交：流式正文清空 + 换成真消息）之后，再来的流式更新不再让它重渲染
 *   A-8       同一份判断用 Profiler 再看一次：store 驱动的更新里，落定卡那棵子树一次 update 都没有
 *   A-9       真实路径：applySessionView 推实时卡（文字生长 → 末尾两个工具块）
 *   A-10      落定前后正文相同：markdown 不重新解析、正文容器是同一个节点、复制按钮出现
 *   A-11      流式卡里新落盘一步：之前那一步的中间文本不重新解析
 *   A-12      工具块的实时执行状态仍由工具行自己订阅（不受分组 memo 影响）
 *   A-13      留住的最后一帧：msgs 没换时流式正文清空仍显示那一帧；msgs 一换就放手
 *   A-14      落定卡翻成流式：翻过来的那一次渲染就读到当前的流式正文
 *
 * 探针：
 *   - **P1 渲染次数**：`useTtsPlayback` 只有 AssistantBubble 调，桩里按卡外层的 Context 标签计数 ——
 *     调用次数就是这张卡的渲染次数。流式卡的正文一变会在渲染中 `setHeld`，同一次提交里渲染两遍，所以
 *     流式卡只断言「增加了」，确切次数只对落定卡断言；
 *   - **P3 解析次数**：`react-markdown` 换成透传的包装，记下每次被渲染时的源文本 —— 一次即一次解析；
 *   - **Profiler**（A-8）：只在父级不重渲染、更新全由 store 驱动时有效（父级重渲染时 react-dom 19 会把
 *     memo 跳过的子树也记成一次 update），所以那条用例只 render 一次。
 *
 * 数据走真的 chatStore（直接写 `sessionStreams`，或 A-9 的 `applySessionView`）。包入口
 * （`getHostApi`）顶掉，i18n 走真 en 资源；文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Profiler, act, createElement, type Context, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AssistantMessage } from '@shuvix/chat-protocol/types/chatMessage'

const probe = vi.hoisted(() => ({
  /** 卡标签 → AssistantBubble 渲染次数（P1） */
  renders: new Map<string, number>(),
  /** react-markdown 每渲染一次记下它的源文本（P3） */
  parses: [] as string[],
  /** 卡标签的 Context（由 useTtsPlayback 的桩建、读） */
  card: null as Context<string> | null
}))

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))
vi.mock('../../../hooks/useTtsPlayback', async () => {
  const React = await import('react')
  const card = React.createContext('')
  probe.card = card
  const tts = {
    isPlaying: false,
    isLoading: false,
    playingMessageId: null,
    speak: () => {},
    stop: () => {}
  }
  return {
    useTtsPlayback: () => {
      const label = React.useContext(card)
      probe.renders.set(label, (probe.renders.get(label) ?? 0) + 1)
      return tts
    }
  }
})
vi.mock('react-markdown', async (importOriginal) => {
  const real = await importOriginal<typeof import('react-markdown')>()
  const React = await import('react')
  const Real = real.default
  return {
    ...real,
    default: (props: Parameters<typeof Real>[0]) => {
      probe.parses.push(typeof props.children === 'string' ? props.children : '')
      return React.createElement(Real, props)
    }
  }
})

import { applySessionView, useChatStore } from '../../../stores/chatStore'
import { emptyStream, type SessionStreamState } from '../../../stores/viewDerivation'
import { AssistantBubble } from '../AssistantBubble'
import { streamingPlaceholder } from '../conversationItems'
import {
  V,
  assistant,
  liveCard,
  resetStore,
  text,
  thinking,
  toolBlock,
  user
} from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 's1'

let container: HTMLDivElement
let root: Root

// ─── 挂载 ──────────────────────────────────────────────────

interface Card {
  /** 计数与 DOM 定位用的标签（`[data-card]`） */
  label: string
  msgs: AssistantMessage[]
  /** undefined = 不给这个 prop */
  isStreaming?: boolean
}

function cardElement({ label, msgs, isStreaming }: Card): ReactNode {
  return createElement(
    probe.card!.Provider,
    { key: label, value: label },
    createElement(
      'div',
      { 'data-card': label },
      createElement(AssistantBubble, {
        msgs,
        ...(isStreaming === undefined ? {} : { isStreaming })
      })
    )
  )
}

const tree = (...cards: Card[]): ReactNode => createElement('div', null, ...cards.map(cardElement))

function show(...cards: Card[]): void {
  act(() => root.render(tree(...cards)))
}

/** 流式占位卡（每次一个新对象 —— 与 buildVisibleItems 每次造一个一样） */
const live = (label = 'live'): Card => ({
  label,
  msgs: [streamingPlaceholder(SID)],
  isStreaming: true
})

// ─── store 驱动 ────────────────────────────────────────────

/** 把当前会话的流式状态改成「在跑 + patch」（不在 act 里，供组合） */
function patchStream(patch: Partial<SessionStreamState>): void {
  useChatStore.setState((s) => ({
    sessionStreams: {
      ...s.sessionStreams,
      [SID]: { ...(s.sessionStreams[SID] ?? emptyStream(true)), ...patch }
    }
  }))
}

function stream(patch: Partial<SessionStreamState>): void {
  act(() => patchStream(patch))
}

const store = (): ReturnType<typeof useChatStore.getState> => useChatStore.getState()

/** 一串运行中的会话会推来的更新（A-1 / A-2 / A-8 共用） */
const LIVE_UPDATES: Array<[string, () => void]> = [
  ['正文 H', () => stream({ content: 'H' })],
  ['正文 Hello', () => stream({ content: 'Hello' })],
  ['思考', () => stream({ thinking: 'pondering' })],
  ['工具调用开始生成', () => stream({ streamingToolCall: { toolName: 'write', argsText: '{"p' } })],
  [
    '工具调用参数生长',
    () => stream({ streamingToolCall: { toolName: 'write', argsText: '{"path":"a.txt"' } })
  ],
  [
    '一个待执行',
    () => stream({ completedStreamingToolCalls: [{ toolName: 'read', args: { path: 'a' } }] })
  ],
  [
    '两个待执行',
    () =>
      stream({
        completedStreamingToolCalls: [
          { toolName: 'read', args: { path: 'a' } },
          { toolName: 'read', args: { path: 'b' } }
        ]
      })
  ],
  ['MCP github', () => act(() => store().setMcpConnecting(SID, 'github', true))],
  ['MCP fs', () => act(() => store().setMcpConnecting(SID, 'fs', true))],
  ['MCP 清空', () => act(() => store().clearMcpConnecting(SID))]
]

// ─── 读取 ──────────────────────────────────────────────────

const renders = (label: string): number => probe.renders.get(label) ?? 0
const parsesOf = (md: string): number => probe.parses.filter((p) => p === md).length
const cardEl = (label: string): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-card="${label}"]`)!
/** 卡里第一个 markdown 正文容器（只有终答时就是终答） */
const body = (label: string): HTMLElement | null =>
  cardEl(label).querySelector<HTMLElement>('.markdown-body')
const caretOf = (label: string): Element | null =>
  cardEl(label).querySelector('.markdown-body > span.animate-pulse')
const liveToolRows = (label: string): NodeListOf<Element> =>
  cardEl(label).querySelectorAll('[data-tool-status="pending"], [data-tool-status="generating"]')
const mcpRow = (label: string): HTMLElement | null =>
  cardEl(label).querySelector<HTMLElement>('[data-mcp-connecting]')
/** ThinkingBlock：`data-thinking-block`（role="button" 的 div） */
const thinkingRows = (label: string): HTMLElement[] => [
  ...cardEl(label).querySelectorAll<HTMLElement>('[data-thinking-block]')
]

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  resetStore(SID)
  probe.renders.clear()
  probe.parses.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('已落定的卡不跟着流式状态走（A-1 / A-2）', () => {
  it.each([
    ['A-1', 'isStreaming 不给', undefined],
    ['A-2', 'isStreaming: false', false]
  ])(
    '%s %s：一整串流式更新下渲染恒为 1、终答只解析一次、卡里没有任何流式行（流式卡照常跟着走）',
    (_id, _what, flag) => {
      stream({})
      show(
        {
          label: 'settled',
          msgs: [assistant('a1', [text('settled answer')], SID)],
          isStreaming: flag
        },
        live()
      )
      expect(renders('settled')).toBe(1)

      for (const [what, update] of LIVE_UPDATES) {
        const before = renders('live')
        update()
        // 正控制组：同一棵树里的流式卡每一步都重渲染 —— 证明这一步真的推到了 store
        expect(renders('live'), `${what}：流式卡`).toBeGreaterThan(before)
        expect(renders('settled'), `${what}：落定卡`).toBe(1)
      }

      expect(parsesOf('settled answer')).toBe(1)
      expect(mcpRow('settled')).toBeNull()
      expect(liveToolRows('settled')).toHaveLength(0)
      expect(caretOf('settled')).toBeNull()
      expect(thinkingRows('settled')).toHaveLength(0)
      expect(body('settled')!.textContent).toBe('settled answer')
      // 流式卡确实画出了这些行（否则上面那几条「没有」恒绿）
      expect(liveToolRows('live')).toHaveLength(3)
      expect(thinkingRows('live')).toHaveLength(1)
    }
  )
})

describe('流式卡照常跟着走（A-3…A-6）', () => {
  it('A-3 正文 Hel → Hello：正文是 Hello、光标紧跟其后、markdown 拿到 Hello、渲染次数增加', () => {
    stream({ content: 'Hel' })
    show(live())
    const before = renders('live')
    stream({ content: 'Hello' })
    expect(body('live')!.textContent).toBe('Hello')
    const caret = caretOf('live')
    expect(caret).not.toBeNull()
    expect(body('live')!.lastElementChild).toBe(caret)
    expect(probe.parses).toContain('Hello')
    expect(renders('live')).toBeGreaterThanOrEqual(before + 1)
  })

  it('A-4 只有思考：一行思考 + 生成中光标；思考变了跟着变；正文一到思考的光标就收起', () => {
    stream({ thinking: 'step by step' })
    show(live())
    const rows = thinkingRows('live')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toBe('step by step')
    expect(rows[0].querySelector('span.animate-pulse')).not.toBeNull()
    expect(body('live')).toBeNull()

    stream({ thinking: 'step by step, then more' })
    expect(thinkingRows('live')).toHaveLength(1)
    expect(thinkingRows('live')[0].textContent).toBe('step by step, then more')

    stream({ content: 'x' })
    expect(thinkingRows('live')[0].querySelector('span.animate-pulse')).toBeNull()
    expect(body('live')!.textContent).toBe('x')
  })

  it('A-5 待执行的工具一行一个；正在生成的那个单独一行且正文不带光标；生成结束那一行撤下、光标回来', () => {
    const readA = { toolName: 'read', args: { path: 'a' } }
    stream({ content: 'reading', completedStreamingToolCalls: [readA] })
    show(live())
    const pending = (): NodeListOf<Element> =>
      cardEl('live').querySelectorAll('[data-tool-name="read"][data-tool-status="pending"]')
    const generating = (): NodeListOf<Element> =>
      cardEl('live').querySelectorAll('[data-tool-status="generating"]')
    expect(pending()).toHaveLength(1)
    expect(caretOf('live')).not.toBeNull()

    stream({ completedStreamingToolCalls: [readA, { toolName: 'read', args: { path: 'b' } }] })
    expect(pending()).toHaveLength(2)

    stream({ streamingToolCall: { toolName: 'write', argsText: '{' } })
    expect(generating()).toHaveLength(1)
    expect(generating()[0].getAttribute('data-tool-name')).toBe('write')
    expect(caretOf('live')).toBeNull()

    stream({ streamingToolCall: null })
    expect(generating()).toHaveLength(0)
    expect(pending()).toHaveLength(2)
    expect(caretOf('live')).not.toBeNull()
  })

  it('A-6 MCP 惰性连接：github → github, fs → 清空后整行消失', () => {
    stream({})
    show(live())
    expect(mcpRow('live')).toBeNull()
    act(() => store().setMcpConnecting(SID, 'github', true))
    expect(mcpRow('live')!.textContent).toBe('Connecting to MCP: github')
    act(() => store().setMcpConnecting(SID, 'fs', true))
    expect(mcpRow('live')!.textContent).toBe('Connecting to MCP: github, fs')
    act(() => store().clearMcpConnecting(SID))
    expect(mcpRow('live')).toBeNull()
  })
})

describe('原位落定之后不再跟着走（A-7）', () => {
  it('A-7 同一次提交里流式正文清空 + 换成真消息：之后五次流式更新它一次都不重渲染，正文还在、没有流式行', () => {
    stream({ content: 'Done.' })
    show(live('card'))
    expect(body('card')!.textContent).toBe('Done.')

    // 与 store 的真实时序一致：同一次 set 里清空流式正文、upsert 那张卡；下一轮的占位卡同时出生（正控制组）
    act(() => {
      patchStream({ content: '' })
      root.render(
        tree(
          { label: 'card', msgs: [assistant('a1', [text('Done.')], SID)], isStreaming: false },
          live('next')
        )
      )
    })
    const settledRenders = renders('card')

    const updates: Array<() => void> = [
      () => stream({ content: 'next turn' }),
      () => stream({ thinking: 'hmm' }),
      () => stream({ streamingToolCall: { toolName: 'write', argsText: '{' } }),
      () => stream({ completedStreamingToolCalls: [{ toolName: 'read', args: {} }] }),
      () => act(() => store().setMcpConnecting(SID, 'github', true))
    ]
    for (const [i, update] of updates.entries()) {
      const before = renders('next')
      update()
      expect(renders('next'), `第 ${i + 1} 次：下一张流式卡`).toBeGreaterThan(before)
      expect(renders('card'), `第 ${i + 1} 次：已落定的卡`).toBe(settledRenders)
    }

    expect(body('card')!.textContent).toBe('Done.')
    expect(caretOf('card')).toBeNull()
    expect(liveToolRows('card')).toHaveLength(0)
    expect(mcpRow('card')).toBeNull()
    expect(thinkingRows('card')).toHaveLength(0)
    // 那些更新落到了下一张卡上
    expect(body('next')!.textContent).toBe('next turn')
  })
})

describe('Profiler 视角（A-8）', () => {
  it('A-8 只 render 一次、全由 store 驱动：落定卡（思考 / 中间文本 / 折起的步骤组 / 终答）那棵子树没有一次 update，流式卡每步至少一次', () => {
    const updates = new Map<string, number>()
    const onRender = (id: string, phase: string): void => {
      if (phase !== 'mount') updates.set(id, (updates.get(id) ?? 0) + 1)
    }
    const settledMsgs = [
      assistant(
        'p1',
        [
          thinking('ponder'),
          text('mid text'),
          toolBlock('t1', 'read', { path: 'a.txt' }, { result: 'ok' }),
          toolBlock('t2', 'read', { path: 'b.txt' }, { result: 'ok' })
        ],
        SID
      ),
      assistant('p2', [text('final p')], SID)
    ]
    stream({})
    act(() =>
      root.render(
        createElement(
          'div',
          null,
          createElement(
            Profiler,
            { id: 'settled', onRender },
            createElement(AssistantBubble, { msgs: settledMsgs })
          ),
          createElement(
            Profiler,
            { id: 'streaming', onRender },
            createElement(AssistantBubble, {
              msgs: [streamingPlaceholder(SID)],
              isStreaming: true
            })
          )
        )
      )
    )
    // 落定卡确实画出了这几种行（折起的步骤组一行、思考一行、中间文本、终答）
    expect(container.querySelectorAll('[data-step-group]')).toHaveLength(1)
    expect(container.textContent).toContain('mid text')
    expect(container.textContent).toContain('final p')

    for (const [what, update] of LIVE_UPDATES) {
      const before = updates.get('streaming') ?? 0
      update()
      expect(updates.get('streaming') ?? 0, `${what}：流式卡`).toBeGreaterThanOrEqual(before + 1)
      expect(updates.get('settled') ?? 0, `${what}：落定卡`).toBe(0)
    }
  })
})

describe('真实路径：applySessionView 推实时卡（A-9）', () => {
  it('A-9 实时卡文字生长、末尾长出两个工具块：另一张落定卡渲染恒为 1；流式卡先是正文，后是一行待执行 + 一行生成中', () => {
    const push = (blocks: Parameters<typeof liveCard>[1]): void =>
      act(() =>
        applySessionView(
          SID,
          V(SID, {
            messages: [user('u1', 'hi')],
            live: liveCard(1, blocks),
            toolRuns: {},
            run: { state: 'busy' }
          })
        )
      )

    push([thinking('t'), text('par')])
    show({ label: 'settled', msgs: [assistant('a0', [text('earlier answer')], SID)] }, live())
    expect(renders('settled')).toBe(1)
    expect(body('live')!.textContent).toBe('par')

    push([thinking('t'), text('paragraph grows')])
    expect(body('live')!.textContent).toBe('paragraph grows')
    expect(renders('settled')).toBe(1)

    push([
      thinking('t'),
      text('paragraph grows'),
      toolBlock('t1', 'read', { path: 'a' }),
      toolBlock('t2', 'write', { path: 'b' })
    ])
    const pending = cardEl('live').querySelectorAll('[data-tool-status="pending"]')
    const generating = cardEl('live').querySelectorAll('[data-tool-status="generating"]')
    expect(pending).toHaveLength(1)
    expect(pending[0].getAttribute('data-tool-name')).toBe('read')
    expect(generating).toHaveLength(1)
    expect(generating[0].getAttribute('data-tool-name')).toBe('write')
    expect(renders('settled')).toBe(1)
    expect(body('settled')!.textContent).toBe('earlier answer')
  })
})

describe('落定前后的 markdown 与节点（A-10 / A-11）', () => {
  it('A-10 流式正文与终答相同：落定时不重新解析、正文容器是同一个节点、复制按钮出现', () => {
    const md = 'Final **x**'
    stream({ content: md })
    show(live('card'))
    const node = body('card')
    expect(node).not.toBeNull()
    expect(node!.querySelector('strong')?.textContent).toBe('x')
    expect(parsesOf(md)).toBe(1)
    expect(cardEl('card').querySelector('button[title="Copy"]')).toBeNull()

    act(() => {
      patchStream({ content: '' })
      root.render(
        tree({ label: 'card', msgs: [assistant('a1', [text(md)], SID)], isStreaming: false })
      )
    })
    expect(parsesOf(md)).toBe(1)
    expect(body('card')).toBe(node)
    expect(cardEl('card').querySelectorAll('button[title="Copy"]')).toHaveLength(1)
    expect(caretOf('card')).toBeNull()
  })

  it('A-11 流式卡里又落盘一步（前一条消息是同一个对象）：之前那段中间文本不重新解析，两段都在', () => {
    const a1 = assistant(
      'a1',
      [text('step one'), toolBlock('t1', 'read', {}, { result: 'ok' })],
      SID
    )
    stream({})
    show({ label: 'card', msgs: [a1, streamingPlaceholder(SID)], isStreaming: true })
    expect(parsesOf('step one')).toBe(1)

    const a2 = assistant(
      'a2',
      [text('step two'), toolBlock('t2', 'read', {}, { result: 'ok' })],
      SID
    )
    show({ label: 'card', msgs: [a1, a2, streamingPlaceholder(SID)], isStreaming: true })
    expect(parsesOf('step one')).toBe(1)
    expect(parsesOf('step two')).toBe(1)
    const texts = [...cardEl('card').querySelectorAll('.markdown-body')].map((el) => el.textContent)
    expect(texts).toEqual(['step one', 'step two'])
  })
})

describe('工具行自己的订阅与留住的一帧（A-12…A-14）', () => {
  it('A-12 流式卡里的工具块没回填结果是 running；会话的工具执行记成 done，那一行跟着变', () => {
    stream({})
    show({
      label: 'card',
      msgs: [assistant('a1', [toolBlock('t1', 'bash')], SID), streamingPlaceholder(SID)],
      isStreaming: true
    })
    const row = (): Element => cardEl('card').querySelector('[data-tool-name="bash"]')!
    expect(row().getAttribute('data-tool-status')).toBe('running')

    act(() =>
      useChatStore.setState({
        sessionToolExecutions: {
          [SID]: [{ toolCallId: 't1', toolName: 'bash', args: {}, status: 'done', result: 'x' }]
        }
      })
    )
    expect(row().getAttribute('data-tool-status')).toBe('done')
  })

  it('A-13 留住的一帧：msgs 没换时流式正文清空仍显示 abc；换成新的 msgs（仍在流式、正文为空）就放手', () => {
    const msgs = [streamingPlaceholder(SID)]
    stream({ content: 'abc' })
    show({ label: 'card', msgs, isStreaming: true })
    expect(body('card')!.textContent).toBe('abc')

    stream({ content: '' })
    expect(body('card')!.textContent).toBe('abc')

    show({ label: 'card', msgs: [streamingPlaceholder(SID)], isStreaming: true })
    expect(body('card')).toBeNull()
  })

  it('A-14 落定卡在流式正文变化时不动；同一个实例翻成流式，翻过来那一次渲染就显示当前的流式正文', () => {
    const msgs = [assistant('a1', [text('old')], SID)]
    stream({})
    show({ label: 'card', msgs })
    const settledRenders = renders('card')

    stream({ content: 'pre' })
    expect(renders('card')).toBe(settledRenders)
    expect(body('card')!.textContent).toBe('old')

    const node = cardEl('card')
    show({ label: 'card', msgs, isStreaming: true })
    expect(cardEl('card')).toBe(node)
    expect(body('card')!.textContent).toBe('pre')
  })
})
