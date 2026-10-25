/**
 * 提议（`suggest` 工具，2026-10-25）的状态规则 —— `suggestions.ts`。不另存状态：一组提议开着、采纳了哪一条、关了，
 * 全从会话消息本身读出；chat-ui 画卡片与主进程 `suggestion:accept` 的核对共用这一份判断。
 *
 *   SG-1 `suggestionsOf`：不是对象 / 没有 suggestions / 不是数组 → []；坏项在原下标留 undefined 空位（下标是采纳时的
 *        身份）；空白 detail 丢掉、合法 detail 留下；只拷三个认得的字段
 *   SG-2 `isSettledSuggestBlock`：落定的 suggest 调用为真；还在执行（没有 result）、出错、别的工具、不是工具块为假
 *   SG-3 落定的调用是 open；之后用户说的下一句话关掉此前所有开着的组（同一条消息里两次调用、跨消息的调用都算）；
 *        之后新出现的组不受前一句话影响
 *   SG-4 系统通知 / 指令注入的 user 消息什么都不关；错误行（system_notify）被忽略；还在执行 / 出错的调用不是组
 *   SG-5 带 `origin.suggestion` 的用户消息：指着一个开着的组 → 那组 accepted（带下标），其余开着的 closed；
 *        指着不存在的 / 已经关了的组 → 只把开着的关掉，关了的那组不会变成 accepted
 *   SG-6 两条助手消息里同一个 toolCallId（`call_0`）→ 两个独立的组，按消息 id 区分
 *   SG-7 `suggestionToAccept`：not-found（未知消息 id / 指向用户消息 / toolCallId 不对 / 还在执行 / 出错 / 下标越界 /
 *        下标是空位）；closed（之后用户说了别的 / 已采纳过）；否则 ok，交回的是工具参数里那条的 message（原样）
 */
import { describe, expect, it } from 'vitest'
import {
  SUGGEST_TOOL_NAME,
  isSettledSuggestBlock,
  suggestionGroupKey,
  suggestionStatesOf,
  suggestionToAccept,
  suggestionsOf,
  type SuggestionGroupState
} from './suggestions'
import type {
  AssistantBlock,
  AssistantMessage,
  AssistantToolBlock,
  ChatMessage,
  ErrorEventMessage,
  UserTextMessage,
  UserTextMeta
} from './types/chatMessage'
import type { InputOrigin, SuggestionRef } from './types/inputOrigin'

// ─── 夹具 ───────────────────────────────────────────────

const SID = 's1'

function user(id: string, content: string, metadata: UserTextMeta | null = null): UserTextMessage {
  return {
    id,
    sessionId: SID,
    role: 'user',
    type: 'text',
    content,
    model: '',
    createdAt: 0,
    metadata
  }
}

function assistant(id: string, blocks: AssistantBlock[]): AssistantMessage {
  return {
    id,
    sessionId: SID,
    role: 'assistant',
    type: 'message',
    content: '',
    model: 'm',
    createdAt: 0,
    blocks,
    metadata: null
  }
}

function errorRow(id: string): ErrorEventMessage {
  return {
    id,
    sessionId: SID,
    role: 'system_notify',
    type: 'error_event',
    content: 'boom',
    model: '',
    createdAt: 0,
    metadata: null
  }
}

const ITEMS = [
  {
    title: 'Add tests',
    message: 'Yes, also add tests for the parser',
    detail: 'The parser has none'
  },
  { title: 'Update docs', message: 'Please update the README too' },
  { title: 'Ship it', message: 'Go ahead and open the PR' }
]

/** 一次落定的 suggest 调用（结果是工具的文字结果） */
function suggestCall(
  toolCallId: string,
  suggestions: unknown = ITEMS,
  extra: Partial<AssistantToolBlock> = {}
): AssistantToolBlock {
  return {
    type: 'tool',
    toolCallId,
    toolName: SUGGEST_TOOL_NAME,
    args: { suggestions },
    result: 'Shown 3 suggestions to the user',
    ...extra
  }
}

