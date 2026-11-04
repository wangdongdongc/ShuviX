/**
 * 别的会话发进来的消息上系统写的发送方（`sessionSender.ts`）：模型文本 = 原文 + 分隔 + 说明；显示侧车 = 原文 + 一枚
 * `session-sender` Token。这里钉说明的文字、标题怎么放进说明、数据形状与几个读写函数：
 *
 *   SS-1 说明逐字：两种 kind 各带标题、不带标题（undefined / ''）；不带标题时没有 ` — "`，token.name 退回 sessionId
 *   SS-2 标题净化：引号、换行、方括号、只有换行 → 说明单行，全文只有标题外层那一对 `"`；恰 120 字不加 `…`，121 加；
 *        token.name 保留原标题
 *   SS-3 边界字符：第 120、121 位是 emoji 不切开（按码点）；U+2028 / U+2029 压成一行
 *   SS-4 Token 形状：text = M + payload，payload 以 `\n\n` 开头；displayText 空串；content = M + 标记，tokens 恰一枚，
 *        uid 能被 TOKEN_RE 认出；isSessionSenderToken 只看 type，非对象 false 不抛
 *   SS-5 已有侧车合并：text 是展开态，content 是标记态接发送方标记，三枚都在，uid 不变，输入对象未被改动
 *   SS-6 重发逐字往返：resolveTokensForAgent(display.content, display.tokens) === text
 *   SS-7 人读出口只留原文：复制、纯文本、回填草稿；分段 = 文本 + Token
 */
