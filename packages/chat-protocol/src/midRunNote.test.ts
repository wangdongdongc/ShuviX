/**
 * 运行中插话的说明（`midRunNote.ts`，docs/task-list-design.md §2）—— 会话正忙时插进来的一条用户消息，模型文本
 * 末尾带一段固定说明，显示侧车里是一枚说明 Token。这里钉的是数据形状与几个读写函数：
 *
 *   MRN-1 常量：Token 的 type / id / uid / 分隔与说明文本逐字；说明不提任务列表；uid 能被 TOKEN_RE 认出
 *   MRN-2 `midRunNoteToken()`：形状逐字；每次交回新对象
 *   MRN-3 `isMidRunNoteToken`：只看 type / id（大小写敏感），别的值一律 false
 *   MRN-4 `midRunNoteDisplay`：原文 + 标记（中间没有分隔）；原文里的外来标记原样；多行 / CJK 逐字
 *   MRN-5 `hasMidRunNote`：只认说明 Token，与 uid 无关；非 Token 值不抛
 *   MRN-6 `tokensWithoutMidRunNote`：没有说明 → 同一引用；只剩说明 → undefined；不改输入
 *   MRN-7 `withoutMidRunNote`：只摘说明的标记，不 trim；别的 / 未知 uid 的标记留着；重复调用结果相同
 *   MRN-8 往返：`withoutMidRunNote(display.content, display.tokens)` 还原原文
 */
import { describe, expect, it } from 'vitest'
import {
  MID_RUN_NOTE_SEPARATOR,
  MID_RUN_NOTE_TEXT,
  MID_RUN_NOTE_TOKEN_ID,
  MID_RUN_NOTE_TOKEN_TYPE,
  MID_RUN_NOTE_UID,
  hasMidRunNote,
  isMidRunNoteToken,
  midRunNoteDisplay,
  midRunNoteToken,
  tokensWithoutMidRunNote,
  withoutMidRunNote
} from './midRunNote'
import type { InlineToken } from './types/chatMessage'
import { TOKEN_RE, buildPasteToken, makeTokenMarker } from './utils/inlineTokens'

// ─── 夹具 ───────────────────────────────────────────────

const NOTE =
  '[Sent while you were working. Address it and carry on with your current work, unless it changes or stops that work. If you had already finished, just respond to it.]'
const MARKER = '{{shuvixInlineToken:midrun}}'
const NOTE_TOKEN: InlineToken = {
  type: 'note',
  id: 'mid-run',
  displayText: '',
  payload: NOTE
}

const pasteToken: InlineToken = buildPasteToken({
  payload: 'line1\nline2',
  displayText: '[pasted #1]',
  seq: 1,
  name: 'pasted #1'
})

// ─── 用例 ───────────────────────────────────────────────

describe('常量', () => {
  it('MRN-1 type / id / uid / 分隔与说明文本逐字', () => {
    expect(MID_RUN_NOTE_TOKEN_TYPE).toBe('note')
    expect(MID_RUN_NOTE_TOKEN_ID).toBe('mid-run')
    expect(MID_RUN_NOTE_UID).toBe('midrun')
    expect(MID_RUN_NOTE_SEPARATOR).toBe('\n\n')
    expect(MID_RUN_NOTE_TEXT).toBe(NOTE)
  })

  it('MRN-1 说明不提任务列表（列表的规矩写在列表工具自己的描述里，§2.3）', () => {
    expect(MID_RUN_NOTE_TEXT).not.toMatch(/\b(task list|plan|list)\b/i)
  })

  it('MRN-1 uid 能被 Token 标记的正则认出：makeTokenMarker(uid) 经 TOKEN_RE 往返', () => {
    const marker = makeTokenMarker(MID_RUN_NOTE_UID)
    expect(marker).toBe(MARKER)
    // 用一份新的 RegExp：TOKEN_RE 带 /g，共享它的 lastIndex 会让断言依赖调用顺序
    const match = new RegExp(TOKEN_RE.source).exec(marker)
    expect(match?.[0]).toBe(marker)
    expect(match?.[1]).toBe(MID_RUN_NOTE_UID)
  })
})

describe('midRunNoteToken', () => {
  it('MRN-2 形状逐字；两次调用是两个对象，改一个不影响下一次', () => {
    const first = midRunNoteToken()
    expect(first).toStrictEqual(NOTE_TOKEN)
    const second = midRunNoteToken()
    expect(second).not.toBe(first)
    first.payload = 'hacked'
    first.displayText = 'hacked'
    expect(midRunNoteToken()).toStrictEqual(NOTE_TOKEN)
  })
})

describe('isMidRunNoteToken', () => {
  it('MRN-3 只看 type 与 id：displayText / payload 是什么都算', () => {
    expect(isMidRunNoteToken(NOTE_TOKEN)).toBe(true)
    expect(
      isMidRunNoteToken({ type: 'note', id: 'mid-run', displayText: 'whatever', payload: 'x' })
    ).toBe(true)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['字符串', 'note'],
    ['数字', 42],
    ['数组', []],
    ['空对象', {}],
    ['id 不对', { type: 'note', id: 'other' }],
    ['type 不对', { type: 'at', id: 'mid-run' }],
    ['大小写不同', { type: 'Note', id: 'mid-run' }]
  ])('MRN-3 %s → false', (_label, value) => {
    expect(isMidRunNoteToken(value)).toBe(false)
  })
})

