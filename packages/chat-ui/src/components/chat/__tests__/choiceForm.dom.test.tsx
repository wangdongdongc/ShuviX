// @vitest-environment jsdom
/**
 * 选项题卡片（inputs/ChoiceForm）：问题在上，下面一列带序号的选项行，勾选 + 确认；桌面上数字键勾行。
 *
 *   CF-1  `[data-choice-question]` 是问题；问题之后、第一行之前有一行恰是 pendingInputs.choiceHint；行
 *         `[data-choice-option]` A / B / C，序号 1 / 2 / 3，都 aria-pressed="false"；A、C 各带说明，B（说明为空）
 *         没有；没有 detail 就没有 <pre>
 *   CF-2  确认键 `[data-choice-confirm]` 起初禁用、字恰是 Confirm；点它不交
 *   CF-3  点 B → 勾上（aria-pressed true、序号换对勾）、确认可点「Confirm (1)」；再点 C →「Confirm (2)」；再点 B →
 *         勾掉、2 回来、「Confirm (1)」；点行从不交答复
 *   CF-4  先勾 C 再勾 A，确认 → 恰一次 {kind:'choice', selections:['C','A']}（按点的先后）
 *   CF-5  紧凑档、焦点在 body：2 勾 B、再 2 勾掉；1 再 3 →「Confirm (2)」；4 什么都不做；从不交
 *   CF-6  触屏档：数字键什么都不做，点行照常勾；确认键 flex-1 h-10（只断 class）
 *   CF-7  焦点在卡片外的 textarea 里按 1 → 不勾
 *   CF-8  detail 'ctx' → 一个 <pre> 写着 ctx，在提示行之后、第一行之前
 *   CF-9  （只断结构）选项行所在的 `.overflow-y-auto` 里有 <pre> 与每一行，没有问题、提示、确认键
 *   CF-10 选项行在一个 `[role=group]` 里，aria-label = 问题
 *   CF-11 titleAccessory 在问题那一行（`[data-choice-question]` 的父节点）里、在问题之后
 *   CF-12 十二个选项：序号 1…12；1 只勾第一行；0 什么都不做
 *   CF-13 草稿是 {}（没有 selected）→ 什么都没勾、确认禁用
 *   CF-14 没有选项：没有行、确认禁用、1 什么都不做、不抛
 *   CF-15 （只断 class）禁用的确认键 bg-bg-secondary text-text-tertiary、没有 bg-accent；可点时 bg-accent
 *
 * 草稿由一层有状态的包装持有（useState，setDraft 当 onDraftChange），onSubmit 是 spy；i18n 走真 en 资源。按键在
 * 目标元素上派发（bubbles + cancelable + composed），每一下各自一个 act（勾选读的是上一次渲染的 selected）。
 * 文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { ChoiceInputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { ChoiceForm } from '../inputs/ChoiceForm'
import type { ChoiceDraft } from '../inputs/drafts'
import { ChatHostContext, type ChatHostValue } from '../../../host/chatHostContext'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

const choice = (extra: Partial<ChoiceInputRequest> = {}): ChoiceInputRequest => ({
  id: 'r3',
  kind: 'choice',
  toolName: 'ask',
  question: 'Which?',
  options: [
    { label: 'A', description: 'first' },
    { label: 'B', description: '' },
    { label: 'C', description: 'third' }
  ],
  createdAt: 0,
  ...extra
})

function Wrapper({
  request,
  onSubmit,
  initial,
  accessory
}: {
  request: ChoiceInputRequest
  onSubmit: (response: InputResponse) => void
  initial: ChoiceDraft
  accessory?: ReturnType<typeof createElement>
}): React.JSX.Element {
  const [draft, setDraft] = useState<ChoiceDraft>(initial)
  return createElement(ChoiceForm, {
    request,
    draft,
    onDraftChange: setDraft,
    onSubmit,
    titleAccessory: accessory
  })
}

function render(
  request: ChoiceInputRequest = choice(),
  opts: {
    touch?: boolean
    initial?: ChoiceDraft
    accessory?: ReturnType<typeof createElement>
  } = {}
): ReturnType<typeof vi.fn> {
  const onSubmit = vi.fn()
  const form = createElement(Wrapper, {
    request,
    onSubmit,
    initial: opts.initial ?? { selected: [] },
    accessory: opts.accessory
  })
  act(() => {
    root.render(
      opts.touch
        ? createElement(
            ChatHostContext.Provider,
            { value: { density: 'touch' } as ChatHostValue },
            form
          )
        : form
    )
  })
  return onSubmit
}

/** 在目标（缺省 = 此刻的焦点，没有就 body）上派发一次 keydown；回 dispatchEvent 的结果（false = 被拦下） */
function press(key: string, target?: EventTarget): boolean {
  const at = target ?? document.activeElement ?? document.body
  let result = true
  act(() => {
    result = at.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true })
    )
  })
  return result
}

