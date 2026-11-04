/**
 * 触发器替 bot 发的消息（`triggerEvent.ts`，CLAUDE.md「A trigger message's event is a chip」）：模型文本 =
 * message + 事件围栏 + 固定说明；显示侧车 = message + 一枚 `trigger` Token。这里钉数据形状与几个读写函数：
 *
 *   TE-1 模型文本逐字是 `M\n\nF\n\n` + 说明
 *   TE-2 显示侧车逐字：message + 标记，一枚 Token（`displayText` 是空串，payload 带开头的分隔）
 *   TE-3 `resolveTokensForAgent` 把侧车展开回模型文本（重新生成靠它）：多行、CJK、`$` 替换符、占位符、别的花括号
 *   TE-4 人读的出口只留 message：复制、纯文本、回填草稿；分段 = 文本 + Token
 *   TE-5 说明纯 ASCII，写着模型自己不知道的四件事
 *   TE-6 `isTriggerEventToken` 只看 type
 *   TE-7 `withoutSystemTokens`：只摘系统写的标记，别的留着；tokens 为 undefined 原样；连调两次相同（防 /g 状态）
 *   TE-8 `tokensWithoutSystemTokens`：全系统 → undefined；混合只留其他；没有系统 Token → 同一引用
 *   TE-9 发送方 Token 也是系统写的：`withoutSystemTokens` 摘它，插话说明的那一组函数不摘它；不算插话，任务列表上是新请求
 */
import { describe, expect, it } from 'vitest'
import {
  MID_RUN_NOTE_UID,
  hasMidRunNote,
  midRunNoteDisplay,
  midRunNoteToken,
  tokensWithoutMidRunNote,
  withoutMidRunNote
} from './midRunNote'
import { SESSION_SENDER_UID, sessionSenderToken } from './sessionSender'
import { startsTaskListRequest } from './taskList'
import {
  TRIGGER_EVENT_NOTE_TEXT,
  TRIGGER_EVENT_TOKEN_TYPE,
  TRIGGER_EVENT_UID,
  isTriggerEventToken,
  tokensWithoutSystemTokens,
  triggerEventMessage,
  withoutSystemTokens
} from './triggerEvent'
import type { ChatMessage, InlineToken } from './types/chatMessage'
import {
  buildAtToken,
  buildPasteToken,
  inlineTokensToPlainText,
  makeTokenMarker,
  rebuildDraftFromContent,
  resolveTokensForAgent,
  resolveTokensForCopy,
  segmentContent
} from './utils/inlineTokens'

// ─── 夹具 ───────────────────────────────────────────────

const M = 'Tick check-in.'
const F =
  '<trigger_event trigger="timer.fired">\nsourceId: timer:builtin:minute\nfiredAt: 2026-11-02T10:00:00.000Z\n</trigger_event>'
const NOTE = TRIGGER_EVENT_NOTE_TEXT
const MARKER = '{{shuvixInlineToken:trigger}}'
const LABEL = '11-02 18:00'

function build(message: string, fence: string): ReturnType<typeof triggerEventMessage> {
  return triggerEventMessage({ message, fence, trigger: 'timer.fired', firedLabel: LABEL })
}

const pasteToken: InlineToken = buildPasteToken({
  payload: 'line1\nline2',
  displayText: '[pasted #1]',
  seq: 1,
  name: 'pasted #1'
})
const atToken: InlineToken = buildAtToken({ kind: 'file', rel: 'src/a.ts', base: 'a.ts' })
const triggerToken = (): InlineToken => build(M, F).display.tokens[TRIGGER_EVENT_UID]!

// ─── 用例 ───────────────────────────────────────────────

