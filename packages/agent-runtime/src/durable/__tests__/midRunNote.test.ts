/**
 * 运行中插话的说明（`midRunNote.ts`，docs/task-list-design.md §2）—— 纯函数 `withMidRunNote`：一条忙时插话
 * → 模型看到的内容（原文 + 分隔 + 说明，带图的在最后加一个文本块）+ 显示侧车（原文 + 说明 Token 的标记）。
 *
 *   MRN-R-1 字符串：说明拼在末尾；显示侧车 = midRunNoteDisplay(原文)
 *   MRN-R-2 文本 + 图 + 文本：说明是最后一个文本块；图片原位、同一个对象；不改入参；侧车原文按 userText 的口径
 *   MRN-R-3 只有图：说明块跟在图后；侧车只有标记
 *   MRN-R-4 空串：模型文本只有说明；侧车只有标记
 *   MRN-R-5 写的与读的同一口径：userText(结果) 以说明结尾（taskListReader 的判据），且不是通知形状
 *   MRN-R-6 通知形状的插话（PIN-16）→ undefined：那是系统写的话，不加说明
 */
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import type { UserInput } from '@earendil-works/pi-durable'
import {
  MID_RUN_NOTE_SEPARATOR,
  MID_RUN_NOTE_TEXT,
  MID_RUN_NOTE_UID,
  midRunNoteDisplay
} from '@shuvix/chat-protocol/midRunNote'
import { isSystemNoticeText } from '@shuvix/chat-protocol/systemNoticeContract'
import { makeTokenMarker } from '@shuvix/chat-protocol/utils/inlineTokens'
import { describe, expect, it } from 'vitest'
import { withMidRunNote } from '../midRunNote'
import { userText } from '../projection/entryText'
import { bg } from './support/digest'

const SUFFIX = `${MID_RUN_NOTE_SEPARATOR}${MID_RUN_NOTE_TEXT}`
const MARKER = makeTokenMarker(MID_RUN_NOTE_UID)
const IMAGE: ImageContent = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }
const text = (value: string): TextContent => ({ type: 'text', text: value })

function noted(content: UserInput): { content: UserInput; display: unknown } {
  const result = withMidRunNote(content)
  expect(result).toBeDefined()
  return result!
}

describe('withMidRunNote', () => {
  it('MRN-R-1 a string: the note goes at the end; the display sidecar is midRunNoteDisplay(text)', () => {
    const result = noted('S')
    expect(result.content).toBe(`S${SUFFIX}`)
    expect(result.display).toStrictEqual(midRunNoteDisplay('S'))
  })

  it('MRN-R-2 text + image + text: the note is the last block, the image keeps its place and identity, the input is not mutated, the display joins text blocks with no separator', () => {
    const input: UserInput = [text('a'), IMAGE, text('b')]
    const before = structuredClone(input)
    const result = noted(input)
    expect(result.content).toStrictEqual([text('a'), IMAGE, text('b'), text(SUFFIX)])
    expect((result.content as unknown[])[1]).toBe(IMAGE)
    expect(result.content).not.toBe(input)
    expect(input).toStrictEqual(before)
    expect(result.display).toStrictEqual(midRunNoteDisplay('ab'))
    expect((result.display as { content: string }).content).toBe(`ab${MARKER}`)
  })

  it('MRN-R-3 an image-only array: the note block follows the image; the display holds only the marker', () => {
    const result = noted([IMAGE])
    expect(result.content).toStrictEqual([IMAGE, text(SUFFIX)])
    expect((result.display as { content: string }).content).toBe(MARKER)
  })

  it('MRN-R-4 an empty string: the model text is the note alone; the display holds only the marker', () => {
    const result = noted('')
    expect(result.content).toBe(SUFFIX)
    expect((result.display as { content: string }).content).toBe(MARKER)
  })

  it.each([
    ['a string', 'S' as UserInput],
    ['an empty string', '' as UserInput],
    ['text + image + text', [text('a'), IMAGE, text('b')] as UserInput],
    ['an image only', [IMAGE] as UserInput],
    ['CJK and newlines', '先停一下\n改用 B 方案' as UserInput]
  ])(
    'MRN-R-5 writer and reader agree (%s): userText ends with the note suffix and is not notice-shaped',
    (_label, content) => {
      const result = noted(content)
      const seen = userText(result.content)
      expect(seen.endsWith(SUFFIX)).toBe(true)
      expect(isSystemNoticeText(seen)).toBe(false)
    }
  )

  it.each([
    ['a background-task block', bg('t1', 'done')],
    ['a session block', '<session id="s2" status="done">ok</session>'],
    ['two notice blocks', `${bg('t1', 'a')}\n${bg('t2', 'b')}`],
    ['a notice block as an array', [text(bg('t1', 'done'))] as UserInput]
  ])(
    'MRN-R-6 a notice-shaped input (%s) gets no note: withMidRunNote returns undefined',
    (_label, content) => {
      expect(isSystemNoticeText(userText(content as UserInput))).toBe(true)
      expect(withMidRunNote(content as UserInput)).toBeUndefined()
    }
  )
})
