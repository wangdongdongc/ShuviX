// @vitest-environment jsdom
/**
 * 工具行上的回答记录（ToolCallBlock × AnswerRecords，jsdom）：
 *
 *   - 人自己拒绝的调用（denied / feedback）不再报一次错：行首红叉没了，下面那行回答带着红叉；`data-tool-status` 照旧；
 *   - 别的失败照旧有红叉（工具批准之后自己失败、策略拒绝、审查拒绝）；挂起的询问盖过一切；
 *   - 记录折叠与展开时都在，且只有一份；与「已审查」标记共存；
 *   - 答完的 ask 不再是一行工具调用，是 AskRecord；带回答记录时两者都在；
 *   - 视图驱动：live 的 details 与块上的 details 走同一条路。
 *
 * 包入口 `@shuvix/chat-ui` 顶掉；i18n 走真 en 资源；不写 JSX。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { ToolResultDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type { ToolPresentation } from '@shuvix/chat-protocol/types/toolPresentation'
import { withToolAnswers, type ToolAnswerNote } from '@shuvix/chat-protocol/types/toolAnswer'
import { withToolReview } from '@shuvix/chat-protocol/types/toolReview'

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))

import { useChatStore, type ToolExecution } from '../../../stores/chatStore'
import { resetStore } from '../../../__tests__/support/views'
import { ToolCallBlock } from '../ToolCallBlock'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 'sess-A'
const PRESENTATION: ToolPresentation = {
  label: 'Read',
  icon: 'Eye',
  detailView: 'generic'
} as never

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  resetStore(SID)
  useChatStore.setState({ toolPresentations: { read: PRESENTATION } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const answers = (...notes: ToolAnswerNote[]): ToolResultDetails =>
  withToolAnswers(undefined as unknown as ToolResultDetails, notes)

type BlockProps = Partial<Parameters<typeof ToolCallBlock>[0]>
function render(props: BlockProps = {}): void {
  act(() => {
    root.render(
      createElement(ToolCallBlock, {
        toolName: 'read',
        toolCallId: 'tc-1',
        args: { path: '/a' },
        status: 'done',
        result: 'contents',
        ...props
      })
    )
  })
}

const row = (name = 'read'): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-tool-name="${name}"]`)!
const rowButton = (): HTMLButtonElement => row().querySelector('button')!
/** 工具行摘要那一行里的红叉（行首状态槽）：回答那一行不算 */
const leadError = (): Element | null => rowButton().querySelector('svg.lucide-x')
const answerLines = (): string[] =>
  [...container.querySelectorAll('[data-tool-answer]')].map(
    (el) => el.getAttribute('data-tool-answer')!
  )

describe('工具行的状态图标', () => {
  it.each([
    ['denied', { outcome: 'denied' }],
    ['feedback', { outcome: 'feedback', text: 'no' }]
  ] as const)(
    'TB-1/2 error + [%s]：行首没有红叉，工具图标在，status 仍是 error，回答那行在',
    (outcome, note) => {
      render({ status: 'error', details: answers(note) })
      expect(leadError()).toBeNull()
      expect(rowButton().querySelector('svg')).not.toBeNull()
      expect(row().getAttribute('data-tool-status')).toBe('error')
      expect(answerLines()).toEqual([outcome])
    }
  )

  it('TB-3 error + [allowed]（批准之后工具自己失败）：红叉还在', () => {
    render({ status: 'error', details: answers({ outcome: 'allowed' }) })
    expect(leadError()).not.toBeNull()
    expect(answerLines()).toEqual(['allowed'])
  })

  it('TB-4 error、没有回答（策略拒绝、审查拒绝）：红叉还在', () => {
    render({ status: 'error' })
    expect(leadError()).not.toBeNull()
    expect(answerLines()).toEqual([])
  })

  it('TB-5 error + [allowed, denied]：没有行首红叉，两行', () => {
    render({ status: 'error', details: answers({ outcome: 'allowed' }, { outcome: 'denied' }) })
    expect(leadError()).toBeNull()
    expect(answerLines()).toEqual(['allowed', 'denied'])
  })

  it('TB-6 done + [feedback]（L1 交回反馈那条路）：没有红叉，回答那行在', () => {
    render({ status: 'done', details: answers({ outcome: 'feedback', text: 'no' }) })
    expect(leadError()).toBeNull()
    expect(answerLines()).toEqual(['feedback'])
  })

  it('TB-7 这条调用还挂着询问：盾牌盖过 denied 的记录', () => {
    useChatStore.setState({
      sessionPendingInputs: {
        [SID]: [
          { id: 'tc-1', kind: 'ask', toolName: 'read', command: 'c', createdAt: 0 } as InputRequest
        ]
      }
    })
    render({ status: 'error', details: answers({ outcome: 'denied' }) })
    expect(rowButton().querySelector('svg.lucide-shield-alert')).not.toBeNull()
    expect(leadError()).toBeNull()
  })
})