describe('triggerEventMessage', () => {
  it('TE-1 the model text is exactly M, a blank line, the fence, a blank line, the note', () => {
    expect(build(M, F).text).toBe(`${M}\n\n${F}\n\n${NOTE}`)
  })

  it('TE-2 the display sidecar is M + the marker and exactly one token, byte for byte', () => {
    const { display } = build(M, F)
    expect(display.content).toBe(`${M}${MARKER}`)
    expect(display.tokens).toStrictEqual({
      trigger: {
        type: 'trigger',
        id: 'timer.fired',
        displayText: '',
        name: LABEL,
        payload: `\n\n${F}\n\n${NOTE}`
      }
    })
    // 标记确实是这个 uid 的标记（两边不是各写了一遍碰巧相同的字面量）
    expect(makeTokenMarker(TRIGGER_EVENT_UID)).toBe(MARKER)
    expect(display.tokens.trigger!.type).toBe(TRIGGER_EVENT_TOKEN_TYPE)
  })

  describe('TE-3 the sidecar expands back to the model text', () => {
    const cases: Array<[string, string, string]> = [
      ['plain', M, F],
      ['multi-line message', 'first line\nsecond line\n\nthird', F],
      ['multi-line fence', M, `${F}\nmore: 1\n\nend: 2`],
      ['CJK', '每天早上看看昨天的会话', '<trigger_event>\n时间：今天\n</trigger_event>'],
      ['$& in the message', 'cost is $& and more', F],
      ['$1 in the message', 'use $1 and $2', F],
      ["$' in the message", "it's $' here", F],
      ['$ forms in the fence', M, "<f>$& $1 $' $`</f>"],
      ['an existing placeholder', 'DB_PASSWORD={{DB_PASSWORD_abcdefgh}}', F],
      ['a placeholder in the fence', M, 'password: {{DB_PASSWORD_abcdefgh}}'],
      ['other braces', 'see {{notToken}} and {{ also }}', F],
      ['other braces in the fence', M, '{{notToken}}'],
      ['empty message', '', F],
      ['trailing newline', 'ends with newline\n', F]
    ]
    for (const [name, message, fence] of cases) {
      it(name, () => {
        const { text, display } = build(message, fence)
        expect(resolveTokensForAgent(display.content, display.tokens)).toBe(text)
      })
    }
  })

  describe('TE-4 the human-facing readers keep only the message', () => {
    const messages = [M, '多行\n消息', 'cost $& {{notToken}}']
    for (const message of messages) {
      it(JSON.stringify(message), () => {
        const { display } = build(message, F)
        expect(resolveTokensForCopy(display.content, display.tokens)).toBe(message)
        expect(inlineTokensToPlainText(display.content, display.tokens)).toBe(message)
        expect(rebuildDraftFromContent(display.content, display.tokens)).toStrictEqual({
          text: message,
          atTokens: [],
          pasteTokens: []
        })
        expect(segmentContent(display.content, display.tokens)).toStrictEqual([
          { type: 'text', text: message },
          { type: 'token', uid: TRIGGER_EVENT_UID, token: display.tokens.trigger }
        ])
      })
    }
  })
})

describe('TE-5 the note', () => {
  it('is pure ASCII', () => {
    // eslint-disable-next-line no-control-regex
    expect(NOTE).toMatch(/^[\x00-\x7f]+$/)
  })

  it('says it was sent automatically', () => {
    expect(NOTE).toMatch(/sent automatically/i)
  })

  it('says the user did not type it just now and may not be watching', () => {
    expect(NOTE).toMatch(/did not type it just now/i)
    expect(NOTE).toMatch(/may not be watching/i)
  })

  it('says the user can reply later', () => {
    expect(NOTE).toMatch(/read this session later and reply/i)
  })

  it("says waiting for an answer holds the trigger's next firings", () => {
    expect(NOTE).toMatch(/wait for an answer/i)
    expect(NOTE).toMatch(/next firings are skipped/i)
  })
})