/** 采纳某一条发出的用户消息（来源是本机窗口 + 提议引用） */
function accepted(id: string, ref: SuggestionRef, content = 'accepted'): UserTextMessage {
  const origin: InputOrigin = { kind: 'local', suggestion: ref }
  return user(id, content, { origin })
}

const key = suggestionGroupKey
const OPEN: SuggestionGroupState = { status: 'open' }
const CLOSED: SuggestionGroupState = { status: 'closed' }

// ─── SG-1 ───────────────────────────────────────────────

describe('SG-1 · suggestionsOf', () => {
  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['字符串', 'suggestions'],
    ['数字', 3],
    ['没有 suggestions 键', {}],
    ['suggestions 是对象', { suggestions: { title: 'x', message: 'y' } }],
    ['suggestions 是字符串', { suggestions: 'title' }],
    ['suggestions 是 null', { suggestions: null }]
  ])('SG-1 %s → []', (_label, args) => {
    expect(suggestionsOf(args)).toStrictEqual([])
  })

  it('SG-1 合法项原样拷出三个字段；多出来的键丢掉；交回的是新对象', () => {
    const raw = { title: 'T', message: 'M', detail: 'D', action: 'host:delete', extra: 1 }
    const [item] = suggestionsOf({ suggestions: [raw] })
    expect(item).toStrictEqual({ title: 'T', message: 'M', detail: 'D' })
    expect(item).not.toBe(raw)
  })

  it.each<[string, unknown]>([
    ['detail 空串', ''],
    ['detail 只有空白', '   \n'],
    ['detail 是数字', 7],
    ['detail 缺省', undefined]
  ])('SG-1 %s → 丢掉 detail 键，这一条照留', (_label, detail) => {
    const [item] = suggestionsOf({ suggestions: [{ title: 'T', message: 'M', detail }] })
    expect(item).toStrictEqual({ title: 'T', message: 'M' })
    expect(item).not.toHaveProperty('detail')
  })

  it('SG-1 坏项在原下标留 undefined 空位，好项的下标不挪', () => {
    const list = [
      { title: 'first', message: 'one' },
      null,
      'not an object',
      { title: '', message: 'no title' },
      { title: 'no message', message: '  ' },
      { title: 42, message: 'numeric title' },
      { title: 'numeric message', message: 7 },
      { message: 'missing title' },
      { title: 'missing message' },
      { title: 'last', message: 'nine' }
    ]
    const items = suggestionsOf({ suggestions: list })
    expect(items).toHaveLength(list.length)
    expect(items[0]).toStrictEqual({ title: 'first', message: 'one' })
    for (let i = 1; i <= 8; i++) expect(items[i], `index ${i}`).toBeUndefined()
    expect(items[9]).toStrictEqual({ title: 'last', message: 'nine' })
  })
})

// ─── SG-2 ───────────────────────────────────────────────

describe('SG-2 · isSettledSuggestBlock', () => {
  it('SG-2 落定的 suggest 调用 → true（结果是空串也算落定）', () => {
    expect(isSettledSuggestBlock(suggestCall('c1'))).toBe(true)
    expect(isSettledSuggestBlock(suggestCall('c1', ITEMS, { result: '' }))).toBe(true)
    expect(isSettledSuggestBlock(suggestCall('c1', ITEMS, { isError: false }))).toBe(true)
  })

  it.each<[string, AssistantBlock]>([
    ['还在执行（没有 result）', suggestCall('c1', ITEMS, { result: undefined })],
    ['出错', suggestCall('c1', ITEMS, { isError: true, result: 'suggestions[0].title …' })],
    ['别的工具', { ...suggestCall('c1'), toolName: 'ask' }],
    ['第三方同名后缀', { ...suggestCall('c1'), toolName: 'mcp__x__suggest' }],
    ['正文块', { type: 'text', text: 'suggest' }],
    ['思考块', { type: 'thinking', text: 'suggest' }]
  ])('SG-2 %s → false', (_label, block) => {
    expect(isSettledSuggestBlock(block)).toBe(false)
  })
})

// ─── SG-3 / SG-4 ────────────────────────────────────────

