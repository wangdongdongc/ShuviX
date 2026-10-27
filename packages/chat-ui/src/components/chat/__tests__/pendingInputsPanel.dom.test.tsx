// @vitest-environment jsdom
/**
 * 输入卡片顶格的待处理面板（PendingInputsPanel）：一张审批卡或一张选项题卡，多条时标题行右端一个步进器。
 *
 *   PP-1  只有一条审批：根 `[data-pending-inputs="ask"]` 里是 `[data-ask-card]`；没有步进器；允许 →
 *         onResponse('r1', {kind:'ask', allowed:true})
 *   PP-2  只有一条选项题：根 `[data-pending-inputs="choice"]`；点 A → store 里的草稿 = {selected:['A']}、那行勾上；
 *         确认 → onResponse('r3', {kind:'choice', selections:['A']})
 *   PP-3  什么都没挂着 → 容器是空的
 *   PP-4  [审批, 选项题]：步进器在审批的顶行（`[data-ask-title]` 的父节点）；计数 1/2；前后两颗的 aria-label 与 title
 *         = pendingInputs.prev / next；下一条 → 根换成 choice、问题出来、2/2、步进器在问题那一行；再下一条绕回 1/2；
 *         在第 1 条点上一条 → 2/2
 *   PP-5  [审批 2 行, 审批 4 行]：1 答第一条（允许）；步进到第二条：1 → ('r2', 允许这一次)，3 → ('r2', 记住所在文件夹)；
 *         [审批, 审批]（行数相同）：步进到第二条后 1 答 r4、不答 r1
 *   PP-6  [审批, 审批]：1 答 r1；视图换成只剩第二条 → 它上屏、没有步进器；1 → ('r2', 允许这一次)；一共恰两次
 *   PP-7  [审批, 选项题]、选项题在前台：1 勾上 store 草稿里的 A、不交；退回审批：1 答 r1
 *   PP-8  [选项题, 选项题]：勾 A、下一条、再回来 → A 还勾着、Confirm (1)
 *   PP-9  [选项题, 审批]：什么都没勾 → 没有「一键提交已填」；勾 A → 它出现在步进器里；点它 → onResponse 恰一次
 *         ('r3', {kind:'choice', selections:['A']})
 *   PP-10 只有一条选项题、勾过了 → 没有「一键提交已填」
 *   PP-11 [带审查意见的审批, 审批]：顶行里风险标签在步进器之前，步进器是这一行的最后一个元素
 *   PP-12 （只断 class）紧凑档根 max-h-[50vh]、触屏档 max-h-[60vh]；两档都 flex flex-col min-h-0
 *   PP-13 触屏档：审批在前台时按 1 不交；点一行照交
 *   PP-14 两条都带策略提示的审批：第一张点开角标，步进到第二张 → 它的角标是收着的
 *
 * 状态只经 `applySessionView('s1', V('s1', { run: busy, asks }))` 写；面板在 effect 里给每条请求建草稿，挂上之后
 * 先等一拍。包入口 `@shuvix/chat-ui` 顶掉（AskForm 从那里取 getHostApi，给 {} = 有宿主，记住的行都在）；i18n 走真
 * en 资源。按键在 body 上派发（bubbles + cancelable + composed），每一下各自一个 act。文件是 .tsx 但不写 JSX。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type {
  AskInputRequest,
  ChoiceInputRequest,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'

const host = vi.hoisted(() => ({ api: {} as unknown }))
vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => host.api }))

import { applySessionView, useChatStore } from '../../../stores/chatStore'
import { V, resetStore, store } from '../../../__tests__/support/views'
import { PendingInputsPanel } from '../PendingInputsPanel'
import { ChatHostContext, type ChatHostValue } from '../../../host/chatHostContext'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ASK1: AskInputRequest = {
  id: 'r1',
  kind: 'ask',
  toolName: 'bash',
  command: 'ls',
  createdAt: 0
}
const ASK2: AskInputRequest = {
  id: 'r2',
  kind: 'ask',
  toolName: 'read',
  command: 'Read(/Users/u/proj/docs/a.md)',
  createdAt: 1
}
const ASK3: AskInputRequest = {
  id: 'r4',
  kind: 'ask',
  toolName: 'bash',
  command: 'pwd',
  createdAt: 3
}
const CHOICE: ChoiceInputRequest = {
  id: 'r3',
  kind: 'choice',
  toolName: 'ask',
  question: 'Which?',
  options: [
    { label: 'A', description: '' },
    { label: 'B', description: '' }
  ],
  createdAt: 2
}
const CHOICE2: ChoiceInputRequest = {
  id: 'r5',
  kind: 'choice',
  toolName: 'ask',
  question: 'Second?',
  options: [
    { label: 'X', description: '' },
    { label: 'Y', description: '' }
  ],
  createdAt: 4
}

let container: HTMLDivElement
let root: Root
let onResponse: Mock<(requestId: string, response: InputResponse) => void>

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
})

beforeEach(() => {
  host.api = {}
  resetStore('s1')
  onResponse = vi.fn<(requestId: string, response: InputResponse) => void>()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function setAsks(asks: InputRequest[]): void {
  act(() => applySessionView('s1', V('s1', { run: { state: 'busy' }, asks })))
}

/** 挂面板（触屏档包一层宿主上下文），并等草稿 effect 落定 */
async function mount(asks: InputRequest[], opts: { touch?: boolean } = {}): Promise<void> {
  setAsks(asks)
  const panel = createElement(PendingInputsPanel, { onResponse })
  act(() => {
    root.render(
      opts.touch
        ? createElement(
            ChatHostContext.Provider,
            { value: { density: 'touch' } as ChatHostValue },
            panel
          )
        : panel
    )
  })
  await flush()
}