const rows = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('[data-choice-option]')
]
const row = (label: string): HTMLButtonElement => {
  const el = container.querySelector<HTMLButtonElement>(`[data-choice-option="${label}"]`)
  if (!el) throw new Error(`choice row ${label} not rendered`)
  return el
}
/** 行首的序号格（按钮的第一个子元素） */
const badgeOf = (r: HTMLElement): HTMLElement => r.firstElementChild as HTMLElement
const pressed = (): string[] => rows().map((r) => r.getAttribute('aria-pressed') ?? '')
const confirm = (): HTMLButtonElement => {
  const el = container.querySelector<HTMLButtonElement>('[data-choice-confirm]')
  if (!el) throw new Error('confirm button not rendered')
  return el
}
const question = (): HTMLElement => {
  const el = container.querySelector<HTMLElement>('[data-choice-question]')
  if (!el) throw new Error('choice question not rendered')
  return el
}
const hintLine = (): HTMLElement | undefined =>
  [...container.querySelectorAll<HTMLElement>('p')].find(
    (p) => p.textContent === en.pendingInputs.choiceHint
  )
const classesOf = (el: Element): string[] => (el.getAttribute('class') ?? '').split(/\s+/)
const before = (a: Node, b: Node): boolean =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
const click = (el: HTMLElement): void => act(() => el.click())