describe('TE-6 isTriggerEventToken looks only at type', () => {
  const cases: Array<[string, unknown, boolean]> = [
    ['null', null, false],
    ['undefined', undefined, false],
    ['a string', 'trigger', false],
    ['a number', 1, false],
    ['an empty object', {}, false],
    ['a bare trigger type', { type: 'trigger' }, true],
    ['a built trigger token', triggerToken(), true],
    ['the mid-run note', midRunNoteToken(), false],
    ['an at token', atToken, false],
    ['a paste token', pasteToken, false],
    ['an id that looks like a trigger', { type: 'at', id: 'trigger' }, false]
  ]
  for (const [name, value, expected] of cases) {
    it(name, () => {
      expect(isTriggerEventToken(value)).toBe(expected)
    })
  }
})

describe('TE-7 withoutSystemTokens', () => {
  const noted = midRunNoteDisplay('pivot')
  const pasteMarker = makeTokenMarker('p1')
  const atMarker = makeTokenMarker('a1')
  const unknownMarker = makeTokenMarker('nobody')

  it('takes out the trigger marker', () => {
    const { display } = build(M, F)
    expect(withoutSystemTokens(display.content, display.tokens)).toBe(M)
  })

  it('takes out the mid-run marker', () => {
    expect(withoutSystemTokens(noted.content, noted.tokens)).toBe('pivot')
  })

  it('takes out both when both are there', () => {
    const content = `a${MARKER}b${makeTokenMarker(MID_RUN_NOTE_UID)}c`
    const tokens = { [TRIGGER_EVENT_UID]: triggerToken(), [MID_RUN_NOTE_UID]: midRunNoteToken() }
    expect(withoutSystemTokens(content, tokens)).toBe('abc')
  })

  it('keeps paste and at markers next to a system one', () => {
    const content = `${atMarker} x ${pasteMarker}${MARKER}`
    const tokens = { a1: atToken, p1: pasteToken, [TRIGGER_EVENT_UID]: triggerToken() }
    expect(withoutSystemTokens(content, tokens)).toBe(`${atMarker} x ${pasteMarker}`)
  })

  it('keeps a marker whose uid is unknown', () => {
    const content = `x${unknownMarker}y${MARKER}`
    expect(withoutSystemTokens(content, { [TRIGGER_EVENT_UID]: triggerToken() })).toBe(
      `x${unknownMarker}y`
    )
  })

  it('leaves the content alone when tokens is undefined or holds no system token', () => {
    const content = `x${MARKER}y`
    expect(withoutSystemTokens(content, undefined)).toBe(content)
    expect(withoutSystemTokens(`x${pasteMarker}`, { p1: pasteToken })).toBe(`x${pasteMarker}`)
    expect(withoutSystemTokens(`x${MARKER}`, {})).toBe(`x${MARKER}`)
  })

  it('gives the same result when called twice on the same input (no /g state)', () => {
    const { display } = build(`${M} and ${M}`, F)
    const first = withoutSystemTokens(display.content, display.tokens)
    const second = withoutSystemTokens(display.content, display.tokens)
    expect(first).toBe(`${M} and ${M}`)
    expect(second).toBe(first)
    const manyMarkers = `${MARKER}a${MARKER}b${MARKER}`
    const tokens = { [TRIGGER_EVENT_UID]: triggerToken() }
    expect(withoutSystemTokens(manyMarkers, tokens)).toBe('ab')
    expect(withoutSystemTokens(manyMarkers, tokens)).toBe('ab')
  })

  it('does not touch the words of a system token that are not its marker', () => {
    const content = `trigger {{trigger}} shuvixInlineToken ${MARKER}`
    expect(withoutSystemTokens(content, { [TRIGGER_EVENT_UID]: triggerToken() })).toBe(
      'trigger {{trigger}} shuvixInlineToken '
    )
  })
})

