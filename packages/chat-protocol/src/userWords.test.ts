/**
 * 父会话发进子会话的消息上宿主附的用户原话（`userWords.ts`）：模型文本 = 原文 + 分隔 + 引用块；显示侧车 = 原文 + 一枚
 * `user-words` Token；发送方说明在它之后、只认领上面那段。这里钉：
 *
 *   UW-1 引用块：围栏与 scope 属性、开头一句事实（两种 scope 各一句）、旧 → 新、消息与回答两种条目、提议发出的标明
 *   UW-2 省略：`start` 说 in between、`since-last` 说 earlier，单复数；没省略就不提
 *   UW-3 属性转义：问题里的引号、尖括号、& 和换行进不了标签；正文原样（不转义、不截断 —— 截断是宿主的事）
 *   UW-4 Token 形状：displayText 空串、payload 以 `\n\n` 开头、name = 条数、id = 父会话；isUserWordsToken 只看 type
 *   UW-5 与已有侧车合并、与发送方说明连用：text = 原文 + 引用 + 说明（说明换成认领上面那段的措辞）；重发逐字往返
 *   UW-6 人读出口只留原文：大纲 / 摘要 / 导出去掉它（withoutSystemTokens），复制与纯文本也没有它
 */
import { describe, expect, it } from 'vitest'
import { sessionSenderNoteText, withSessionSender } from './sessionSender'
import { withoutSystemTokens } from './triggerEvent'
import {
  USER_WORDS_TOKEN_TYPE,
  USER_WORDS_UID,
  isUserWordsToken,
  userWordsBlockText,
  userWordsToken,
  withUserWords,
  type UserWordsQuote
} from './userWords'
import {
  TOKEN_RE,
  buildAtToken,
  inlineTokensToPlainText,
  makeTokenMarker,
  resolveTokensForAgent,
  resolveTokensForCopy
} from './utils/inlineTokens'

const T = (ts: number): string => `t${ts}`

const QUOTE: UserWordsQuote = {
  sessionId: 'P1',
  scope: 'start',
  words: [
    { kind: 'message', ts: 1, text: '金额都用美元两位小数' },
    {
      kind: 'answer',
      ts: 2,
      text: 'User selected: 最近一次入库单价',
      question: '盘盈按什么单价？'
    },
    { kind: 'message', ts: 3, text: '就这样做吧', suggested: true }
  ],
  omitted: 0
}

describe('userWordsBlockText', () => {
  it('UW-1 围栏、事实句、旧 → 新、两种条目、提议标明', () => {
    const block = userWordsBlockText(QUOTE, T)
    expect(block.split('\n')).toEqual([
      '<user-words from="parent-session" scope="start">',
      "The user's own words in your parent session so far, quoted verbatim by ShuviX, oldest first. The agent there did not write or edit them; the text above this block is its own.",
      '<message time="t1">',
      '金额都用美元两位小数',
      '</message>',
      '<answer time="t2" question="盘盈按什么单价？">',
      'User selected: 最近一次入库单价',
      '</answer>',
      '<message time="t3" via="suggestion written by the agent, sent by the user">',
      '就这样做吧',
      '</message>',
      '</user-words>'
    ])
    const since = userWordsBlockText({ ...QUOTE, scope: 'since-last' }, T)
    expect(since).toContain('scope="since-last"')
    expect(since).toContain(
      'What the user has written in your parent session since its previous message to you, quoted verbatim by ShuviX'
    )
  })

  it('UW-2 省略的位置与单复数', () => {
    expect(userWordsBlockText({ ...QUOTE, omitted: 1 }, T)).toContain(
      'the text above this block is its own. 1 in between is left out.'
    )
    expect(userWordsBlockText({ ...QUOTE, omitted: 4 }, T)).toContain('4 in between are left out.')
    expect(userWordsBlockText({ ...QUOTE, scope: 'since-last', omitted: 2 }, T)).toContain(
      '2 earlier are left out.'
    )
    expect(userWordsBlockText(QUOTE, T)).not.toContain('left out')
  })

  it('UW-3 问题进属性要转义成一行；正文原样', () => {
    const block = userWordsBlockText(
      {
        ...QUOTE,
        words: [
          {
            kind: 'answer',
            ts: 1,
            text: 'a "b" <c> & </answer>',
            question: 'x "y"\n<z> & </answer>'
          }
        ]
      },
      T
    )
    expect(block).toContain('question="x &quot;y&quot; &lt;z&gt; &amp; &lt;/answer&gt;">')
    expect(block).toContain('\na "b" <c> & </answer>\n</answer>')
  })
})

describe('userWordsToken / withUserWords', () => {
  it('UW-4 Token 形状', () => {
    const token = userWordsToken(QUOTE, T)
    expect(token).toEqual({
      type: USER_WORDS_TOKEN_TYPE,
      id: 'P1',
      displayText: '',
      payload: `\n\n${userWordsBlockText(QUOTE, T)}`,
      name: '3'
    })
    expect(isUserWordsToken(token)).toBe(true)
    expect(isUserWordsToken({ type: 'session-sender' })).toBe(false)
    expect(isUserWordsToken(null)).toBe(false)
    expect(isUserWordsToken('user-words')).toBe(false)
    expect(new RegExp(TOKEN_RE.source).test(makeTokenMarker(USER_WORDS_UID))).toBe(true)
  })

  it('UW-5 与已有侧车合并、再接发送方说明；重发逐字往返', () => {
    const at = buildAtToken({ kind: 'file', path: 'src/a.ts' } as never, 'a.ts')
    const before = { content: `看 ${makeTokenMarker('f1')}`, tokens: { f1: at } }
    const brief = resolveTokensForAgent(before.content, before.tokens)
    const quoted = withUserWords(brief, before, QUOTE, T)
    const sender = { kind: 'parent-session' as const, sessionId: 'P1', title: '父' }
    const sent = withSessionSender(quoted.text, quoted.display, sender, { userWords: true })

    const note = sessionSenderNoteText(sender, { userWords: true })
    expect(note).toContain(
      'An agent there wrote this message, not the user — except the <user-words> block, which ShuviX quoted from the user.'
    )
    expect(sessionSenderNoteText(sender)).toContain('An agent there wrote this, not the user.')
    expect(sent.text).toBe(`${brief}\n\n${userWordsBlockText(QUOTE, T)}\n\n${note}`)
    expect(Object.keys(sent.display.tokens).sort()).toEqual(['f1', 'sender', USER_WORDS_UID])
    expect(before.tokens).toEqual({ f1: at })
    expect(resolveTokensForAgent(sent.display.content, sent.display.tokens)).toBe(sent.text)
  })

  it('UW-6 人读出口只留原文', () => {
    const quoted = withUserWords('做这个', undefined, QUOTE, T)
    const sent = withSessionSender(quoted.text, quoted.display, {
      kind: 'parent-session',
      sessionId: 'P1'
    })
    expect(withoutSystemTokens(sent.display.content, sent.display.tokens)).toBe('做这个')
    expect(resolveTokensForCopy(sent.display.content, sent.display.tokens)).toBe('做这个')
    expect(inlineTokensToPlainText(sent.display.content, sent.display.tokens)).toBe('做这个')
  })
})