describe('SG-3 · 开着，直到用户说了下一句话', () => {
  it('SG-3 落定的调用是 open；没有任何后续消息时一直 open', () => {
    const states = suggestionStatesOf([user('u1', 'hi'), assistant('a1', [suggestCall('c1')])])
    expect([...states]).toStrictEqual([[key('a1', 'c1'), OPEN]])
  })

  it('SG-3 同一条助手消息里两次调用：都 open；用户的下一句话把两组都关掉', () => {
    const before: ChatMessage[] = [
      user('u1', 'hi'),
      assistant('a1', [suggestCall('c1'), { type: 'text', text: 'and' }, suggestCall('c2')])
    ]
    expect(suggestionStatesOf(before)).toStrictEqual(
      new Map([
        [key('a1', 'c1'), OPEN],
        [key('a1', 'c2'), OPEN]
      ])
    )
    const after = suggestionStatesOf([...before, user('u2', 'something else')])
    expect(after).toStrictEqual(
      new Map([
        [key('a1', 'c1'), CLOSED],
        [key('a1', 'c2'), CLOSED]
      ])
    )
  })

  it('SG-3 跨消息的调用（同一轮里先后两条助手消息）都被下一句话关掉', () => {
    const states = suggestionStatesOf([
      user('u1', 'hi'),
      assistant('a1', [suggestCall('c1')]),
      assistant('a2', [suggestCall('c2'), { type: 'text', text: 'done' }]),
      user('u2', 'thanks')
    ])
    expect(states.get(key('a1', 'c1'))).toStrictEqual(CLOSED)
    expect(states.get(key('a2', 'c2'))).toStrictEqual(CLOSED)
  })

  it('SG-3 一句话只关它之前的组：之后新出现的组照样 open', () => {
    const states = suggestionStatesOf([
      assistant('a1', [suggestCall('c1')]),
      user('u2', 'no'),
      assistant('a2', [suggestCall('c9')])
    ])
    expect(states.get(key('a1', 'c1'))).toStrictEqual(CLOSED)
    expect(states.get(key('a2', 'c9'))).toStrictEqual(OPEN)
  })
})

describe('SG-4 · 系统写的话与错误行不关组', () => {
  it('SG-4 后台完成通知（isSystemNotice）与指令注入（isInstructionInjection）的 user 消息什么都不关', () => {
    const messages: ChatMessage[] = [
      assistant('a1', [suggestCall('c1')]),
      user('n1', '<background-task id="1" status="completed">done</background-task>', {
        isSystemNotice: true
      }),
      user('n2', 'AGENTS.md content', { isInstructionInjection: true }),
      errorRow('e1')
    ]
    expect(suggestionStatesOf(messages).get(key('a1', 'c1'))).toStrictEqual(OPEN)
    // 之后用户真说了话 → 关
    expect(suggestionStatesOf([...messages, user('u2', 'ok')]).get(key('a1', 'c1'))).toStrictEqual(
      CLOSED
    )
  })

  it('SG-4 系统通知即便带着提议引用也不算采纳：组仍开着', () => {
    const states = suggestionStatesOf([
      assistant('a1', [suggestCall('c1')]),
      user('n1', 'notice', {
        isSystemNotice: true,
        origin: { kind: 'local', suggestion: { messageId: 'a1', toolCallId: 'c1', index: 0 } }
      })
    ])
    expect(states.get(key('a1', 'c1'))).toStrictEqual(OPEN)
  })

  it('SG-4 还在执行 / 出错的 suggest 调用不是组：状态表里没有它们', () => {
    const states = suggestionStatesOf([
      assistant('a1', [
        suggestCall('running', ITEMS, { result: undefined }),
        suggestCall('failed', ITEMS, { isError: true, result: 'too long' })
      ]),
      user('u2', 'hi')
    ])
    expect(states.size).toBe(0)
  })
})

// ─── SG-5 / SG-6 ────────────────────────────────────────