describe('midRunNoteDisplay', () => {
  it('MRN-4 原文 + 标记，中间没有分隔；tokens 只有 midrun 这一枚', () => {
    expect(midRunNoteDisplay('S')).toStrictEqual({
      content: `S${MARKER}`,
      tokens: { midrun: NOTE_TOKEN }
    })
  })

  it('MRN-4 空串 → 只有标记', () => {
    expect(midRunNoteDisplay('').content).toBe(MARKER)
  })

  it('MRN-4 原文里已有的外来标记原样留着；tokens 里只有 midrun', () => {
    const text = 'a {{shuvixInlineToken:p1}} b'
    const display = midRunNoteDisplay(text)
    expect(display.content).toBe(`${text}${MARKER}`)
    expect(Object.keys(display.tokens)).toEqual(['midrun'])
  })

  it('MRN-4 多行与 CJK 原文逐字保留', () => {
    for (const text of ['line 1\nline 2\n\n  indented', '先改登录页，再跑测试']) {
      expect(midRunNoteDisplay(text).content).toBe(`${text}${MARKER}`)
    }
  })
})

describe('hasMidRunNote', () => {
  it('MRN-5 undefined / 空 / 只有别的 Token → false', () => {
    expect(hasMidRunNote(undefined)).toBe(false)
    expect(hasMidRunNote({})).toBe(false)
    expect(hasMidRunNote({ p1: pasteToken })).toBe(false)
  })

  it('MRN-5 说明 Token 挂在哪个 uid 下都算', () => {
    expect(hasMidRunNote({ x: NOTE_TOKEN })).toBe(true)
    expect(hasMidRunNote({ p1: pasteToken, midrun: NOTE_TOKEN })).toBe(true)
  })

  it('MRN-5 非 Token 值 → false，不抛', () => {
    expect(() => hasMidRunNote({ a: null })).not.toThrow()
    expect(hasMidRunNote({ a: null, b: 'note', c: 3 })).toBe(false)
  })
})

describe('tokensWithoutMidRunNote', () => {
  it('MRN-6 undefined → undefined', () => {
    expect(tokensWithoutMidRunNote(undefined)).toBeUndefined()
  })

  it('MRN-6 没有说明 → 同一个引用', () => {
    const tokens = { p1: pasteToken }
    expect(tokensWithoutMidRunNote(tokens)).toBe(tokens)
  })

  it('MRN-6 只有说明 → undefined', () => {
    expect(tokensWithoutMidRunNote({ midrun: NOTE_TOKEN })).toBeUndefined()
  })

  it('MRN-6 说明 + p1 → 只剩 p1 的新对象；输入不变', () => {
    const tokens = { midrun: NOTE_TOKEN, p1: pasteToken }
    const kept = tokensWithoutMidRunNote(tokens)
    expect(kept).toStrictEqual({ p1: pasteToken })
    expect(kept).not.toBe(tokens)
    expect(tokens).toStrictEqual({ midrun: NOTE_TOKEN, p1: pasteToken })
  })

  it('MRN-6 两个 uid 下各一枚说明 → 都去掉', () => {
    expect(
      tokensWithoutMidRunNote({ midrun: NOTE_TOKEN, other: { ...NOTE_TOKEN }, p1: pasteToken })
    ).toStrictEqual({ p1: pasteToken })
  })
})

describe('withoutMidRunNote', () => {
  const tokens = { midrun: NOTE_TOKEN }

  it('MRN-7 摘掉说明的标记，前后文本不 trim', () => {
    expect(withoutMidRunNote(`S ${MARKER}`, tokens)).toBe('S ')
  })

  it('MRN-7 别的 Token 的标记、未知 uid 的标记都留着', () => {
    const content = `a {{shuvixInlineToken:p1}} b {{shuvixInlineToken:zz}}${MARKER}`
    expect(withoutMidRunNote(content, { ...tokens, p1: pasteToken })).toBe(
      'a {{shuvixInlineToken:p1}} b {{shuvixInlineToken:zz}}'
    )
  })

  it('MRN-7 tokens 是 undefined → 原样', () => {
    expect(withoutMidRunNote(`S${MARKER}`, undefined)).toBe(`S${MARKER}`)
  })

  it('MRN-7 tokens 里没有说明 → 原样，哪怕字面上写着 midrun 标记', () => {
    expect(withoutMidRunNote(`S${MARKER}`, { p1: pasteToken })).toBe(`S${MARKER}`)
  })

  it('MRN-7 说明标记出现两次 → 两处都摘掉', () => {
    expect(withoutMidRunNote(`${MARKER}a${MARKER}b`, tokens)).toBe('ab')
  })

  it('MRN-7 连着调用两次结果相同（/g 正则的 lastIndex 不会漏到下一次）', () => {
    const content = `x${MARKER}`
    const first = withoutMidRunNote(content, tokens)
    const second = withoutMidRunNote(content, tokens)
    expect(first).toBe('x')
    expect(second).toBe(first)
  })
})

describe('往返', () => {
  it.each(['', 'S', 'S  ', 'a\nb', '中文', '{{x}}', 'a {{shuvixInlineToken:p1}}'])(
    'MRN-8 %j：withoutMidRunNote(midRunNoteDisplay(text)) === text',
    (text) => {
      const display = midRunNoteDisplay(text)
      expect(withoutMidRunNote(display.content, display.tokens)).toBe(text)
    }
  )
})
