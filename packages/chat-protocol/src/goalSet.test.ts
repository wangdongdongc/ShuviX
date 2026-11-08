/**
 * 设定目标的那条消息（goalSet.ts，docs/goal-mode-design.md §3）：模型文本 = 原文 + `<goal-set>` 说明；显示侧车 =
 * 原文 + 一枚「目标」Token。原文是用户的话，说明是系统写的 —— 转写摘要 / 自动审查只该看到原文。
 *
 *   GSM-1 形状：模型文本以原文开头、以 `<goal-set id>` + 说明 + `</goal-set>` 结尾；侧车 = 原文 + 一枚标记；Token 的
 *         displayText / name 是空串；整条不是通知形状（是人的消息）；goalId 里的 `"<>&` 进属性前转义
 *   GSM-2 摘掉系统写的部分：`withoutSystemTokens` 之后逐字是原文；只有目标 Token 时 tokens → undefined；别的 Token
 *         （文件胶囊）留着；插话说明一并摘掉；`isGoalSetToken` 只认 type 'goal'
 *   GSM-3 重新生成的往返：`resolveTokensForAgent(侧车)` 与模型文本逐字相同
 *   GSM-4 `withoutGoalSetNote`（侧车没解析到时的兜底，B-10 修复）：只摘末尾的那一段说明，别的原样
 */
import { describe, expect, it } from 'vitest'
import {
  GOAL_SET_NOTE_TEXT,
  GOAL_SET_TOKEN_TYPE,
  GOAL_SET_UID,
  goalSetMessage,
  isGoalSetToken,
  withoutGoalSetNote
} from './goalSet'
import { MID_RUN_NOTE_UID, midRunNoteDisplay } from './midRunNote'
import { isSystemNoticeText } from './systemNoticeContract'
import { tokensWithoutSystemTokens, withoutSystemTokens } from './triggerEvent'
import type { InlineToken } from './types/chatMessage'
import { buildAtToken, makeTokenMarker, resolveTokensForAgent } from './utils/inlineTokens'

const OBJ = 'Make e2e green'

describe('GSM-1 设定消息的形状', () => {
  it('模型文本 = 原文 + 空行 + <goal-set id> 说明 </goal-set>；侧车 = 原文 + 一枚标记', () => {
    const msg = goalSetMessage({ objective: OBJ, goalId: 'g_1' })
    expect(msg.text).toBe(`${OBJ}\n\n<goal-set id="g_1">${GOAL_SET_NOTE_TEXT}</goal-set>`)
    expect(msg.text.startsWith(OBJ)).toBe(true)
    expect(msg.display.content).toBe(`${OBJ}${makeTokenMarker(GOAL_SET_UID)}`)
    expect(Object.keys(msg.display.tokens)).toEqual([GOAL_SET_UID])
    expect(msg.display.tokens[GOAL_SET_UID]).toStrictEqual({
      type: GOAL_SET_TOKEN_TYPE,
      id: 'g_1',
      displayText: '',
      name: '',
      payload: `\n\n<goal-set id="g_1">${GOAL_SET_NOTE_TEXT}</goal-set>`
    })
  })

  it('整条不是通知形状：它是人的消息（以原文开头）', () => {
    const msg = goalSetMessage({ objective: OBJ, goalId: 'g_1' })
    expect(isSystemNoticeText(msg.text)).toBe(false)
    // 原文本身以尖括号开头也不行：`goal-set` 不是通知标签
    const angled = goalSetMessage({ objective: '<goal-continue>x</goal-continue>', goalId: 'g_1' })
    expect(isSystemNoticeText(angled.text)).toBe(false)
  })

  it('goalId 里的 " < > & 进属性前转义', () => {
    const msg = goalSetMessage({ objective: OBJ, goalId: 'a"b<c>d&e' })
    expect(msg.text).toContain('<goal-set id="a&quot;b&lt;c&gt;d&amp;e">')
    expect(msg.text).not.toContain('a"b')
  })
})

describe('GSM-2 摘要只留用户的话', () => {
  it('withoutSystemTokens 之后逐字是原文；只有目标 Token 时 tokens → undefined', () => {
    const { display } = goalSetMessage({ objective: OBJ, goalId: 'g_1' })
    const stripped = withoutSystemTokens(display.content, display.tokens)
    expect(stripped).toBe(OBJ)
    expect(stripped).not.toContain('<goal-set')
    expect(stripped).not.toContain(GOAL_SET_NOTE_TEXT)
    expect(tokensWithoutSystemTokens(display.tokens)).toBeUndefined()
  })

  it('别的 Token（文件胶囊）连同标记留着；插话说明一并摘掉', () => {
    const { display } = goalSetMessage({ objective: OBJ, goalId: 'g_1' })
    const file: InlineToken = buildAtToken({ kind: 'file', rel: 'src/a.ts', base: 'a.ts' })
    const content = `${display.content}${makeTokenMarker('f1')}`
    const tokens = { ...display.tokens, f1: file }
    expect(withoutSystemTokens(content, tokens)).toBe(`${OBJ}${makeTokenMarker('f1')}`)
    expect(tokensWithoutSystemTokens(tokens)).toStrictEqual({ f1: file })

    const busy = midRunNoteDisplay(OBJ, display)
    expect(Object.keys(busy.tokens).sort()).toEqual([GOAL_SET_UID, MID_RUN_NOTE_UID].sort())
    expect(withoutSystemTokens(busy.content, busy.tokens)).toBe(OBJ)
    expect(tokensWithoutSystemTokens(busy.tokens)).toBeUndefined()
  })

  it('isGoalSetToken 只看 type', () => {
    expect(isGoalSetToken({ type: 'goal', id: 'x', displayText: 'y', payload: 'z' })).toBe(true)
    expect(isGoalSetToken({ type: 'goal' })).toBe(true)
    expect(isGoalSetToken({ type: 'note', id: 'mid-run' })).toBe(false)
    expect(isGoalSetToken({ type: 'trigger' })).toBe(false)
    expect(isGoalSetToken(null)).toBe(false)
    expect(isGoalSetToken('goal')).toBe(false)
  })
})

describe('GSM-3 重新生成的往返', () => {
  it.each([
    ['plain', OBJ],
    ['multi-line', 'line one\nline two\n\nthree'],
    ['$ forms', "cost $& and $1 and $'"],
    ['placeholder', 'token {{API_KEY_abcdefgh}} rotate'],
    ['CJK', '让 e2e 全绿']
  ])('%s：侧车展开回来与模型文本逐字相同', (_label, objective) => {
    const msg = goalSetMessage({ objective, goalId: 'g_9' })
    expect(resolveTokensForAgent(msg.display.content, msg.display.tokens)).toBe(msg.text)
  })
})

describe('GSM-4 withoutGoalSetNote（侧车没解析到时的兜底）', () => {
  it('摘掉末尾的说明，剩原文；没有说明的原样；说明不在末尾不摘', () => {
    const msg = goalSetMessage({ objective: OBJ, goalId: 'g_1' })
    expect(withoutGoalSetNote(msg.text)).toBe(OBJ)
    expect(withoutGoalSetNote(OBJ)).toBe(OBJ)
    const notAtEnd = `${msg.text}\nand more`
    expect(withoutGoalSetNote(notAtEnd)).toBe(notAtEnd)
    const multi = goalSetMessage({ objective: 'a\n\nb', goalId: 'g_2' })
    expect(withoutGoalSetNote(multi.text)).toBe('a\n\nb')
  })
})