describe('TE-8 tokensWithoutSystemTokens', () => {
  it('only system tokens → undefined', () => {
    expect(tokensWithoutSystemTokens({ [TRIGGER_EVENT_UID]: triggerToken() })).toBeUndefined()
    expect(tokensWithoutSystemTokens({ [MID_RUN_NOTE_UID]: midRunNoteToken() })).toBeUndefined()
    expect(
      tokensWithoutSystemTokens({
        [TRIGGER_EVENT_UID]: triggerToken(),
        [MID_RUN_NOTE_UID]: midRunNoteToken()
      })
    ).toBeUndefined()
  })

  it('mixed → only the others, the input untouched', () => {
    const input = {
      [TRIGGER_EVENT_UID]: triggerToken(),
      p1: pasteToken,
      [MID_RUN_NOTE_UID]: midRunNoteToken(),
      a1: atToken
    }
    const keys = Object.keys(input)
    expect(tokensWithoutSystemTokens(input)).toStrictEqual({ p1: pasteToken, a1: atToken })
    expect(Object.keys(input)).toEqual(keys)
  })

  it('no system token → the same reference; undefined → undefined', () => {
    const input = { p1: pasteToken, a1: atToken }
    expect(tokensWithoutSystemTokens(input)).toBe(input)
    const empty = {}
    expect(tokensWithoutSystemTokens(empty)).toBe(empty)
    expect(tokensWithoutSystemTokens(undefined)).toBeUndefined()
  })
})

describe('TE-9 the sender token is system-written, but it is not the mid-run note', () => {
  const senderMarker = makeTokenMarker(SESSION_SENDER_UID)
  const midRunMarker = makeTokenMarker(MID_RUN_NOTE_UID)
  const atMarker = makeTokenMarker('a1')
  const sender = sessionSenderToken({ kind: 'parent-session', sessionId: 'P1', title: 'T' })
  const content = `${M} ${atMarker}${senderMarker}${midRunMarker}`
  const tokens = {
    a1: atToken,
    [SESSION_SENDER_UID]: sender,
    [MID_RUN_NOTE_UID]: midRunNoteToken()
  }

  it('withoutMidRunNote takes out only the mid-run marker', () => {
    expect(withoutMidRunNote(content, tokens)).toBe(`${M} ${atMarker}${senderMarker}`)
  })

  it('tokensWithoutMidRunNote keeps the sender', () => {
    expect(tokensWithoutMidRunNote(tokens)).toStrictEqual({
      a1: atToken,
      [SESSION_SENDER_UID]: sender
    })
    expect(tokensWithoutMidRunNote({ [SESSION_SENDER_UID]: sender })).toStrictEqual({
      [SESSION_SENDER_UID]: sender
    })
  })

  it('withoutSystemTokens takes out both and leaves the at marker; twice gives the same', () => {
    expect(withoutSystemTokens(content, tokens)).toBe(`${M} ${atMarker}`)
    expect(withoutSystemTokens(content, tokens)).toBe(`${M} ${atMarker}`)
  })

  it('tokensWithoutSystemTokens keeps the at token and gives undefined when nothing else is left', () => {
    expect(tokensWithoutSystemTokens(tokens)).toStrictEqual({ a1: atToken })
    expect(
      tokensWithoutSystemTokens({
        [SESSION_SENDER_UID]: sender,
        [MID_RUN_NOTE_UID]: midRunNoteToken()
      })
    ).toBeUndefined()
    expect(tokensWithoutSystemTokens({ [SESSION_SENDER_UID]: sender })).toBeUndefined()
  })

  const user = (inlineTokens: Record<string, InlineToken>): ChatMessage =>
    ({
      id: 'u1',
      sessionId: 's1',
      role: 'user',
      type: 'text',
      content: M,
      model: 'test',
      createdAt: 1,
      metadata: { inlineTokens }
    }) as unknown as ChatMessage

  it('hasMidRunNote is false with only the sender, so the message starts a task-list request', () => {
    const only = { [SESSION_SENDER_UID]: sender }
    expect(hasMidRunNote(only)).toBe(false)
    expect(startsTaskListRequest(user(only))).toBe(true)
  })

  it('with both, it is a mid-run message and starts none', () => {
    const both = { [SESSION_SENDER_UID]: sender, [MID_RUN_NOTE_UID]: midRunNoteToken() }
    expect(hasMidRunNote(both)).toBe(true)
    expect(startsTaskListRequest(user(both))).toBe(false)
  })
})
