// @vitest-environment jsdom
/**
 * 手机布局会话列表的摘要（jsdom）：
 *
 * `sessionPreviewText(messages)` —— 一条会话的摘要文字：
 *   PT-1..5   取哪一条：最后那张有字的助手卡片 → 最后一条有字的用户消息 → null；system_notify 从不取
 *   PT-6..12  压成一行：围栏整块去掉（没闭合的算到末尾）、图片去掉、链接只留字、记号去掉、空白折叠
 *   PT-13/14  160 个字符的上限，压完再截；按码点截（表情不切半）
 *   PT-15     最后一张回复只有围栏 / 图片时往前找
 *   PT-16     记号只在它是记号的位置去掉（词中间的下划线、`2*3`、`C#` 留着）
 *   PT-17     content 不是字符串的消息跳过
 *   PT-18     系统写的用户消息（通知、指令注入）与压缩摘要从不取
 *
 * `useSessionPreviews(sessions, stamps, enabled)` —— 会话 id → 摘要：
 *   PH-1..5   开关、每条一次、读到之前不在表里、只取前 30 条、同值重渲染不再取
 *   PH-6      戳变了才重取，重取期间留着上一份
 *   PH-7/8    取失败：第一次是 null，重取失败留着上一份
 *   PH-9..11  缺戳当空串、开关来回、后来排进前 30 的再取
 *   PH-12     失败的那一条不记账，下一次有动静时重取；成功的不重取
 *   PH-13     晚到的旧响应不盖住新的
 *
 * `sessionPendingQuestion(messages)` —— 此刻还没答的那个选择题（最后一条消息是助手消息、里面有没结果的 `ask` 调用）：
 *   PQ-1..4   没有消息 / 有 → 问题那一句 / 答过了 / 最后一条是用户消息
 *   PQ-5/6    问题不是字符串、没有 args；没有 blocks、别的工具、别的块
 *   PQ-7      与摘要同一种压法，160 个码点的上限
 *   PQ-8/9    几个 ask 块取第一个还没答的；只看最后一条消息；空问题跳过
 *
 * `useSessionDigests(sessions, stamps, enabled)` —— 会话 id → `{ text, question }`：
 *   PD-1..4   摘要与问题一起回来；没有问题是 null；取失败是两个 null；读到之前不在表里；与 useSessionPreviews 同一份摘要
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ChatMessage, Session } from '@shuvix/chat-ui'

const list = vi.fn<(id: string) => Promise<ChatMessage[]>>()

vi.mock('@shuvix/chat-ui', () => ({
  getChatApi: () => ({ message: { list: (id: string) => list(id) } })
}))

import {
  sessionPendingQuestion,
  sessionPreviewText,
  useSessionDigests,
  useSessionPreviews,
  type SessionDigest
} from './useSessionPreviews'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Role = 'user' | 'assistant' | 'system_notify'

let seq = 0
function msg(role: Role, content: unknown, metadata?: Record<string, unknown>): ChatMessage {
  return { id: `m${++seq}`, role, content, metadata } as unknown as ChatMessage
}
const user = (content: unknown, metadata?: Record<string, unknown>): ChatMessage =>
  msg('user', content, metadata)
const assistant = (content: unknown, metadata?: Record<string, unknown>): ChatMessage =>
  msg('assistant', content, metadata)
const one = (content: string): string | null => sessionPreviewText([assistant(content)])

describe('sessionPreviewText: which message', () => {
  it('PT-1 no messages → null', () => {
    expect(sessionPreviewText([])).toBeNull()
  })

  it('PT-2 the last assistant message with text wins over later user messages', () => {
    expect(sessionPreviewText([user('q1'), assistant('a1'), user('q2')])).toBe('a1')
  })

  it('PT-3 assistant messages with empty or whitespace-only content are skipped', () => {
    expect(sessionPreviewText([assistant('early'), assistant(''), assistant('  \n')])).toBe('early')
  })

  it('PT-4 no assistant text → the last user message with text', () => {
    expect(sessionPreviewText([user('q1'), user('q2'), assistant('')])).toBe('q2')
  })

  it('PT-5 system_notify messages are never picked, even when last', () => {
    expect(sessionPreviewText([msg('system_notify', 'note')])).toBeNull()
    expect(sessionPreviewText([user('q'), msg('system_notify', 'note')])).toBe('q')
    expect(sessionPreviewText([assistant('a'), msg('system_notify', 'note')])).toBe('a')
  })

  it('PT-15 a last reply that is only a fence or only an image falls back to an earlier reply', () => {
    expect(sessionPreviewText([assistant('earlier'), assistant('```ts\nconst a = 1\n```')])).toBe(
      'earlier'
    )
    expect(sessionPreviewText([assistant('earlier'), assistant('![shot](https://x/y.png)')])).toBe(
      'earlier'
    )
  })

  it('PT-15 no assistant message has text after stripping → the last user message with text', () => {
    expect(
      sessionPreviewText([user('q1'), assistant('```\ncode\n```'), assistant('![a](b)'), user('')])
    ).toBe('q1')
  })

  it('PT-15 nothing has text after stripping → null', () => {
    expect(sessionPreviewText([user('```\nx\n```'), assistant('![a](b)')])).toBeNull()
  })

  it('PT-17 a message whose content is not a string is skipped without throwing', () => {
    expect(sessionPreviewText([assistant('early'), assistant(undefined)])).toBe('early')
    expect(sessionPreviewText([user('q'), assistant(undefined), user(undefined)])).toBe('q')
    expect(sessionPreviewText([assistant(undefined)])).toBeNull()
  })

  it.each<[string, Record<string, unknown>]>([
    ['a system notice', { isSystemNotice: true }],
    ['an instruction injection', { isInstructionInjection: true }]
  ])('PT-18 a user message that is %s is never picked', (_label, metadata) => {
    expect(sessionPreviewText([user('real question'), user('<background-task …>', metadata)])).toBe(
      'real question'
    )
    expect(sessionPreviewText([user('<background-task …>', metadata)])).toBeNull()
  })

  it('PT-18 a compaction summary is never picked', () => {
    expect(
      sessionPreviewText([
        assistant('real reply'),
        assistant('summary of the past', { isCompactionSummary: true })
      ])
    ).toBe('real reply')
    expect(
      sessionPreviewText([assistant('summary of the past', { isCompactionSummary: true })])
    ).toBeNull()
    expect(
      sessionPreviewText([user('q'), user('summary of the past', { isCompactionSummary: true })])
    ).toBe('q')
  })
})

describe('sessionPreviewText: one line of plain text', () => {
  it('PT-6 a closed fence is removed whole', () => {
    expect(one('Before\n```ts\nconst a = 1\n```\nafter')).toBe('Before after')
  })

  it('PT-7 an unclosed fence is removed to the end', () => {
    expect(one('Intro\n```py\nprint(1)')).toBe('Intro')
  })

  it('PT-8 two fences with text between them', () => {
    expect(one('a ```x``` b ```y``` c')).toBe('a b c')
  })

  it('PT-9 an image is removed', () => {
    expect(one('See ![alt text](https://x/y.png) here')).toBe('See here')
  })

  it('PT-10 a link is reduced to its text', () => {
    expect(one('Read [the docs](https://x) now')).toBe('Read the docs now')
  })

  it('PT-11 markdown marks are removed', () => {
    expect(one('# Title\n**bold** and `code`\n> quote | cell')).toBe(
      'Title bold and code quote cell'
    )
  })

  it('PT-12 whitespace is collapsed and trimmed', () => {
    expect(one('  a\n\n\tb   c  ')).toBe('a b c')
  })

  it('PT-16 an underscore inside a word stays', () => {
    expect(one('edit my_file.py')).toBe('edit my_file.py')
  })

  it('PT-16 marks that are not marks stay: a word underscore, a lone star, a trailing #', () => {
    expect(one('edit my_file.py and 2*3 in C#')).toBe('edit my_file.py and 2*3 in C#')
  })

  it('PT-16 emphasis pairs are removed next to CJK text', () => {
    expect(one('**完成**了，结果是*好的*')).toBe('完成了，结果是好的')
  })

  it('PT-16 an underscore pair is emphasis only when it is not inside a word', () => {
    expect(one('snake_case_name and _x_')).toBe('snake_case_name and x')
  })
})

describe('sessionPreviewText: the 160 cap', () => {
  it('PT-13 200 characters → exactly 160; 160 unchanged; 161 → 160', () => {
    expect(one('x'.repeat(200))).toBe('x'.repeat(160))
    expect(one('x'.repeat(160))).toBe('x'.repeat(160))
    expect(one('x'.repeat(161))).toBe('x'.repeat(160))
  })

  it('PT-14 the cap applies after stripping', () => {
    const raw = `${'a'.repeat(100)}\n\`\`\`\n${'b'.repeat(500)}\n\`\`\`\n${'c'.repeat(100)}`
    expect(one(raw)).toBe(`${'a'.repeat(100)} ${'c'.repeat(59)}`)
  })

  it('PT-13 the cap counts code points, so an emoji is never cut in half', () => {
    const result = one(`${'a'.repeat(159)}😀😀`)!
    expect(Array.from(result)).toHaveLength(160)
    expect(result).toBe(`${'a'.repeat(159)}😀`)
    expect(result.endsWith('😀')).toBe(true)
  })
})

// ── the hook ────────────────────────────────────────────────────────────────────────────────

interface Deferred {
  resolve: (messages: ChatMessage[]) => void
  reject: (error: Error) => void
  promise: Promise<ChatMessage[]>
}
function deferred(): Deferred {
  let resolve!: (messages: ChatMessage[]) => void
  let reject!: (error: Error) => void
  const promise = new Promise<ChatMessage[]>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { resolve, reject, promise }
}

let container: HTMLDivElement
let root: Root
let previews: Record<string, string | null> = {}

/** 探针：把 hook 这一次渲染交回的表交给 `report`（渲染里不能直接改外面的变量） */
function Probe(props: {
  sessions: Session[]
  stamps: Record<string, string>
  enabled: boolean
  report: (value: Record<string, string | null>) => void
}): null {
  const value = useSessionPreviews(props.sessions, props.stamps, props.enabled)
  props.report(value)
  return null
}
const report = (value: Record<string, string | null>): void => {
  previews = value
}