describe('记录的位置', () => {
  it('TB-8 折叠与展开：回答那行都在，且只有一份', () => {
    render({ details: answers({ outcome: 'allowed' }) })
    expect(answerLines()).toEqual(['allowed'])

    act(() => rowButton().click())
    // 展开的详情（参数 / 结果）确实出来了
    expect(row().querySelector('.border-l')).not.toBeNull()
    expect(answerLines()).toEqual(['allowed'])
  })

  it('TB-9 done + 已审查 + [allowed]：盾牌与回答那行都在', () => {
    const details = withToolReview(answers({ outcome: 'allowed' }), {
      risk: 'low',
      summary: 's'
    })
    render({ details })
    expect(container.querySelector('[data-tool-reviewed]')).not.toBeNull()
    expect(answerLines()).toEqual(['allowed'])
  })
})

describe('答完的 ask', () => {
  const ASK: ToolResultDetails = {
    type: 'ask',
    question: 'Which?',
    selections: ['A']
  } as ToolResultDetails
  const ASK_PROPS: BlockProps = {
    toolName: 'ask',
    args: { question: 'Which?', options: [{ label: 'A' }] },
    result: 'User selected: A',
    details: ASK
  }

  it('TB-10 done：[data-tool-name=ask] 里是记录，没有工具行', () => {
    render({ ...ASK_PROPS, args: undefined })
    const el = row('ask')
    expect(el.querySelector('[data-ask-record]')).not.toBeNull()
    expect(el.querySelector('button')).toBeNull()
  })

  it.each(['running', 'error'] as const)('TB-11 %s：普通工具行，没有记录', (status) => {
    render({ ...ASK_PROPS, status, ...(status === 'running' ? { result: undefined } : {}) })
    expect(row('ask').querySelector('[data-ask-record]')).toBeNull()
    expect(row('ask').querySelector('button')).not.toBeNull()
  })

  it('TB-12 同一个组件从 running 变成 done：记录出来，不崩（hooks 次序）', () => {
    render({ ...ASK_PROPS, status: 'running', result: undefined, details: undefined })
    expect(row('ask').querySelector('[data-ask-record]')).toBeNull()

    render({ ...ASK_PROPS, status: 'done' })
    expect(row('ask').querySelector('[data-ask-record]')).not.toBeNull()

    render({ ...ASK_PROPS, status: 'running', result: undefined, details: undefined })
    expect(row('ask').querySelector('[data-ask-record]')).toBeNull()
  })

  it('TB-13 done 且带回答记录（策略在 ask 上设了 L1 门）：记录与回答那行都在', () => {
    render({ ...ASK_PROPS, details: withToolAnswers(ASK, [{ outcome: 'allowed' }]) })
    expect(row('ask').querySelector('[data-ask-record]')).not.toBeNull()
    expect(answerLines()).toEqual(['allowed'])
  })
})

describe('live 的 details', () => {
  const exec = (over: Partial<ToolExecution>): ToolExecution => ({
    toolCallId: 'tc-1',
    toolName: 'read',
    args: { path: '/a' },
    status: 'running',
    ...over
  })
  const setExecs = (execs: ToolExecution[]): void => {
    act(() =>
      useChatStore.setState((s) => ({
        sessionToolExecutions: { ...s.sessionToolExecutions, [SID]: execs }
      }))
    )
  }

  it('TB-14 执行记录带着 details：回答那行出来；记录撤了之后块上的 details 接着显示', () => {
    render({ status: 'running', result: undefined })
    expect(answerLines()).toEqual([])

    setExecs([exec({ status: 'done', details: answers({ outcome: 'allowed' }) })])
    expect(answerLines()).toEqual(['allowed'])

    setExecs([])
    render({ status: 'done', details: answers({ outcome: 'allowed' }) })
    expect(answerLines()).toEqual(['allowed'])
  })
})