/** 在 body 上派发一次 keydown；回 dispatchEvent 的结果（false = 被拦下） */
function press(key: string): boolean {
  let result = true
  act(() => {
    result = document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true })
    )
  })
  return result
}

const panelRoot = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-pending-inputs]')
const kind = (): string | null => panelRoot()?.getAttribute('data-pending-inputs') ?? null
const stepper = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-pending-stepper]')
const counter = (): string => {
  const span = [...(stepper()?.querySelectorAll('span') ?? [])].find((s) =>
    /^\d+\/\d+$/.test(s.textContent ?? '')
  )
  if (!span) throw new Error('stepper counter not rendered')
  return span.textContent ?? ''
}
const stepButton = (which: 'prev' | 'next'): HTMLButtonElement => {
  const label = en.pendingInputs[which]
  const el = stepper()?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!el) throw new Error(`stepper ${which} button not rendered`)
  return el
}
async function step(which: 'prev' | 'next'): Promise<void> {
  act(() => stepButton(which).click())
  await flush()
}
const askOption = (id: string): HTMLButtonElement => {
  const el = container.querySelector<HTMLButtonElement>(`[data-ask-option="${id}"]`)
  if (!el) throw new Error(`ask option ${id} not rendered`)
  return el
}
const choiceRow = (label: string): HTMLButtonElement => {
  const el = container.querySelector<HTMLButtonElement>(`[data-choice-option="${label}"]`)
  if (!el) throw new Error(`choice row ${label} not rendered`)
  return el
}
const confirm = (): HTMLButtonElement => {
  const el = container.querySelector<HTMLButtonElement>('[data-choice-confirm]')
  if (!el) throw new Error('confirm button not rendered')
  return el
}
const submitAll = (): HTMLButtonElement | null =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.textContent ?? '').trim() === en.pendingInputs.submitAllFilled
  ) ?? null
const draftOf = (requestId: string): unknown => store().sessionInputDrafts.s1?.[requestId]
const classesOf = (el: Element): string[] => (el.getAttribute('class') ?? '').split(/\s+/)
const before = (a: Node, b: Node): boolean =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
async function click(el: HTMLElement): Promise<void> {
  act(() => el.click())
  await flush()
}