const sessionsOf = (...ids: string[]): Session[] => ids.map((id) => ({ id }) as unknown as Session)

/** 每次都是新的 sessions / stamps 对象（同值不同身份） */
function render(ids: string[], stamps: Record<string, string>, enabled = true): void {
  act(() =>
    root.render(
      createElement(Probe, {
        sessions: sessionsOf(...ids),
        stamps: { ...stamps },
        enabled,
        report
      })
    )
  )
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const calledIds = (): string[] => list.mock.calls.map(([id]) => id)

beforeEach(() => {
  list.mockReset()
  list.mockImplementation(async () => [])
  previews = {}
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useSessionPreviews', () => {
  it('PH-1 disabled: nothing is fetched and the map is empty', async () => {
    render(['a', 'b'], { a: '1', b: '1' }, false)
    await flush()
    expect(list).not.toHaveBeenCalled()
    expect(previews).toEqual({})
  })

  it('PH-2 one fetch per session; a session without text is null', async () => {
    list.mockImplementation(async (id) => (id === 'a' ? [assistant('text')] : [assistant('')]))
    render(['a', 'b'], { a: '1', b: '1' })
    await flush()
    expect(calledIds()).toEqual(['a', 'b'])
    expect(previews).toEqual({ a: 'text', b: null })
  })

  it('PH-3 an id is absent from the map until its fetch resolves', async () => {
    const pending = deferred()
    list.mockImplementation(() => pending.promise)
    render(['a'], { a: '1' })
    await flush()
    expect('a' in previews).toBe(false)
    await act(async () => pending.resolve([assistant('done')]))
    expect(previews).toEqual({ a: 'done' })
  })

  it('PH-4 only the first 30 sessions are fetched, in order', async () => {
    const ids = Array.from({ length: 35 }, (_, i) => `s${i}`)
    render(ids, {})
    await flush()
    expect(calledIds()).toEqual(ids.slice(0, 30))
  })

  it('PH-5 a re-render with new object identities but equal values fetches nothing more', async () => {
    list.mockImplementation(async () => [assistant('text')])
    render(['a', 'b'], { a: '1', b: '1' })
    await flush()
    render(['a', 'b'], { a: '1', b: '1' })
    await flush()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('PH-6 a changed stamp refetches that session only, keeping the old preview meanwhile', async () => {
    list.mockImplementation(async (id) => [assistant(`old ${id}`)])
    render(['a', 'b'], { a: '1', b: '1' })
    await flush()
    expect(previews).toEqual({ a: 'old a', b: 'old b' })

    const pending = deferred()
    list.mockClear()
    list.mockImplementation(() => pending.promise)
    render(['a', 'b'], { a: '2', b: '1' })
    await flush()
    expect(calledIds()).toEqual(['a'])
    expect(previews).toEqual({ a: 'old a', b: 'old b' })

    await act(async () => pending.resolve([assistant('new a')]))
    expect(previews).toEqual({ a: 'new a', b: 'old b' })
  })

  it('PH-7 a first fetch that rejects leaves the id present with null', async () => {
    list.mockImplementation(async () => {
      throw new Error('disconnected')
    })
    render(['a'], { a: '1' })
    await flush()
    expect('a' in previews).toBe(true)
    expect(previews.a).toBeNull()
  })

  it('PH-8 a refetch that rejects keeps the previous preview', async () => {
    list.mockImplementation(async () => [assistant('kept')])
    render(['a'], { a: '1' })
    await flush()
    list.mockImplementation(async () => {
      throw new Error('disconnected')
    })
    render(['a'], { a: '2' })
    await flush()
    expect(list).toHaveBeenCalledTimes(2)
    expect(previews).toEqual({ a: 'kept' })
  })

  it('PH-9 a missing stamp counts as an empty one: fetched once, not again', async () => {
    list.mockImplementation(async () => [assistant('text')])
    render(['a'], {})
    await flush()
    render(['a'], {})
    await flush()
    render(['a'], { a: '' })
    await flush()
    expect(list).toHaveBeenCalledTimes(1)
    expect(previews).toEqual({ a: 'text' })
  })

  it('PH-10 enabling fetches; disabling and re-enabling with the same stamps does not', async () => {
    list.mockImplementation(async () => [assistant('text')])
    render(['a'], { a: '1' }, false)
    await flush()
    expect(list).not.toHaveBeenCalled()

    render(['a'], { a: '1' }, true)
    await flush()
    expect(list).toHaveBeenCalledTimes(1)
    expect(previews).toEqual({ a: 'text' })

    render(['a'], { a: '1' }, false)
    await flush()
    // 关着的时候摘要还在
    expect(previews).toEqual({ a: 'text' })

    render(['a'], { a: '1' }, true)
    await flush()
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('PH-11 a session that moves into the first 30 later is fetched then; the others are not refetched', async () => {
    const ids = Array.from({ length: 31 }, (_, i) => `s${i}`)
    render(ids, {})
    await flush()
    expect(calledIds()).not.toContain('s30')
    expect(list).toHaveBeenCalledTimes(30)

    render(['s30', ...ids.slice(0, 30)], {})
    await flush()
    expect(list).toHaveBeenCalledTimes(31)
    expect(calledIds()[30]).toBe('s30')
  })

  it('PH-12 a failed fetch is forgotten: the next change of the list fetches that id again', async () => {
    list.mockImplementation(async (id) => {
      if (id === 'bad') throw new Error('disconnected')
      return [assistant('fine')]
    })
    render(['ok', 'bad'], { ok: '1', bad: '1' })
    await flush()
    expect(calledIds()).toEqual(['ok', 'bad'])
    expect(previews).toEqual({ ok: 'fine', bad: null })

    list.mockImplementation(async () => [assistant('back')])
    render(['ok', 'bad'], { ok: '1', bad: '1' })
    await flush()
    // 成功的那条不重取，失败的那条重取
    expect(calledIds()).toEqual(['ok', 'bad', 'bad'])
    expect(previews).toEqual({ ok: 'fine', bad: 'back' })
  })

  it('PH-13 an older fetch that resolves late does not overwrite the newer one', async () => {
    const first = deferred()
    const second = deferred()
    list.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    render(['a'], { a: 's1' })
    await flush()
    render(['a'], { a: 's2' })
    await flush()
    expect(list).toHaveBeenCalledTimes(2)

    await act(async () => second.resolve([assistant('new')]))
    expect(previews).toEqual({ a: 'new' })
    await act(async () => first.resolve([assistant('old')]))
    expect(previews).toEqual({ a: 'new' })
  })

  it('PH-13 an older fetch that rejects late does not touch the newer value', async () => {
    const first = deferred()
    const second = deferred()
    list.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    render(['a'], { a: 's1' })
    await flush()
    render(['a'], { a: 's2' })
    await flush()

    await act(async () => second.resolve([assistant('new')]))
    await act(async () => first.reject(new Error('disconnected')))
    await flush()
    expect(previews).toEqual({ a: 'new' })

    // 旧的那次失败也没有把新的那次的账抹掉：同值重渲染不再取
    render(['a'], { a: 's2' })
    await flush()
    expect(list).toHaveBeenCalledTimes(2)
  })
})

// ── the pending question ────────────────────────────────────────────────────────────────────

interface AskBlock {
  type: string
  toolCallId?: string
  toolName?: string
  args?: Record<string, unknown>
  result?: string
  content?: string
}
const ask = (question: unknown, over: Partial<AskBlock> = {}): AskBlock => ({
  type: 'tool',
  toolCallId: `c${++seq}`,
  toolName: 'ask',
  args: { question },
  ...over
})
const withBlocks = (blocks: AskBlock[] | undefined, content = ''): ChatMessage =>
  ({ id: `m${++seq}`, role: 'assistant', content, blocks }) as unknown as ChatMessage

describe('sessionPendingQuestion', () => {
  it('PQ-1 no messages → null', () => {
    expect(sessionPendingQuestion([])).toBeNull()
  })

  it('PQ-2 an unanswered ask block in the last assistant message → its question', () => {
    expect(sessionPendingQuestion([user('go'), withBlocks([ask('Which branch?')])])).toBe(
      'Which branch?'
    )
  })

  it('PQ-3 an answered ask block → null', () => {
    expect(
      sessionPendingQuestion([withBlocks([ask('Which branch?', { result: 'main' })])])
    ).toBeNull()
  })

  it('PQ-3 any result counts as answered, even an empty one', () => {
    expect(sessionPendingQuestion([withBlocks([ask('Which branch?', { result: '' })])])).toBeNull()
  })

  it('PQ-4 the last message is a user message → null', () => {
    expect(
      sessionPendingQuestion([withBlocks([ask('Which branch?')]), user('use main')])
    ).toBeNull()
  })

  it('PQ-4 the last message is not an assistant message → null', () => {
    expect(
      sessionPendingQuestion([withBlocks([ask('Which branch?')]), msg('system_notify', 'note')])
    ).toBeNull()
  })

  it.each<[string, AskBlock]>([
    ['a number', ask(42)],
    ['an object', ask({ text: 'Which?' })],
    ['missing', ask(undefined)],
    ['no args at all', { type: 'tool', toolName: 'ask' }]
  ])('PQ-5 a question that is %s → null', (_label, block) => {
    expect(sessionPendingQuestion([withBlocks([block])])).toBeNull()
  })

  it('PQ-6 no blocks, an empty block list, other block kinds, other tools → null', () => {
    expect(sessionPendingQuestion([assistant('just text')])).toBeNull()
    expect(sessionPendingQuestion([withBlocks(undefined, 'just text')])).toBeNull()
    expect(sessionPendingQuestion([withBlocks([])])).toBeNull()
    expect(
      sessionPendingQuestion([
        withBlocks([
          { type: 'text', content: 'Which branch?' },
          { type: 'thinking', content: 'hm' }
        ])
      ])
    ).toBeNull()
    expect(
      sessionPendingQuestion([
        withBlocks([{ type: 'tool', toolName: 'bash', args: { question: 'Which branch?' } }])
      ])
    ).toBeNull()
  })

  it('PQ-7 the question is flattened like the preview text', () => {
    expect(
      sessionPendingQuestion([withBlocks([ask('**Which** `branch`\n\n  should I use?')])])
    ).toBe('Which branch should I use?')
  })

  it('PQ-7 the question is capped at 160 code points', () => {
    expect(sessionPendingQuestion([withBlocks([ask('q'.repeat(200))])])).toBe('q'.repeat(160))
    const result = sessionPendingQuestion([withBlocks([ask(`${'a'.repeat(159)}😀😀`)])])!
    expect(Array.from(result)).toHaveLength(160)
    expect(result.endsWith('😀')).toBe(true)
  })

  it('PQ-8 with several ask blocks the first unanswered one with a question is taken', () => {
    expect(
      sessionPendingQuestion([
        withBlocks([ask('First?', { result: 'yes' }), ask('Second?'), ask('Third?')])
      ])
    ).toBe('Second?')
    expect(sessionPendingQuestion([withBlocks([ask(7), ask('Second?')])])).toBe('Second?')
  })

  it('PQ-9 a question with no text after flattening is skipped', () => {
    expect(sessionPendingQuestion([withBlocks([ask('   \n ')])])).toBeNull()
    expect(sessionPendingQuestion([withBlocks([ask('```\ncode\n```'), ask('Real one?')])])).toBe(
      'Real one?'
    )
  })

  it('PQ-9 only the last message is looked at', () => {
    expect(
      sessionPendingQuestion([withBlocks([ask('Earlier?')]), assistant('a later reply')])
    ).toBeNull()
  })
})

// ── the digest hook ─────────────────────────────────────────────────────────────────────────

describe('useSessionDigests', () => {
  let digests: Record<string, SessionDigest> = {}
  let texts: Record<string, string | null> = {}
  const reportDigests = (value: Record<string, SessionDigest>): void => {
    digests = value
  }
  const reportTexts = (value: Record<string, string | null>): void => {
    texts = value
  }
  function DigestProbe(props: {
    sessions: Session[]
    stamps: Record<string, string>
    report: (value: Record<string, SessionDigest>) => void
  }): null {
    const value = useSessionDigests(props.sessions, props.stamps, true)
    props.report(value)
    return null
  }
  function renderDigests(ids: string[], stamps: Record<string, string>): void {
    act(() =>
      root.render(
        createElement(DigestProbe, {
          sessions: sessionsOf(...ids),
          stamps: { ...stamps },
          report: reportDigests
        })
      )
    )
  }

  beforeEach(() => {
    digests = {}
    texts = {}
  })

  it('PD-1 a session waiting on a question: its last text and the question', async () => {
    list.mockImplementation(async () => [
      user('go'),
      withBlocks([ask('Which **branch**?')], 'Let me check with you.')
    ])
    renderDigests(['a'], { a: '1' })
    await flush()
    expect(digests).toEqual({ a: { text: 'Let me check with you.', question: 'Which branch?' } })
  })

  it('PD-2 no pending question → question null; no text either → both null', async () => {
    list.mockImplementation(async (id) => (id === 'a' ? [user('q'), assistant('answer')] : []))
    renderDigests(['a', 'b'], { a: '1', b: '1' })
    await flush()
    expect(digests).toEqual({
      a: { text: 'answer', question: null },
      b: { text: null, question: null }
    })
  })

  it('PD-3 a fetch that fails → both null; absent until it settles', async () => {
    const pending = deferred()
    list.mockImplementation(() => pending.promise)
    renderDigests(['a'], { a: '1' })
    await flush()
    expect('a' in digests).toBe(false)

    await act(async () => pending.reject(new Error('disconnected')))
    await flush()
    expect(digests).toEqual({ a: { text: null, question: null } })
  })

  it('PD-3 a refetch that fails keeps the previous digest', async () => {
    list.mockImplementation(async () => [withBlocks([ask('Which?')], 'kept')])
    renderDigests(['a'], { a: '1' })
    await flush()
    list.mockImplementation(async () => {
      throw new Error('disconnected')
    })
    renderDigests(['a'], { a: '2' })
    await flush()
    expect(list).toHaveBeenCalledTimes(2)
    expect(digests).toEqual({ a: { text: 'kept', question: 'Which?' } })
  })

  it('PD-4 useSessionPreviews gives the same text, without the question', async () => {
    list.mockImplementation(async () => [withBlocks([ask('Which?')], 'the reply')])
    act(() =>
      root.render(
        createElement(Probe, {
          sessions: sessionsOf('a'),
          stamps: { a: '1' },
          enabled: true,
          report: reportTexts
        })
      )
    )
    await flush()
    expect(texts).toEqual({ a: 'the reply' })
  })
})