describe('ChoiceForm：问题、提示、选项行', () => {
  it('CF-1 问题、提示行、三行 A/B/C（序号 1/2/3、都没勾）、说明只在 A 与 C、没有 <pre>', () => {
    render()
    expect(question().textContent).toBe('Which?')
    const hint = hintLine()
    expect(hint, 'the choice hint line').toBeDefined()
    expect(en.pendingInputs.choiceHint).toBe('Pick one or more, then confirm')
    expect(rows().map((r) => r.dataset.choiceOption)).toEqual(['A', 'B', 'C'])
    expect(before(question(), hint!)).toBe(true)
    expect(before(hint!, rows()[0])).toBe(true)
    expect(rows().map((r) => badgeOf(r).textContent)).toEqual(['1', '2', '3'])
    for (const r of rows()) expect(badgeOf(r).getAttribute('aria-hidden')).toBe('true')
    expect(pressed()).toEqual(['false', 'false', 'false'])
    const detail = (label: string): string | null =>
      row(label).querySelector('[data-option-detail]')?.textContent ?? null
    expect(detail('A')).toBe('first')
    expect(detail('B')).toBeNull()
    expect(detail('C')).toBe('third')
    expect(container.querySelector('pre')).toBeNull()
  })

  it('CF-2 确认键起初禁用、字恰是 Confirm；点它不交', () => {
    const onSubmit = render()
    expect(confirm().disabled).toBe(true)
    expect(confirm().textContent).toBe('Confirm')
    expect(en.toolCall.confirmSelection).toBe('Confirm')
    click(confirm())
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('CF-3 点 B 勾上（对勾、Confirm (1)）；点 C → (2)；再点 B 勾掉（2 回来、(1)）；点行从不交', () => {
    const onSubmit = render()
    click(row('B'))
    expect(row('B').getAttribute('aria-pressed')).toBe('true')
    expect(badgeOf(row('B')).querySelector('svg.lucide-check')).not.toBeNull()
    expect(badgeOf(row('B')).textContent).not.toContain('2')
    expect(confirm().disabled).toBe(false)
    expect(confirm().textContent).toBe('Confirm (1)')

    click(row('C'))
    expect(pressed()).toEqual(['false', 'true', 'true'])
    expect(confirm().textContent).toBe('Confirm (2)')

    click(row('B'))
    expect(row('B').getAttribute('aria-pressed')).toBe('false')
    expect(badgeOf(row('B')).textContent).toBe('2')
    expect(badgeOf(row('B')).querySelector('svg.lucide-check')).toBeNull()
    expect(confirm().textContent).toBe('Confirm (1)')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('CF-4 先勾 C 再勾 A，确认 → 恰一次，selections 按点的先后', () => {
    const onSubmit = render()
    click(row('C'))
    click(row('A'))
    click(confirm())
    expect(onSubmit.mock.calls).toEqual([[{ kind: 'choice', selections: ['C', 'A'] }]])
  })
})

describe('ChoiceForm：数字键', () => {
  it('CF-5 紧凑档：2 勾 B、再 2 勾掉；1 再 3 → Confirm (2)；4 什么都不做；从不交', () => {
    const onSubmit = render()
    expect(document.activeElement).toBe(document.body)
    expect(press('2')).toBe(false)
    expect(pressed()).toEqual(['false', 'true', 'false'])
    expect(press('2')).toBe(false)
    expect(pressed()).toEqual(['false', 'false', 'false'])
    press('1')
    press('3')
    expect(pressed()).toEqual(['true', 'false', 'true'])
    expect(confirm().textContent).toBe('Confirm (2)')
    expect(press('4')).toBe(true)
    expect(pressed()).toEqual(['true', 'false', 'true'])
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('CF-6 触屏档：数字键什么都不做，点行照常勾；确认键 flex-1 h-10', () => {
    const onSubmit = render(choice(), { touch: true })
    for (const key of ['1', '2', '3']) expect(press(key), key).toBe(true)
    expect(pressed()).toEqual(['false', 'false', 'false'])
    click(row('A'))
    expect(pressed()).toEqual(['true', 'false', 'false'])
    click(row('A'))
    expect(pressed()).toEqual(['false', 'false', 'false'])
    expect(classesOf(confirm())).toEqual(expect.arrayContaining(['flex-1', 'h-10']))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('CF-7 焦点在卡片外的 textarea 里按 1 → 不勾', () => {
    render()
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    ta.focus()
    expect(press('1', ta)).toBe(true)
    expect(pressed()).toEqual(['false', 'false', 'false'])
    expect(confirm().disabled).toBe(true)
  })

  it('CF-12 十二个选项：序号 1…12；1 只勾第一行；0 什么都不做', () => {
    const options = Array.from({ length: 12 }, (_, i) => ({
      label: `opt-${i + 1}`,
      description: ''
    }))
    render(choice({ options }))
    expect(rows().map((r) => badgeOf(r).textContent)).toEqual(
      Array.from({ length: 12 }, (_, i) => String(i + 1))
    )
    press('1')
    expect(pressed()).toEqual(['true', ...Array.from({ length: 11 }, () => 'false')])
    expect(press('0')).toBe(true)
    expect(pressed()).toEqual(['true', ...Array.from({ length: 11 }, () => 'false')])
  })
})

describe('ChoiceForm：说明、滚动段、选项组', () => {
  it('CF-8 detail → 一个 <pre>，在提示行之后、第一行之前', () => {
    render(choice({ detail: 'ctx' }))
    const pres = container.querySelectorAll('pre')
    expect(pres).toHaveLength(1)
    expect(pres[0].textContent).toBe('ctx')
    expect(before(hintLine()!, pres[0])).toBe(true)
    expect(before(pres[0], rows()[0])).toBe(true)
  })

  it('CF-9 选项行所在的滚动段里有 <pre> 与每一行，没有问题、提示、确认键', () => {
    render(choice({ detail: 'ctx' }))
    const scroller = rows()[0].closest('.overflow-y-auto')
    expect(scroller).not.toBeNull()
    expect(scroller!.contains(container.querySelector('pre'))).toBe(true)
    for (const r of rows()) expect(scroller!.contains(r)).toBe(true)
    expect(scroller!.contains(question())).toBe(false)
    expect(scroller!.contains(hintLine()!)).toBe(false)
    expect(scroller!.contains(confirm())).toBe(false)
  })

  it('CF-10 选项行在一个 [role=group] 里，aria-label = 问题', () => {
    render()
    const groups = container.querySelectorAll('[role="group"]')
    expect(groups).toHaveLength(1)
    expect(groups[0].getAttribute('aria-label')).toBe('Which?')
    expect([...groups[0].querySelectorAll('button')]).toEqual(rows())
  })

  it('CF-11 titleAccessory 在问题那一行里、在问题之后', () => {
    render(choice(), { accessory: createElement('span', { 'data-acc': '' }, 'ACC') })
    const acc = container.querySelector('[data-acc]')!
    expect(acc).not.toBeNull()
    expect(acc.parentElement).toBe(question().parentElement)
    expect(before(question(), acc)).toBe(true)
  })
})

describe('ChoiceForm：边角', () => {
  it('CF-13 草稿是 {}：什么都没勾、确认禁用', () => {
    render(choice(), { initial: {} as ChoiceDraft })
    expect(pressed()).toEqual(['false', 'false', 'false'])
    expect(confirm().disabled).toBe(true)
    expect(confirm().textContent).toBe('Confirm')
  })

  it('CF-14 没有选项：没有行、确认禁用、1 什么都不做', () => {
    const onSubmit = render(choice({ options: [] }))
    expect(rows()).toHaveLength(0)
    expect(confirm().disabled).toBe(true)
    expect(() => press('1')).not.toThrow()
    expect(press('1')).toBe(true)
    click(confirm())
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('CF-15 禁用的确认键是安静的灰，可点时是强调色', () => {
    render()
    let cls = classesOf(confirm())
    expect(cls).toEqual(expect.arrayContaining(['bg-bg-secondary', 'text-text-tertiary']))
    expect(cls).not.toContain('bg-accent')
    click(row('A'))
    cls = classesOf(confirm())
    expect(cls).toContain('bg-accent')
    expect(cls).not.toContain('bg-bg-secondary')
  })
})