describe('PendingInputsPanel：一条', () => {
  it('PP-1 只有一条审批：审批卡、没有步进器；允许 → onResponse(r1, 允许)', async () => {
    await mount([ASK1])
    expect(kind()).toBe('ask')
    expect(panelRoot()!.querySelector('[data-ask-card]')).not.toBeNull()
    expect(stepper()).toBeNull()
    await click(askOption('allow'))
    expect(onResponse.mock.calls).toEqual([['r1', { kind: 'ask', allowed: true }]])
  })

  it('PP-2 只有一条选项题：点 A 写进 store 草稿、那行勾上；确认 → onResponse(r3, [A])', async () => {
    await mount([CHOICE])
    expect(kind()).toBe('choice')
    expect(draftOf('r3')).toEqual({ selected: [] })
    await click(choiceRow('A'))
    expect(draftOf('r3')).toEqual({ selected: ['A'] })
    expect(choiceRow('A').getAttribute('aria-pressed')).toBe('true')
    await click(confirm())
    expect(onResponse.mock.calls).toEqual([['r3', { kind: 'choice', selections: ['A'] }]])
  })

  it('PP-3 什么都没挂着 → 容器是空的', async () => {
    await mount([])
    expect(container.innerHTML).toBe('')
  })
})

describe('PendingInputsPanel：多条与步进器', () => {
  it('PP-4 [审批, 选项题]：步进器在顶行、1/2；前后键的名字；下一条到选项题（2/2、步进器在问题那一行）；绕回', async () => {
    await mount([ASK1, CHOICE])
    expect(kind()).toBe('ask')
    const title = container.querySelector('[data-ask-title]')!
    expect(stepper()!.parentElement).toBe(title.parentElement)
    expect(counter()).toBe('1/2')
    for (const which of ['prev', 'next'] as const) {
      const btn = stepButton(which)
      expect(btn.getAttribute('aria-label')).toBe(en.pendingInputs[which])
      expect(btn.title).toBe(en.pendingInputs[which])
    }

    await step('next')
    expect(kind()).toBe('choice')
    const question = container.querySelector('[data-choice-question]')!
    expect(question.textContent).toBe('Which?')
    expect(counter()).toBe('2/2')
    expect(stepper()!.parentElement).toBe(question.parentElement)

    await step('next')
    expect(kind()).toBe('ask')
    expect(counter()).toBe('1/2')

    await step('prev')
    expect(kind()).toBe('choice')
    expect(counter()).toBe('2/2')
  })

  it('PP-5 [2 行审批, 4 行审批]：1 答 r1；步进后 1 / 3 答 r2（允许这一次 / 记住所在文件夹）', async () => {
    await mount([ASK1, ASK2])
    expect(press('1')).toBe(false)
    expect(onResponse.mock.calls).toEqual([['r1', { kind: 'ask', allowed: true }]])

    await step('next')
    expect(counter()).toBe('2/2')
    press('1')
    expect(onResponse.mock.lastCall).toEqual(['r2', { kind: 'ask', allowed: true }])
    press('3')
    expect(onResponse.mock.lastCall).toEqual([
      'r2',
      { kind: 'ask', allowed: true, extra: { rememberPath: '/Users/u/proj/docs' } }
    ])
    expect(onResponse).toHaveBeenCalledTimes(3)
  })

  it('PP-5 [审批, 审批]（行数相同）：步进后 1 答 r4，不答 r1', async () => {
    await mount([ASK1, ASK3])
    await step('next')
    expect(counter()).toBe('2/2')
    press('1')
    expect(onResponse.mock.calls).toEqual([['r4', { kind: 'ask', allowed: true }]])
  })

  it('PP-6 1 答 r1；视图只剩第二条 → 它上屏、没有步进器；1 答 r2；一共恰两次', async () => {
    await mount([ASK1, ASK2])
    press('1')
    expect(onResponse.mock.lastCall).toEqual(['r1', { kind: 'ask', allowed: true }])

    setAsks([ASK2])
    await flush()
    expect(stepper()).toBeNull()
    expect(container.querySelector('[data-ask-option="remember-folder"]')).not.toBeNull()
    press('1')
    expect(onResponse.mock.lastCall).toEqual(['r2', { kind: 'ask', allowed: true }])
    expect(onResponse).toHaveBeenCalledTimes(2)
  })

  it('PP-7 [审批, 选项题]、选项题在前台：1 勾 store 草稿里的 A、不交；退回审批：1 答 r1', async () => {
    await mount([ASK1, CHOICE])
    await step('next')
    expect(kind()).toBe('choice')
    press('1')
    expect(draftOf('r3')).toEqual({ selected: ['A'] })
    expect(onResponse).not.toHaveBeenCalled()

    await step('prev')
    expect(kind()).toBe('ask')
    press('1')
    expect(onResponse.mock.calls).toEqual([['r1', { kind: 'ask', allowed: true }]])
  })

  it('PP-8 [选项题, 选项题]：勾 A、下一条、回来 → A 还勾着、Confirm (1)', async () => {
    await mount([CHOICE, CHOICE2])
    await click(choiceRow('A'))
    await step('next')
    expect(container.querySelector('[data-choice-question]')!.textContent).toBe('Second?')
    expect(choiceRow('X').getAttribute('aria-pressed')).toBe('false')
    await step('prev')
    expect(choiceRow('A').getAttribute('aria-pressed')).toBe('true')
    expect(confirm().textContent).toBe('Confirm (1)')
  })

  it('PP-9 [选项题, 审批]：没勾 → 没有「一键提交已填」；勾 A → 它在步进器里；点它 → 恰一次 (r3, [A])', async () => {
    await mount([CHOICE, ASK1])
    expect(submitAll()).toBeNull()
    await click(choiceRow('A'))
    const btn = submitAll()
    expect(btn).not.toBeNull()
    expect(stepper()!.contains(btn)).toBe(true)
    await click(btn!)
    expect(onResponse.mock.calls).toEqual([['r3', { kind: 'choice', selections: ['A'] }]])
  })

  it('PP-10 只有一条选项题、勾过了 → 没有「一键提交已填」', async () => {
    await mount([CHOICE])
    await click(choiceRow('A'))
    await click(choiceRow('B'))
    expect(stepper()).toBeNull()
    expect(submitAll()).toBeNull()
  })

  it('PP-11 [带审查意见的审批, 审批]：风险标签在步进器之前，步进器是顶行最后一个', async () => {
    await mount([
      { ...ASK1, review: { risk: 'medium', summary: 'Lists files', reason: 'Harmless' } },
      ASK3
    ])
    const line = container.querySelector('[data-ask-title]')!.parentElement!
    const risk = container.querySelector('[data-ask-review-risk]')!
    expect(risk.parentElement).toBe(line)
    expect(stepper()!.parentElement).toBe(line)
    expect(before(risk, stepper()!)).toBe(true)
    expect(line.lastElementChild).toBe(stepper())
  })
})

