// @vitest-environment jsdom
/**
 * 答复跨过 suggest（jsdom）：模型常把整段回复和 `suggest` 写在同一次调用里，工具立刻返回后再补一句收尾。这样的一张卡
 * 数据上是两条消息，答复却是一段 —— 显示源码、复制、朗读都要拿到整段，不能只有最后那句。
 *
 *   SA-1  [长回复 + suggest][收尾]：两段都画成正文（先长回复后收尾，都在提议卡片之前）；过程区没有文字
 *   SA-2  显示源码：一个 <pre>，里面两段全在、空行隔开；markdown 不再画；切回来还是两段
 *   SA-3  复制、朗读拿到同一份整段
 *   SA-4  收尾是空的（模型没再说话）：长回复还是正文，复制 / 显示源码都在
 *   SA-5  卡停在 suggest 这条（中止，没有下一次调用）：同样算正文
 *   SA-6  多次 suggest：三段依次都在
 *   SA-7  只有空白文字的那条不留空段
 *   SA-8  思考留在过程区（与 suggest 的工具行并成一组），文字去正文
 *   SA-9  还在执行 / 出错的 suggest：工具行留在过程区，文字仍是正文
 *   SA-16 落定的 suggest 既有工具行（在过程区，正文之前，状态 done）也有卡片（正文之后）
 *   SA-10 引用块按各自那条回复取钉住的版本：每段的 MarkdownMessageIdContext 是它自己那条消息的 id
 *   SA-11 流式：先前的回复已是正文，流式这段接在它后面（光标只在这段）；流式更新不重新解析先前那段；落定后两个
 *         正文节点都还是原来那两个
 *
 * 对照（这些文字不是答复，留在过程区，行为不变）：
 *   SA-12 同一条消息里 suggest 旁边还有别的工具调用
 *   SA-13 suggest 之后又干了活（卡尾不连着 suggest）
 *   SA-14 没有 suggest 的普通中间文本
 *   SA-15 流式中途：suggest 之后下一步落盘是别的工具，那段文字回到过程区
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AssistantMessage } from '@shuvix/chat-protocol/types/chatMessage'

const probe = vi.hoisted(() => ({
  /** react-markdown 每渲染一次记下它的源文本 */
  parses: [] as string[],
  /** 源文本 → 渲染时读到的 MarkdownMessageIdContext */
  messageIds: new Map<string, string | null>(),
  copied: [] as string[],
  spoken: [] as string[]
}))

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))
vi.mock('../../../utils/clipboard', () => ({
  copyToClipboard: (text: string) => probe.copied.push(text)
}))
vi.mock('../../../hooks/useTtsPlayback', () => ({
  useTtsPlayback: () => ({
    isPlaying: false,
    isLoading: false,
    playingMessageId: null,
    speak: (text: string) => probe.spoken.push(text),
    stop: () => {}
  })
}))
vi.mock('react-markdown', async (importOriginal) => {
  const real = await importOriginal<typeof import('react-markdown')>()
  const React = await import('react')
  const { MarkdownMessageIdContext } = await import('../markdownStreaming')
  const Real = real.default
  function MarkdownProbe(props: Parameters<typeof Real>[0]): ReturnType<typeof Real> {
    const source = typeof props.children === 'string' ? props.children : ''
    probe.parses.push(source)
    probe.messageIds.set(source, React.useContext(MarkdownMessageIdContext))
    return React.createElement(Real, props)
  }
  return { ...real, default: MarkdownProbe }
})

import { useChatStore } from '../../../stores/chatStore'
import { emptyStream, type SessionStreamState } from '../../../stores/viewDerivation'
import { AssistantBubble } from '../AssistantBubble'
import { streamingPlaceholder } from '../conversationItems'
import { assistant, resetStore, text, thinking, toolBlock } from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 's1'
const LONG = 'The long answer'
const TAIL = 'The last line'
const ITEMS = { suggestions: [{ title: 'Add tests', message: 'Yes, add tests' }] }

let container: HTMLDivElement
let root: Root

const settledSuggest = (id = 'c1'): ReturnType<typeof toolBlock> =>
  toolBlock(id, 'suggest', ITEMS, { result: 'Shown 1 suggestion to the user' })
const settledRead = (id = 'r1'): ReturnType<typeof toolBlock> =>
  toolBlock(id, 'read', { path: 'a.txt' }, { result: 'contents' })

function show(msgs: AssistantMessage[], isStreaming?: boolean): void {
  act(() =>
    root.render(
      createElement(AssistantBubble, {
        msgs,
        ...(isStreaming === undefined ? {} : { isStreaming })
      })
    )
  )
}