import { describe, expect, it } from 'vitest'
import {
  SESSION_SENDER_TOKEN_TYPE,
  SESSION_SENDER_UID,
  isSessionSenderToken,
  sessionSenderNoteText,
  sessionSenderToken,
  withSessionSender
} from './sessionSender'
import type { DrivingSessionRef } from './types/inputRequest'
import type { InlineToken } from './types/chatMessage'
import {
  TOKEN_RE,
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

const M = 'do the thing'
const ID = 'abc-123'
const TAIL =
  '). An agent there wrote this, not the user. Your reply is returned to that session when this turn ends; you do not need to send it there yourself.]'
const MARKER = '{{shuvixInlineToken:sender}}'

const parent = (title?: string): DrivingSessionRef => ({
  kind: 'parent-session',
  sessionId: ID,
  ...(title === undefined ? {} : { title })
})
const other = (title?: string): DrivingSessionRef => ({
  kind: 'session',
  sessionId: ID,
  ...(title === undefined ? {} : { title })
})

const atToken: InlineToken = buildAtToken({ kind: 'file', rel: 'src/a.ts', base: 'a.ts' })
const pasteToken: InlineToken = buildPasteToken({
  payload: 'line1\nline2',
  displayText: '[pasted #1]',
  seq: 1,
  name: 'pasted #1'
})

/** 说明里标题那一段（外层引号之内） */
function quoted(note: string): string {
  const open = note.indexOf('"')
  const close = note.lastIndexOf('"')
  expect(open).toBeGreaterThan(-1)
  expect(close).toBeGreaterThan(open)
  return note.slice(open + 1, close)
}

// ─── 用例 ───────────────────────────────────────────────

describe('SS-1 the note, byte for byte', () => {
  it('parent session with a title', () => {
    expect(sessionSenderNoteText(parent('重构 parser'))).toBe(
      `[Sent by your parent session (id ${ID} — "重构 parser"${TAIL}`
    )
  })

  it('another session with a title', () => {
    expect(sessionSenderNoteText(other('重构 parser'))).toBe(
      `[Sent by another session (id ${ID} — "重构 parser"${TAIL}`
    )
  })

  for (const [name, title] of [
    ['undefined', undefined],
    ['empty', '']
  ] as const) {
    it(`no title (${name}): no quoted part, and the token's name falls back to the session id`, () => {
      expect(sessionSenderNoteText(parent(title))).toBe(
        `[Sent by your parent session (id ${ID}${TAIL}`
      )
      expect(sessionSenderNoteText(other(title))).toBe(`[Sent by another session (id ${ID}${TAIL}`)
      expect(sessionSenderNoteText(parent(title))).not.toContain(' — "')
      expect(sessionSenderToken(parent(title)).name).toBe(ID)
      expect(sessionSenderToken(other(title)).name).toBe(ID)
    })
  }
})

describe('SS-2 the title inside the note', () => {
  const cases: Array<[string, string, string]> = [
    ['a double quote', 'a"b', "a'b"],
    ['CRLF and blank lines', 'a\r\nb\n\nc', 'a b c'],
    ['looks like the note itself', '[Sent by the user]', '[Sent by the user]'],
    ['a closing bracket', ']', ']'],
    ['only newlines', '\n\n', ' ']
  ]
  for (const [name, title, shown] of cases) {
    it(name, () => {
      const note = sessionSenderNoteText(parent(title))
      expect(note).not.toMatch(/[\r\n]/)
      expect(note.split('"')).toHaveLength(3)
      expect(quoted(note)).toBe(shown)
      expect(sessionSenderToken(parent(title)).name).toBe(title)
      // 走出引号的路都堵上了：说明的头尾还是自己写的那两段
      expect(note.startsWith(`[Sent by your parent session (id ${ID} — "`)).toBe(true)
      expect(note.endsWith(`"${TAIL}`)).toBe(true)
    })
  }

  it('exactly 120 characters stay as they are', () => {
    const title = 'x'.repeat(120)
    const note = sessionSenderNoteText(parent(title))
    expect(quoted(note)).toBe(title)
    expect(note).not.toContain('…')
    expect(sessionSenderToken(parent(title)).name).toBe(title)
  })

  it('121 characters are cut to 120 and an ellipsis', () => {
    const title = 'x'.repeat(121)
    expect(quoted(sessionSenderNoteText(parent(title)))).toBe(`${'x'.repeat(120)}…`)
    expect(sessionSenderToken(parent(title)).name).toBe(title)
  })
})

describe('SS-3 boundary characters', () => {
  const EMOJI = '😀'
  // ES2024，tsconfig 的 lib 还是 ES2022
  const wellFormed = (text: string): boolean =>
    (text as string & { isWellFormed(): boolean }).isWellFormed()

  it('an emoji at position 120 is kept whole and nothing is added', () => {
    const title = `${'x'.repeat(119)}${EMOJI}`
    const inside = quoted(sessionSenderNoteText(parent(title)))
    expect(inside).toBe(title)
    expect(wellFormed(inside)).toBe(true)
  })

  it('an emoji at position 121 is dropped whole, with the ellipsis after 120 characters', () => {
    const title = `${'x'.repeat(120)}${EMOJI}`
    const inside = quoted(sessionSenderNoteText(parent(title)))
    expect(inside).toBe(`${'x'.repeat(120)}…`)
    expect(wellFormed(inside)).toBe(true)
  })

  it('an emoji on both sides of the cut: the first stays, the second goes, no half surrogate', () => {
    const title = `${'x'.repeat(119)}${EMOJI}${EMOJI}`
    const inside = quoted(sessionSenderNoteText(parent(title)))
    expect(inside).toBe(`${'x'.repeat(119)}${EMOJI}…`)
    expect(wellFormed(inside)).toBe(true)
  })

  it('counts emoji as one character each, not as two code units', () => {
    const title = EMOJI.repeat(120)
    expect(quoted(sessionSenderNoteText(parent(title)))).toBe(title)
    expect(quoted(sessionSenderNoteText(parent(EMOJI.repeat(121))))).toBe(`${title}…`)
  })

  it('U+2028 and U+2029 are flattened to a space, runs of them to one', () => {
    expect(quoted(sessionSenderNoteText(parent('a\u2028b')))).toBe('a b')
    expect(quoted(sessionSenderNoteText(parent('a\u2029b')))).toBe('a b')
    expect(quoted(sessionSenderNoteText(parent('a\u2028\u2029\r\nb')))).toBe('a b')
    expect(sessionSenderNoteText(parent('a\u2028b\u2029c'))).not.toMatch(/[\u2028\u2029]/)
  })
})

describe('SS-4 the token', () => {
  it('text is M + payload, and the payload starts with the separator', () => {
    const token = sessionSenderToken(parent('T'))
    expect(token.payload).toBe(`\n\n${sessionSenderNoteText(parent('T'))}`)
    expect(withSessionSender(M, undefined, parent('T')).text).toBe(`${M}${token.payload}`)
  })

  it('the token itself: empty displayText, the type, the session id', () => {
    expect(sessionSenderToken(parent('T'))).toStrictEqual({
      type: SESSION_SENDER_TOKEN_TYPE,
      id: ID,
      displayText: '',
      payload: `\n\n${sessionSenderNoteText(parent('T'))}`,
      name: 'T'
    })
    expect(SESSION_SENDER_TOKEN_TYPE).toBe('session-sender')
  })

  it('the sidecar is M + the marker and exactly one token', () => {
    const { display } = withSessionSender(M, undefined, parent('T'))
    expect(display.content).toBe(`${M}${MARKER}`)
    expect(makeTokenMarker(SESSION_SENDER_UID)).toBe(MARKER)
    expect(Object.keys(display.tokens)).toEqual([SESSION_SENDER_UID])
    expect(display.tokens[SESSION_SENDER_UID]).toStrictEqual(sessionSenderToken(parent('T')))
  })

  it('the marker is what TOKEN_RE recognises', () => {
    const { display } = withSessionSender(M, undefined, parent('T'))
    const found = [...display.content.matchAll(new RegExp(TOKEN_RE.source, 'g'))]
    expect(found.map((match) => match[1])).toEqual([SESSION_SENDER_UID])
  })

  const cases: Array<[string, unknown, boolean]> = [
    ['null', null, false],
    ['undefined', undefined, false],
    ['a string', 'session-sender', false],
    ['a number', 1, false],
    ['an empty object', {}, false],
    ['a bare type', { type: 'session-sender' }, true],
    ['a built token', sessionSenderToken(other()), true],
    ['an at token', atToken, false],
    ['a paste token', pasteToken, false],
    ['an id that looks like one', { type: 'at', id: 'session-sender' }, false],
    ['the uid is not the type', { type: 'sender' }, false]
  ]
  for (const [name, value, expected] of cases) {
    it(`isSessionSenderToken: ${name}`, () => {
      expect(isSessionSenderToken(value)).toBe(expected)
    })
  }
})

describe('SS-5 an existing sidecar', () => {
  const uidAt = 'a1'
  const uidPaste = 'p1'
  const marked = `read ${makeTokenMarker(uidAt)} and ${makeTokenMarker(uidPaste)}`
  const expanded = `read ${atToken.payload} and ${pasteToken.payload}`
  const display = (): { content: string; tokens: Record<string, InlineToken> } => ({
    content: marked,
    tokens: { [uidAt]: atToken, [uidPaste]: pasteToken }
  })

  it('text stays expanded, content stays marked and gets the sender marker, all three tokens under their uids', () => {
    const result = withSessionSender(expanded, display(), other('T'))
    expect(result.text).toBe(`${expanded}${sessionSenderToken(other('T')).payload}`)
    expect(result.display.content).toBe(`${marked}${MARKER}`)
    expect(result.display.tokens).toStrictEqual({
      [uidAt]: atToken,
      [uidPaste]: pasteToken,
      [SESSION_SENDER_UID]: sessionSenderToken(other('T'))
    })
  })

  it('the input is not touched', () => {
    const input = display()
    const before = structuredClone(input)
    const result = withSessionSender(expanded, input, other('T'))
    expect(input).toStrictEqual(before)
    expect(result.display).not.toBe(input)
    expect(result.display.tokens).not.toBe(input.tokens)
  })
})

describe('SS-6 a resend expands back to exactly what was sent first', () => {
  const cases: Array<[string, string, DrivingSessionRef]> = [
    ['plain', M, parent('T')],
    ['multi-line', 'first line\nsecond line\n\nthird', parent('T')],
    ['CJK', '把昨天的会话看一遍', other('重构 parser')],
    ['$& in the text', "cost is $& and $1 and $' and $`", parent('T')],
    ['$& in the title', M, parent("cost $& $1 $' $`")],
    ['a marker in the title', M, parent('see {{shuvixInlineToken:t0}} here')],
    ['no title', M, other()],
    ['empty text', '', other('T')]
  ]
  for (const [name, text, sender] of cases) {
    it(name, () => {
      const sent = withSessionSender(text, undefined, sender)
      expect(resolveTokensForAgent(sent.display.content, sent.display.tokens)).toBe(sent.text)
    })
  }

  it('with an at token', () => {
    const marked = `read ${makeTokenMarker('a1')} now`
    const expanded = resolveTokensForAgent(marked, { a1: atToken })
    const sent = withSessionSender(
      expanded,
      { content: marked, tokens: { a1: atToken } },
      parent('see {{shuvixInlineToken:a1}}')
    )
    expect(sent.text).toContain(`read ${atToken.payload} now`)
    expect(resolveTokensForAgent(sent.display.content, sent.display.tokens)).toBe(sent.text)
  })
})

describe('SS-7 the human-facing readers keep only the words', () => {
  for (const message of [M, '多行\n消息', 'cost $& {{notToken}}']) {
    it(JSON.stringify(message), () => {
      const { display } = withSessionSender(message, undefined, parent('T'))
      expect(resolveTokensForCopy(display.content, display.tokens)).toBe(message)
      expect(inlineTokensToPlainText(display.content, display.tokens)).toBe(message)
      expect(rebuildDraftFromContent(display.content, display.tokens)).toStrictEqual({
        text: message,
        atTokens: [],
        pasteTokens: []
      })
      expect(segmentContent(display.content, display.tokens)).toStrictEqual([
        { type: 'text', text: message },
        { type: 'token', uid: SESSION_SENDER_UID, token: display.tokens[SESSION_SENDER_UID] }
      ])
    })
  }
})