describe('SG-5 · 采纳', () => {
  it('SG-5 引用指着开着的组：那组 accepted（带下标），同时开着的别组 closed', () => {
    const states = suggestionStatesOf([
      user('u1', 'hi'),
      assistant('a1', [suggestCall('c1'), suggestCall('c2')]),
      accepted('u2', { messageId: 'a1', toolCallId: 'c2', index: 2 })
    ])
    expect(states.get(key('a1', 'c2'))).toStrictEqual({ status: 'accepted', index: 2 })
    expect(states.get(key('a1', 'c1'))).toStrictEqual(CLOSED)
  })

  it('SG-5 远程连接的来源带引用同样算采纳；下标 0 也算', () => {
    const origin: InputOrigin = {
      kind: 'remote',
      clientId: 'ws:4',
      address: '10.0.0.7',
      suggestion: { messageId: 'a1', toolCallId: 'c1', index: 0 }
    }
    const states = suggestionStatesOf([
      assistant('a1', [suggestCall('c1')]),
      user('u2', 'x', { origin })
    ])
    expect(states.get(key('a1', 'c1'))).toStrictEqual({ status: 'accepted', index: 0 })
  })

  it('SG-5 引用指着不存在的组：开着的组只是关掉，状态表里也不多出那个键', () => {
    const states = suggestionStatesOf([
      assistant('a1', [suggestCall('c1')]),
      accepted('u2', { messageId: 'nope', toolCallId: 'c1', index: 0 })
    ])
    expect([...states]).toStrictEqual([[key('a1', 'c1'), CLOSED]])
  })

  it('SG-5 引用指着已经关了的组：它不会翻成 accepted，当时开着的组照样关掉', () => {
    const states = suggestionStatesOf([
      assistant('a1', [suggestCall('c1')]),
      user('u2', 'something else'),
      assistant('a2', [suggestCall('c2')]),
      accepted('u3', { messageId: 'a1', toolCallId: 'c1', index: 1 })
    ])
    expect(states.get(key('a1', 'c1'))).toStrictEqual(CLOSED)
    expect(states.get(key('a2', 'c2'))).toStrictEqual(CLOSED)
  })

  it('SG-5 已采纳的组不再变：之后用户又说了话，它仍是 accepted', () => {
    const states = suggestionStatesOf([
      assistant('a1', [suggestCall('c1')]),
      accepted('u2', { messageId: 'a1', toolCallId: 'c1', index: 1 }),
      assistant('a2', [{ type: 'text', text: 'ok' }]),
      user('u3', 'next'),
      accepted('u4', { messageId: 'a1', toolCallId: 'c1', index: 0 })
    ])
    expect(states.get(key('a1', 'c1'))).toStrictEqual({ status: 'accepted', index: 1 })
  })
})

describe('SG-6 · toolCallId 在一条会话里可以重复', () => {
  it('SG-6 两条助手消息里同一个 call_0：两个独立的组，各按自己那条消息之后的话判定', () => {
    const states = suggestionStatesOf([
      user('u1', 'hi'),
      assistant('a1', [suggestCall('call_0')]),
      accepted('u2', { messageId: 'a1', toolCallId: 'call_0', index: 1 }),
      assistant('a2', [suggestCall('call_0')])
    ])
    expect(states.get(key('a1', 'call_0'))).toStrictEqual({ status: 'accepted', index: 1 })
    expect(states.get(key('a2', 'call_0'))).toStrictEqual(OPEN)
    expect(key('a1', 'call_0')).not.toBe(key('a2', 'call_0'))
  })

  it('SG-6 采纳第二组不会顺带把第一组判成采纳', () => {
    const states = suggestionStatesOf([
      assistant('a1', [suggestCall('call_0')]),
      user('u2', 'something else'),
      assistant('a2', [suggestCall('call_0')]),
      accepted('u3', { messageId: 'a2', toolCallId: 'call_0', index: 0 })
    ])
    expect(states.get(key('a1', 'call_0'))).toStrictEqual(CLOSED)
    expect(states.get(key('a2', 'call_0'))).toStrictEqual({ status: 'accepted', index: 0 })
  })
})

// ─── SG-7 ───────────────────────────────────────────────

