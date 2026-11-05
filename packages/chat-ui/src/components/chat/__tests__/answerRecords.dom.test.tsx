// @vitest-environment jsdom
/**
 * 答完之后留在对话里的记录（AnswerRecords，jsdom）—— 只读。
 *
 *   ToolAnswerLines（AR-1..9、AR-R1）：审批卡片上人的决定，一次调用过几道门就有几行；图标、文字、占位符（记住的目标也走
 *   RedactedText）；三种语言的文案都在。
 *   AskRecord（AR-10..23）：问题 + 答案；别的会话写的不叫「你的回答」，由代答标记说明是谁；真没选显示本地化的一句，
 *   旧会话的「其它」回答（只在结果文字里）原样显示；其余选项可以展开；落盘的坏形状不崩。
 *
 * 占位符的后端是注入的 SessionChannelApi（查不到真值，只看显示的是不是标记）；i18n 走真资源，缺省 en；
 * 文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { SessionChannelApi } from '@shuvix/chat-protocol/chatApi'
import type { AskToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type { ToolAnswerNote } from '@shuvix/chat-protocol/types/toolAnswer'
import { setSessionChannelApi } from '../../../api/chatApi'
import { resetRedactionCacheForTests } from '../../../stores/redactionCache'
import { ChatHostContext, type ChatHostValue } from '../../../host/chatHostContext'
import { AskRecord, ToolAnswerLines } from '../AnswerRecords'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PLACEHOLDER = '{{REDACTED_API_KEY_k3v7x2mq}}'
const NEW_KEYS = [
  'jumpAsk',
  'jumpChoice',
  'answerAllowed',
  'answerRemembered',
  'answerDenied',
  'answerFeedback',
  'recordYourAnswer',
  'recordNoSelection',
  'recordShowOptions',
  'recordHideOptions'
] as const

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en }, zh: { translation: zh }, ja: { translation: ja } },
    showSupportNotice: false
  })
  setSessionChannelApi({
    redaction: { resolve: async () => ({}) },
    events: { subscribe: () => () => {} }
  } as unknown as SessionChannelApi)
})

beforeEach(async () => {
  resetRedactionCacheForTests()
  await i18n.changeLanguage('en')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(el: ReturnType<typeof createElement>): void {
  act(() => {
    root.render(el)
  })
}

const lines = (notes: ToolAnswerNote[]): void => render(createElement(ToolAnswerLines, { notes }))
const line = (outcome: string): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-tool-answer="${outcome}"]`)!
const chips = (scope: ParentNode = container): Element[] => [
  ...scope.querySelectorAll('[data-redaction-placeholder]')
]

describe('ToolAnswerLines', () => {
  it('AR-1 允许一次：文字与对勾', () => {
    lines([{ outcome: 'allowed' }])
    expect(line('allowed').textContent).toBe('You allowed this once')
    expect(line('allowed').querySelector('svg.lucide-check')).not.toBeNull()
  })

  it('AR-2 记住：文字 + 等宽字体的目标', () => {
    lines([{ outcome: 'remembered', target: '/ws/docs' }])
    const el = line('remembered')
    expect(el.textContent).toContain('You allowed this and remembered')
    const mono = el.querySelector('.font-mono')
    expect(mono?.textContent).toBe('/ws/docs')
    expect(el.querySelector('svg.lucide-check')).not.toBeNull()
  })

  it('AR-3 记住、没有目标（还原过占位符的调用）：只有文字，没有空的等宽段', () => {
    lines([{ outcome: 'remembered' }])
    expect(line('remembered').textContent).toBe('You allowed this and remembered')
    expect(line('remembered').querySelector('.font-mono')).toBeNull()
  })

  it('AR-R1 记住的目标是占位符（工具输出脱敏之后）：显示成标记，不是裸字符串的 span', () => {
    lines([{ outcome: 'remembered', target: `/ws/${PLACEHOLDER}/a` }])
    const mono = line('remembered').querySelector<HTMLElement>('.font-mono')!
    expect(chips(mono)).toHaveLength(1)
    expect(chips(mono)[0]!.getAttribute('data-redaction')).toBe('API_KEY')
    expect(mono.textContent).toContain('/ws/')
    expect(mono.textContent).toContain('/a')
  })

  it('AR-4 拒绝：文字与红叉', () => {
    lines([{ outcome: 'denied' }])
    expect(line('denied').textContent).toBe('You denied this')
    expect(line('denied').querySelector('svg.lucide-x')).not.toBeNull()
  })

  it('AR-5 反馈：文字 + 多行原文（pre-wrap），红叉', () => {
    lines([{ outcome: 'feedback', text: 'first\nsecond' }])
    const el = line('feedback')
    expect(el.textContent).toBe("You didn't approve and replied: first\nsecond")
    expect(el.querySelector('.whitespace-pre-wrap')?.textContent).toBe('first\nsecond')
    expect(el.querySelector('svg.lucide-x')).not.toBeNull()
  })

  it('AR-6 反馈里的占位符显示成标记', () => {
    lines([{ outcome: 'feedback', text: `use ${PLACEHOLDER} instead` }])
    expect(chips(line('feedback'))).toHaveLength(1)
  })

  it('AR-7 三条：三行，次序不变', () => {
    lines([{ outcome: 'allowed' }, { outcome: 'remembered', target: '/x' }, { outcome: 'denied' }])
    expect(
      [...container.querySelectorAll('[data-tool-answer]')].map((el) =>
        el.getAttribute('data-tool-answer')
      )
    ).toEqual(['allowed', 'remembered', 'denied'])
  })

  it('AR-8 没有记录：什么都不画', () => {
    lines([])
    expect(container.innerHTML).toBe('')
  })

  it.each(['zh', 'ja'])('AR-9 %s：显示本地化的文字，不是英文，也不是键名', async (lng) => {
    await i18n.changeLanguage(lng)
    lines([{ outcome: 'allowed' }])
    const text = line('allowed').textContent!
    expect(text).not.toBe('You allowed this once')
    expect(text).not.toContain('pendingInputs.')
  })

  it.each([
    ['en', en],
    ['zh', zh],
    ['ja', ja]
  ])('AR-9 %s：十条新文案都在', (_lng, locale) => {
    const table = locale.pendingInputs as Record<string, string>
    for (const key of NEW_KEYS) expect(table[key], key).toBeTruthy()
  })
})

const DETAILS = (over: Partial<AskToolDetails> = {}): AskToolDetails => ({
  type: 'ask',
  question: 'Which style?',
  selections: ['Terse'],
  ...over
})
const ARGS = {
  options: [
    { label: 'Terse', description: 'Short answers' },
    { label: 'Verbose', description: '' },
    { label: 'Funny', description: 'Jokes' }
  ]
}

function record(
  details: AskToolDetails,
  args: unknown = undefined,
  result?: string,
  density?: 'touch'
): void {
  const el = createElement(AskRecord, { details, args, result })
  render(
    density
      ? createElement(ChatHostContext.Provider, { value: { density } as ChatHostValue }, el)
      : el
  )
}
const q = (selector: string): HTMLElement | null => container.querySelector<HTMLElement>(selector)
const all = (selector: string): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>(selector)
]
const toggle = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('[data-ask-record-toggle]')
const legacyOtherText = (): string | undefined =>
  all('[data-ask-record] > div').find(
    (el) =>
      el.classList.contains('whitespace-pre-wrap') && !el.hasAttribute('data-ask-record-other')
  )?.textContent ?? undefined

describe('AskRecord', () => {
  it('AR-10 一个选择：问题 + 一行答案', () => {
    record(DETAILS())
    expect(q('[data-ask-record]')!.textContent).toContain('Which style?')
    expect(all('[data-ask-record-selection]').map((el) => el.textContent)).toEqual(['Terse'])
    expect(q('[data-ask-record-none]')).toBeNull()
    expect(q('[data-ask-record-other]')).toBeNull()
  })

  it('AR-11 多选：两行，次序不变', () => {
    record(DETAILS({ selections: ['B', 'A'] }))
    expect(all('[data-ask-record-selection]').map((el) => el.textContent)).toEqual(['B', 'A'])
  })

  it('AR-12 自己写的：「Your answer:」+ 原文，不再画旧会话那一段', () => {
    record(DETAILS({ selections: [], other: 'be funny' }), undefined, 'User responded: be funny')
    expect(q('[data-ask-record-other]')!.textContent).toBe('Your answer: be funny')
    expect(legacyOtherText()).toBeUndefined()
    expect(q('[data-ask-record-none]')).toBeNull()
  })

  it('AR-12b 勾了又写：选项与那句话都在，不算旧会话', () => {
    record(
      DETAILS({ selections: ['A'], other: 'only the frontend' }),
      undefined,
      'User selected: A\nUser also wrote:\nonly the frontend'
    )
    expect(all('[data-ask-record-selection]').map((el) => el.textContent)).toEqual(['A'])
    expect(q('[data-ask-record-other]')!.textContent).toBe('Your answer: only the frontend')
    expect(legacyOtherText()).toBeUndefined()
  })

  it('AR-13 别的会话写的：有代答标记，不叫「Your answer」', () => {
    record(
      DETAILS({
        selections: [],
        other: 'use staging',
        answeredBy: { sessionId: 'p', title: 'Parent', kind: 'parent-session' }
      })
    )
    const other = q('[data-ask-record-other]')!
    expect(other.textContent).toBe('use staging')
    expect(other.textContent).not.toContain('Your answer')
    expect(q('[data-ask-record-by] [data-answered-by="parent-session"]')).not.toBeNull()
  })

  const LEGACY = 'User responded with feedback instead of selecting: use the other one'

  it('AR-14 旧会话：没选、没 other、结果是别的文字 → 原样显示，不算写了回答，也不算没选', () => {
    record(DETAILS({ selections: [] }), undefined, LEGACY)
    expect(legacyOtherText()).toBe(LEGACY)
    expect(q('[data-ask-record-other]')).toBeNull()
    expect(q('[data-ask-record-none]')).toBeNull()
  })

  it.each([
    ['User made no selection', 'User made no selection'],
    ['带句号（代答的写法）', 'The parent session answered. It made no selection.'],
    ['结果为空', '']
  ])('AR-15 真没选（%s）：显示本地化的一句，不漏英文', async (_label, result) => {
    await i18n.changeLanguage('zh')
    record(DETAILS({ selections: [] }), undefined, result)
    expect(q('[data-ask-record-none]')!.textContent).toBe(zh.pendingInputs.recordNoSelection)
    expect(legacyOtherText()).toBeUndefined()
    expect(q('[data-ask-record]')!.textContent).not.toContain('made no selection')
  })

  it('AR-15 没有结果文字（undefined）也算没选', () => {
    record(DETAILS({ selections: [] }))
    expect(q('[data-ask-record-none]')!.textContent).toBe('No option selected')
  })

  it.each(['session', 'parent-session'] as const)(
    'AR-16 选择 + 代答（%s）：标记说明是谁；不带 answeredBy 时没有标记',
    (kind) => {
      record(DETAILS({ answeredBy: { sessionId: 's', title: 'T', kind } }))
      const badge = q('[data-ask-record-by] [data-answered-by]')!
      expect(badge.getAttribute('data-answered-by')).toBe(kind)
      expect(badge.textContent).toBe(
        kind === 'session' ? en.toolCall.answeredBySessionTag : en.toolCall.answeredByParentTag
      )

      record(DETAILS())
      expect(q('[data-ask-record-by]')).toBeNull()
    }
  )

  it('AR-17 选项：收着时只有开关，点开三行，再点收起', () => {
    record(DETAILS(), ARGS)
    expect(toggle()!.textContent).toBe('Show all 3 options')
    expect(q('[data-ask-record-options]')).toBeNull()

    act(() => toggle()!.click())
    expect(toggle()!.textContent).toBe('Hide options')
    expect(all('[data-ask-record-options] li')).toHaveLength(3)

    act(() => toggle()!.click())
    expect(toggle()!.textContent).toBe('Show all 3 options')
    expect(q('[data-ask-record-options]')).toBeNull()
  })

  it('AR-18 展开的列表：对勾只在选中的上；说明显示；没有说明的没有那一段', () => {
    record(DETAILS({ selections: ['Terse', 'Funny'] }), ARGS)
    act(() => toggle()!.click())
    const rows = all('[data-ask-record-options] li')
    expect(rows.map((row) => row.querySelector('svg.lucide-check') !== null)).toEqual([
      true,
      false,
      true
    ])
    expect(rows[0]!.textContent).toBe('TerseShort answers')
    expect(rows[1]!.textContent).toBe('Verbose')
    expect(rows[1]!.querySelectorAll('span.block')).toHaveLength(1)
  })

  it.each([
    ['undefined', undefined],
    ['字符串', 'x'],
    ['options 是字符串', { options: 'x' }],
    ['options 全是坏项', { options: [null, 3, { label: 1 }] }]
  ])('AR-19 参数形状不对（%s）：没有开关，不崩', (_label, args) => {
    record(DETAILS(), args)
    expect(toggle()).toBeNull()
    expect(all('[data-ask-record-selection]')).toHaveLength(1)
  })

  it('AR-20 部分坏项：跳过坏的，计数只数好的', () => {
    record(DETAILS(), { options: [{ label: 'Good' }, null, 3, { label: 2 }, { label: 'Also' }] })
    expect(toggle()!.textContent).toBe('Show all 2 options')
    act(() => toggle()!.click())
    expect(all('[data-ask-record-options] li').map((li) => li.textContent)).toEqual([
      'Good',
      'Also'
    ])
  })

  it.each([
    ['缺 selections', { type: 'ask', question: 'q' }],
    ['selections 是字符串', { type: 'ask', question: 'q', selections: 'x' }],
    ['selections 是空数组', { type: 'ask', question: 'q', selections: [] }]
  ])('AR-21 落盘的坏形状（%s）：不抛，按没选', (_label, details) => {
    record(details as unknown as AskToolDetails)
    expect(q('[data-ask-record]')!.textContent).toContain('q')
    expect(q('[data-ask-record-none]')).not.toBeNull()
    expect(all('[data-ask-record-selection]')).toHaveLength(0)
  })

  it('AR-22 问题、选择、other、选项文字里的占位符都显示成标记', () => {
    record(
      DETAILS({ question: `Q ${PLACEHOLDER}`, selections: [PLACEHOLDER], other: PLACEHOLDER }),
      { options: [{ label: PLACEHOLDER, description: PLACEHOLDER }] }
    )
    act(() => toggle()!.click())
    // 问题、选择、other、选项标题、选项说明
    expect(chips()).toHaveLength(5)
  })

  it('AR-23 触屏档：开关 min-h-8，卡片 text-sm；紧凑档没有', () => {
    record(DETAILS(), ARGS, undefined, 'touch')
    expect(toggle()!.classList.contains('min-h-8')).toBe(true)
    expect(q('[data-ask-record]')!.classList.contains('text-sm')).toBe(true)

    record(DETAILS(), ARGS)
    expect(toggle()!.classList.contains('min-h-8')).toBe(false)
    expect(q('[data-ask-record]')!.classList.contains('text-sm')).toBe(false)
  })
})