describe('PendingInputsPanel：密度与表单的身份', () => {
  it.each<['compact' | 'touch', string, string]>([
    ['compact', 'max-h-[50vh]', 'max-h-[60vh]'],
    ['touch', 'max-h-[60vh]', 'max-h-[50vh]']
  ])('PP-12 %s：根的封顶高度', async (density, has, hasNot) => {
    await mount([ASK1], { touch: density === 'touch' })
    const cls = classesOf(panelRoot()!)
    expect(cls).toEqual(expect.arrayContaining(['flex', 'flex-col', 'min-h-0', has]))
    expect(cls).not.toContain(hasNot)
  })

  it('PP-13 触屏档：1 不交；点一行照交', async () => {
    await mount([ASK1], { touch: true })
    expect(press('1')).toBe(true)
    expect(onResponse).not.toHaveBeenCalled()
    await click(askOption('allow'))
    expect(onResponse.mock.calls).toEqual([['r1', { kind: 'ask', allowed: true }]])
  })

  it('PP-14 第一张点开策略角标，步进到第二张 → 它的角标收着', async () => {
    const T1 = 'First policy words.'
    const T2 = 'Second policy words.'
    await mount([
      { ...ASK1, policyPrompt: { text: T1, policies: ['p1'] } },
      { ...ASK3, policyPrompt: { text: T2, policies: ['p2'] } }
    ])
    const expanded = (text: string): number =>
      [...container.querySelectorAll('p')].filter((p) => p.textContent === text).length
    await click(container.querySelector<HTMLButtonElement>('[data-ask-policy]')!)
    expect(expanded(T1)).toBe(1)

    await step('next')
    expect(container.querySelector('[data-ask-policy]')!.textContent).toBe('p2')
    expect(expanded(T2)).toBe(0)
    expect(container.textContent).not.toContain(T2)
    // 步进写的是 store 里的选中项（输入框据此知道「其它」投给哪条）
    expect(useChatStore.getState().sessionActiveInputId.s1).toBe('r4')
  })
})