describe('SG-7 · suggestionToAccept', () => {
  const WITH_HOLE = [
    { title: 'one', message: 'first' },
    { title: '' },
    { title: 'three', message: 'third' }
  ]
  const base = (): ChatMessage[] => [
    user('u1', 'hi'),
    assistant('a1', [
      suggestCall('c1'),
      suggestCall('running', ITEMS, { result: undefined }),
      suggestCall('failed', ITEMS, { isError: true, result: 'bad' }),
      suggestCall('holes', WITH_HOLE)
    ])
  ]
  const NOT_FOUND = { ok: false, reason: 'not-found' }
  const CLOSED_RESULT = { ok: false, reason: 'closed' }

  it.each<[string, SuggestionRef]>([
    ['未知的消息 id', { messageId: 'zz', toolCallId: 'c1', index: 0 }],
    ['消息 id 是一条用户消息', { messageId: 'u1', toolCallId: 'c1', index: 0 }],
    ['toolCallId 不对', { messageId: 'a1', toolCallId: 'c404', index: 0 }],
    ['还在执行的调用', { messageId: 'a1', toolCallId: 'running', index: 0 }],
    ['出错的调用', { messageId: 'a1', toolCallId: 'failed', index: 0 }],
    ['下标越界', { messageId: 'a1', toolCallId: 'c1', index: 3 }],
    ['下标是空位（坏项）', { messageId: 'a1', toolCallId: 'holes', index: 1 }]
  ])('SG-7 %s → not-found', (_label, ref) => {
    expect(suggestionToAccept(base(), ref)).toStrictEqual(NOT_FOUND)
  })

  it('SG-7 开着 → ok，交回工具参数里那一条的 message（原样，不 trim）', () => {
    expect(
      suggestionToAccept(base(), { messageId: 'a1', toolCallId: 'c1', index: 1 })
    ).toStrictEqual({ ok: true, message: 'Please update the README too' })
    expect(
      suggestionToAccept(base(), { messageId: 'a1', toolCallId: 'holes', index: 2 })
    ).toStrictEqual({ ok: true, message: 'third' })
    const padded = [assistant('a9', [suggestCall('p', [{ title: 'T', message: '  keep  \n' }])])]
    expect(
      suggestionToAccept(padded, { messageId: 'a9', toolCallId: 'p', index: 0 })
    ).toStrictEqual({ ok: true, message: '  keep  \n' })
  })

  it('SG-7 之后用户说了别的 → closed；系统通知不算', () => {
    const ref = { messageId: 'a1', toolCallId: 'c1', index: 0 }
    expect(
      suggestionToAccept([...base(), user('n1', 'notice', { isSystemNotice: true })], ref)
    ).toStrictEqual({ ok: true, message: ITEMS[0]!.message })
    expect(suggestionToAccept([...base(), user('u2', 'never mind')], ref)).toStrictEqual(
      CLOSED_RESULT
    )
  })

  it('SG-7 已采纳过（同一条或同组另一条）→ closed', () => {
    const messages = [...base(), accepted('u2', { messageId: 'a1', toolCallId: 'c1', index: 0 })]
    expect(
      suggestionToAccept(messages, { messageId: 'a1', toolCallId: 'c1', index: 0 })
    ).toStrictEqual(CLOSED_RESULT)
    expect(
      suggestionToAccept(messages, { messageId: 'a1', toolCallId: 'c1', index: 2 })
    ).toStrictEqual(CLOSED_RESULT)
  })

  it('SG-7 not-found 先于 closed：已经关了的组里越界的下标仍是 not-found', () => {
    const messages = [...base(), user('u2', 'moved on')]
    expect(
      suggestionToAccept(messages, { messageId: 'a1', toolCallId: 'c1', index: 5 })
    ).toStrictEqual(NOT_FOUND)
  })

  it('SG-7 重复的 call_0：按消息 id 找到对的那一组', () => {
    const messages: ChatMessage[] = [
      assistant('a1', [suggestCall('call_0', [{ title: 'old', message: 'from a1' }])]),
      user('u2', 'next'),
      assistant('a2', [suggestCall('call_0', [{ title: 'new', message: 'from a2' }])])
    ]
    expect(
      suggestionToAccept(messages, { messageId: 'a2', toolCallId: 'call_0', index: 0 })
    ).toStrictEqual({ ok: true, message: 'from a2' })
    expect(
      suggestionToAccept(messages, { messageId: 'a1', toolCallId: 'call_0', index: 0 })
    ).toStrictEqual(CLOSED_RESULT)
  })
})
