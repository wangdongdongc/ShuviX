/**
 * 工具行上「你怎么答的」的记录（toolAnswer.ts）—— 载体是工具结果 details 的保留键，随 toolResult 进会话树：
 * 重开、回退、分叉读的都是这一份。
 *
 * 钉的是这条载体的两端：键名（改名 = 旧记录全读不出）；读取对任何形状都不抛、形状不对的项跳过；写入不动原
 * details、没有记录时原样交回；与「已审查」标记（`shuvixReview`）共用 details 互不覆盖；过一次 JSON 往返照样读得出。
 */
import { describe, expect, it } from 'vitest'
import {
  TOOL_ANSWERS_DETAILS_KEY,
  toolAnswersOf,
  withToolAnswers,
  type ToolAnswerNote
} from './toolAnswer'
import { toolReviewOf, withToolReview } from './toolReview'

const ALLOWED: ToolAnswerNote = { outcome: 'allowed' }
const REMEMBERED: ToolAnswerNote = { outcome: 'remembered', target: '/ws/a.txt' }
const FEEDBACK: ToolAnswerNote = { outcome: 'feedback', text: 'use staging' }

describe('toolAnswer —— details 上的保留键', () => {
  it('TA-1 保留键恒为 shuvixAnswers（它随 toolResult 落盘，改名等于旧记录全读不出）', () => {
    expect(TOOL_ANSWERS_DETAILS_KEY).toBe('shuvixAnswers')
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['字符串', 'details'],
    ['数字', 3],
    ['空对象', {}],
    ['键是字符串', { shuvixAnswers: 'x' }],
    ['键是对象', { shuvixAnswers: {} }]
  ])('TA-2 toolAnswersOf(%s) → []，不抛', (_label, details) => {
    expect(toolAnswersOf(details)).toEqual([])
  })

  it('TA-3 混着坏项的数组：只留下合法的几条，次序不变（结局名大小写敏感）', () => {
    const notes = toolAnswersOf({
      shuvixAnswers: [
        ALLOWED,
        null,
        'denied',
        {},
        { outcome: 'bogus' },
        { outcome: 'ALLOWED' },
        FEEDBACK,
        3,
        { outcome: 'denied' }
      ]
    })
    expect(notes).toStrictEqual([ALLOWED, FEEDBACK, { outcome: 'denied' }])
  })

  it('TA-4 target / text 只认非空字符串，多余的键不带出来', () => {
    expect(
      toolAnswersOf({
        shuvixAnswers: [
          { outcome: 'remembered', target: '' },
          { outcome: 'remembered', target: 3 },
          { outcome: 'feedback', text: '' },
          { outcome: 'denied', foo: 1 }
        ]
      })
    ).toStrictEqual([
      { outcome: 'remembered' },
      { outcome: 'remembered' },
      { outcome: 'feedback' },
      { outcome: 'denied' }
    ])
  })

  it('TA-5 没有记录：原样交回同一个引用（不白造一个 details）', () => {
    const details = { type: 'bash' }
    expect(withToolAnswers(details, [])).toBe(details)
    expect(withToolAnswers(undefined, [])).toBeUndefined()
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['字符串', 'x']
  ])('TA-6 details 是 %s：结果恰好只有这一个键', (_label, details) => {
    expect(withToolAnswers(details as unknown, [REMEMBERED])).toStrictEqual({
      shuvixAnswers: [REMEMBERED]
    })
  })

  it('TA-7 写入不动原 details（冻结的也能写）、自己的键都在；JSON 往返后照样读得出', () => {
    const own = Object.freeze({ type: 'bash', exitCode: 0 })
    const out = withToolAnswers(own, [ALLOWED, FEEDBACK])

    expect(out).not.toBe(own)
    expect(own).toStrictEqual({ type: 'bash', exitCode: 0 })
    expect(out).toStrictEqual({ type: 'bash', exitCode: 0, shuvixAnswers: [ALLOWED, FEEDBACK] })
    expect(toolAnswersOf(JSON.parse(JSON.stringify(out)))).toStrictEqual([ALLOWED, FEEDBACK])
  })

  it('TA-8 与「已审查」标记同在一份 details：两个键都留着，各读各的（先后次序都一样）', () => {
    const review = { risk: 'medium', summary: 's' } as const
    const reviewFirst = withToolAnswers(withToolReview({ type: 'bash' }, review), [ALLOWED])
    const answersFirst = withToolReview(withToolAnswers({ type: 'bash' }, [ALLOWED]), review)

    for (const details of [reviewFirst, answersFirst]) {
      expect(toolReviewOf(details)).toStrictEqual(review)
      expect(toolAnswersOf(details)).toStrictEqual([ALLOWED])
      expect(details).toMatchObject({ type: 'bash' })
    }
  })
})