function stream(patch: Partial<SessionStreamState>): void {
  act(() =>
    useChatStore.setState((s) => ({
      sessionStreams: {
        ...s.sessionStreams,
        [SID]: { ...(s.sessionStreams[SID] ?? emptyStream(true)), ...patch }
      }
    }))
  )
}

/** 直接挂在内容列下的 markdown 容器 = 正文段（过程区的中间文本包在 `.space-y-0.5` 里） */
const answerBodies = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('.min-w-0 > .markdown-body')
]
const answerTexts = (): string[] => answerBodies().map((el) => el.textContent ?? '')
/** 过程区里画成 markdown 的中间文本 */
const processTexts = (): string[] =>
  [...container.querySelectorAll('.space-y-0\\.5 .markdown-body')].map((el) => el.textContent ?? '')
const source = (): HTMLElement | null => container.querySelector<HTMLElement>('pre.code-surface')
const action = (title: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-message-actions] button[title="${title}"]`)
const click = (el: HTMLElement | null): void => {
  expect(el).not.toBeNull()
  act(() => el!.click())
}
const parsesOf = (md: string): number => probe.parses.filter((p) => p === md).length

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  resetStore(SID)
  probe.parses.length = 0
  probe.messageIds.clear()
  probe.copied.length = 0
  probe.spoken.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('答复跨过 suggest', () => {
  const reply = (): AssistantMessage[] => [
    assistant('a1', [text(LONG), settledSuggest()]),
    assistant('a2', [text(TAIL)])
  ]

  it('SA-1 两段都是正文，在提议卡片之前；过程区没有文字', () => {
    show(reply())
    expect(answerTexts()).toEqual([LONG, TAIL])
    expect(processTexts()).toEqual([])
    const card = container.querySelector('[data-suggestions]')
    expect(card).not.toBeNull()
    const [, tail] = answerBodies()
    expect(tail!.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('SA-2 显示源码是整段，切回来还是两段', () => {
    show(reply())
    click(action(en.message.showSource))
    expect(source()?.textContent).toBe(`${LONG}\n\n${TAIL}`)
    expect(container.querySelectorAll('pre.code-surface')).toHaveLength(1)
    expect(answerBodies()).toHaveLength(0)
    click(action(en.message.showRendered))
    expect(source()).toBeNull()
    expect(answerTexts()).toEqual([LONG, TAIL])
  })

  it('SA-3 复制、朗读拿到同一份整段', () => {
    show(reply())
    click(action(en.message.copy))
    expect(probe.copied).toEqual([`${LONG}\n\n${TAIL}`])
    click(action(en.message.playTts))
    expect(probe.spoken).toEqual([`${LONG}\n\n${TAIL}`])
  })

  it('SA-4 收尾是空的：长回复还是正文，按钮都在', () => {
    show([assistant('a1', [text(LONG), settledSuggest()]), assistant('a2', [])])
    expect(answerTexts()).toEqual([LONG])
    expect(answerBodies()[0]!.className).not.toContain('mb-2.5')
    click(action(en.message.copy))
    expect(probe.copied).toEqual([LONG])
    click(action(en.message.showSource))
    expect(source()?.textContent).toBe(LONG)
  })

  it('SA-5 卡停在 suggest 这条（中止）：同样算正文', () => {
    show([assistant('a1', [text(LONG), settledSuggest()])])
    expect(answerTexts()).toEqual([LONG])
    expect(processTexts()).toEqual([])
    click(action(en.message.showSource))
    expect(source()?.textContent).toBe(LONG)
  })

  it('SA-6 多次 suggest：三段依次都在', () => {
    show([
      assistant('a1', [text('one'), settledSuggest('c1')]),
      assistant('a2', [text('two'), settledSuggest('c2')]),
      assistant('a3', [text('three')])
    ])
    expect(answerTexts()).toEqual(['one', 'two', 'three'])
    click(action(en.message.showSource))
    expect(source()?.textContent).toBe('one\n\ntwo\n\nthree')
  })

  it('SA-7 只有空白文字的那条不留空段', () => {
    show([assistant('a1', [text(' \n '), settledSuggest()]), assistant('a2', [text(TAIL)])])
    expect(answerTexts()).toEqual([TAIL])
    click(action(en.message.showSource))
    expect(source()?.textContent).toBe(TAIL)
  })

  it('SA-8 思考留在过程区，文字去正文', () => {
    show([
      assistant('a1', [thinking('hmm'), text(LONG), settledSuggest()]),
      assistant('a2', [text(TAIL)])
    ])
    expect(container.querySelector('[data-group-count]')?.textContent).toBe('2')
    expect(processTexts()).toEqual([])
    expect(answerTexts()).toEqual([LONG, TAIL])
  })

  it.each([
    ['还在执行', {}, 'running'],
    ['出错', { result: 'bad args', isError: true }, 'error']
  ])('SA-9 %s的 suggest：工具行在过程区，文字仍是正文', (_label, extra, status) => {
    show([
      assistant('a1', [text(LONG), toolBlock('c1', 'suggest', ITEMS, extra)]),
      assistant('a2', [text(TAIL)])
    ])
    expect(answerTexts()).toEqual([LONG, TAIL])
    expect(container.querySelector(`[data-tool-status="${status}"]`)).not.toBeNull()
    expect(container.querySelector('[data-suggestions]')).toBeNull()
  })

  it('SA-16 落定的 suggest 既有工具行也有卡片', () => {
    show(reply())
    const row = container.querySelector('[data-tool-name="suggest"]')
    const cards = container.querySelector('[data-suggestions]')
    expect(row?.getAttribute('data-tool-status')).toBe('done')
    expect(cards).not.toBeNull()
    const [firstAnswer] = answerBodies()
    expect(
      row!.compareDocumentPosition(firstAnswer!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      firstAnswer!.compareDocumentPosition(cards!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('SA-10 每段的引用块按它自己那条回复取版本', () => {
    show(reply())
    expect(probe.messageIds.get(LONG)).toBe('a1')
    expect(probe.messageIds.get(TAIL)).toBe('a2')
  })

  it('SA-11 流式接在先前的回复后面，不重新解析它，落定后节点不换', () => {
    const first = assistant('a1', [text(LONG), settledSuggest()])
    show([first, streamingPlaceholder(SID)], true)
    expect(answerTexts()).toEqual([LONG])

    stream({ content: 'The' })
    stream({ content: 'The last' })
    stream({ content: TAIL })
    expect(answerTexts()).toEqual([LONG, TAIL])
    expect(parsesOf(LONG)).toBe(1)
    const [leadNode, tailNode] = answerBodies()
    expect(leadNode!.querySelector('span.animate-pulse')).toBeNull()
    expect(tailNode!.querySelector('span.animate-pulse')).not.toBeNull()
    expect(container.querySelector('[data-message-actions]')).toBeNull()

    // 落定：同一次提交清空流式正文、换成真消息
    act(() => {
      useChatStore.setState((s) => ({
        sessionStreams: { ...s.sessionStreams, [SID]: emptyStream(false) }
      }))
      root.render(createElement(AssistantBubble, { msgs: [first, assistant('a2', [text(TAIL)])] }))
    })
    expect(answerTexts()).toEqual([LONG, TAIL])
    expect(answerBodies()[0]).toBe(leadNode)
    expect(answerBodies()[1]).toBe(tailNode)
    expect(parsesOf(LONG)).toBe(1)
    click(action(en.message.showSource))
    expect(source()?.textContent).toBe(`${LONG}\n\n${TAIL}`)
  })
})

describe('对照：不是答复的文字留在过程区', () => {
  const onlyTail = (): void => {
    expect(answerTexts()).toEqual([TAIL])
    click(action(en.message.showSource))
    expect(source()?.textContent).toBe(TAIL)
  }

  it('SA-12 同一条消息里 suggest 旁边还有别的工具调用', () => {
    show([
      assistant('a1', [text(LONG), settledRead(), settledSuggest()]),
      assistant('a2', [text(TAIL)])
    ])
    expect(processTexts()).toEqual([LONG])
    onlyTail()
  })

  it('SA-13 suggest 之后又干了活', () => {
    show([
      assistant('a1', [text(LONG), settledSuggest()]),
      assistant('a2', [settledRead()]),
      assistant('a3', [text(TAIL)])
    ])
    expect(processTexts()).toEqual([LONG])
    onlyTail()
  })

  it('SA-14 没有 suggest 的普通中间文本', () => {
    show([assistant('a1', [text(LONG), settledRead()]), assistant('a2', [text(TAIL)])])
    expect(processTexts()).toEqual([LONG])
    onlyTail()
  })

  it('SA-15 流式中途下一步是别的工具：那段文字回到过程区', () => {
    const first = assistant('a1', [text(LONG), settledSuggest()])
    show([first, streamingPlaceholder(SID)], true)
    expect(answerTexts()).toEqual([LONG])
    show(
      [
        first,
        assistant('a2', [toolBlock('r1', 'read', { path: 'a.txt' })]),
        streamingPlaceholder(SID)
      ],
      true
    )
    expect(answerTexts()).toEqual([])
    expect(processTexts()).toEqual([LONG])
  })
})
