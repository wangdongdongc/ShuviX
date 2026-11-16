// @vitest-environment jsdom
/**
 * 工具行行尾的「无人」图标（ToolCallBlock × UnattendedMark，jsdom；docs/unattended-run-design.md §5 / §6）。
 *
 * 一轮无人值守的运行里要交给人的那一步（批准 / 回答 / 填值）当场落定，模型收到的工具结果以 `[Unattended run]` 开头。
 * 界面不另存状态，只按结果文本的形状认（`isUnattendedResult`），所以 live 与重开会话是同一份 DOM：
 *
 *   TB-1  失败的权限询问：行尾有图标，悬停提示 / aria-label 是 `toolCall.unattendedHint`；仍是红行；折叠展开都在
 *   TB-2  没人答的 ask（普通结果，不是错）：照普通工具行画（带图标、能展开看结果），不画成答完的记录
 *   TB-3  正常答完的 ask：记录，没有图标
 *   TB-4  ask 没选（selections 空）但结果是普通文本：还是记录 —— 判据是结果文本，不是空选择
 *   TB-5  没有结果 / 结果不是字符串 / 标记在正文深处：没有图标
 *   TB-6  与「已审查」标记共存（落定的行）：无人图标在前；失败的行只有无人图标
 *   TB-7  经 MCP 的工具（失败被包了一层 `[MCP Error] `）：图标照样在
 *   TB-8  shuvix 工具要用户填值：图标在
 *   TB-9  合并行：没人答的 ask、被拒的失败调用都不并进步骤组（这些行本身就是「哪些事没做成」的清单）
 *   TB-10 同一份 props 渲染两次（live → 重开）DOM 相同
 *
 * 包入口 `@shuvix/chat-ui` 顶掉；i18n 走真 en 资源；不写 JSX。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type {
  AssistantBlock,
  AssistantToolBlock,
  ToolResultDetails
} from '@shuvix/chat-protocol/types/chatMessage'
import type { ToolPresentation } from '@shuvix/chat-protocol/types/toolPresentation'
import { withToolReview } from '@shuvix/chat-protocol/types/toolReview'
import {
  UNATTENDED_FIELDS_TEXT,
  UNATTENDED_MARK,
  UNATTENDED_QUESTION_TEXT,
  unattendedApprovalText
} from '@shuvix/chat-protocol/unattended'

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))

import { useChatStore } from '../../../stores/chatStore'
import { resetStore } from '../../../__tests__/support/views'
import { ToolCallBlock } from '../ToolCallBlock'
import { groupConsecutiveSteps } from '../stepGrouping'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 'sess-U'
const PRESENTATION: ToolPresentation = {
  label: 'Bash',
  icon: 'Terminal',
  detailView: 'generic'
} as never
const HINT = en.toolCall.unattendedHint
const REFUSED = unattendedApprovalText('ls ~')

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
  useChatStore.setState({ toolPresentations: { bash: PRESENTATION } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

type BlockProps = Partial<Parameters<typeof ToolCallBlock>[0]>
function render(props: BlockProps = {}): void {
  act(() => {
    root.render(
      createElement(ToolCallBlock, {
        toolName: 'bash',
        toolCallId: 'tc-1',
        args: { command: 'ls ~' },
        status: 'error',
        result: REFUSED,
        ...props
      })
    )
  })
}

const row = (name = 'bash'): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-tool-name="${name}"]`)!
const rowButton = (name = 'bash'): HTMLButtonElement => row(name).querySelector('button')!
const marks = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-tool-unattended]')
]

const ASK_DETAILS = (selections: string[]): ToolResultDetails =>
  ({ type: 'ask', question: 'Which?', selections }) as ToolResultDetails
const ASK_PROPS: BlockProps = {
  toolName: 'ask',
  args: { question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] },
  status: 'done',
  result: UNATTENDED_QUESTION_TEXT,
  details: ASK_DETAILS([])
}

describe('被拒的权限询问', () => {
  it('TB-1 行尾一个图标：title / aria-label 是悬停提示，没有可见文字；仍是红行', () => {
    render()
    expect(HINT.length).toBeGreaterThan(0)
    expect(marks()).toHaveLength(1)
    const mark = marks()[0]!
    expect(mark.getAttribute('title')).toBe(HINT)
    expect(mark.getAttribute('aria-label')).toBe(HINT)
    expect(mark.textContent).toBe('')
    expect(mark.querySelector('svg')).not.toBeNull()
    expect(mark.classList.contains('text-warning')).toBe(true)
    expect(row().getAttribute('data-tool-status')).toBe('error')
    expect(rowButton().contains(mark)).toBe(true)
  })

  it('TB-1 折叠与展开都在，且只有一份；展开看得到那段话', () => {
    render()
    act(() => rowButton().click())
    expect(marks()).toHaveLength(1)
    expect(row().textContent).toContain('nobody is here to approve it now: ls ~')
    act(() => rowButton().click())
    expect(marks()).toHaveLength(1)
  })

  it('TB-1 运行结束后图标留作记录：同一步重渲染（别的 props 变了）还在', () => {
    render()
    render({ args: { command: 'ls ~', description: 'list home' } })
    expect(marks()).toHaveLength(1)
  })
})

describe('没人答的 ask', () => {
  it('TB-2 普通工具行 + 图标，不是答完的记录；状态是 done（不是红行）', () => {
    render(ASK_PROPS)
    const el = row('ask')
    expect(el.querySelector('[data-ask-record]')).toBeNull()
    expect(el.querySelector('button')).not.toBeNull()
    expect(el.getAttribute('data-tool-status')).toBe('done')
    expect(marks()).toHaveLength(1)
    expect(el.contains(marks()[0]!)).toBe(true)
  })

  it('TB-2 能展开看到结果文本', () => {
    render(ASK_PROPS)
    act(() => rowButton('ask').click())
    expect(row('ask').textContent).toContain('Nobody is here to answer')
    expect(marks()).toHaveLength(1)
  })

  it('TB-3 正常答完的 ask：记录，没有图标', () => {
    render({ ...ASK_PROPS, result: 'User selected: A', details: ASK_DETAILS(['A']) })
    expect(row('ask').querySelector('[data-ask-record]')).not.toBeNull()
    expect(marks()).toEqual([])
  })

  it('TB-4 没选（selections 空）但结果是普通文本：还是记录', () => {
    render({ ...ASK_PROPS, result: 'User made no selection' })
    expect(row('ask').querySelector('[data-ask-record]')).not.toBeNull()
    expect(marks()).toEqual([])
  })

  it('TB-4 同一个组件从等回答变成没人答：不崩（hooks 次序），落在普通行上', () => {
    render({ ...ASK_PROPS, status: 'running', result: undefined, details: undefined })
    expect(marks()).toEqual([])
    render(ASK_PROPS)
    expect(marks()).toHaveLength(1)
    expect(row('ask').querySelector('[data-ask-record]')).toBeNull()
  })
})

describe('TB-5 不该有图标的', () => {
  it.each<[string, BlockProps]>([
    ['还在跑（没有结果）', { status: 'running', result: undefined }],
    ['普通成功结果', { status: 'done', result: 'file1\nfile2' }],
    ['普通失败', { status: 'error', result: 'Aborted' }],
    ['用户拒绝', { status: 'error', result: 'The user denied this operation.' }],
    [
      '标记在正文深处（命令输出里恰好有这几个字）',
      { status: 'done', result: `${'log line\n'.repeat(12)}${UNATTENDED_MARK} seen in a log` }
    ],
    ['小写', { status: 'error', result: '[unattended run] x' }]
  ])('%s', (_label, props) => {
    render(props)
    expect(marks()).toEqual([])
    expect(row()).not.toBeNull()
  })

  it('结果不是字符串', () => {
    render({ status: 'done', result: { text: REFUSED } as unknown as string })
    expect(marks()).toEqual([])
  })
})

describe('与别的标记、别的工具', () => {
  const REVIEWED = withToolReview(undefined as unknown as ToolResultDetails, {
    risk: 'medium',
    summary: 'needs a person'
  })

  it('TB-6 落定的一步带着「已审查」：无人图标与它都在，无人在前', () => {
    // 「已审查」只画在成功落定的行上（ToolCallBlock：status === 'done'）
    render({
      ...ASK_PROPS,
      details: { ...ASK_DETAILS([]), ...REVIEWED } as ToolResultDetails
    })
    const mark = marks()[0]!
    const reviewed = container.querySelector('[data-tool-reviewed]')!
    expect(reviewed).not.toBeNull()
    expect(mark.compareDocumentPosition(reviewed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(mark.parentElement).toBe(reviewed.parentElement)
  })

  it('TB-6 失败的那一行（审查员转给人、而没人在）：只有无人图标，没有「已审查」', () => {
    render({ details: REVIEWED })
    expect(marks()).toHaveLength(1)
    expect(container.querySelector('[data-tool-reviewed]')).toBeNull()
  })

  it('TB-6 没有 toolCallId 的行也画', () => {
    render({ toolCallId: undefined })
    expect(marks()).toHaveLength(1)
  })

  it('TB-7 经 MCP 的工具：`[MCP Error] ` 前缀之后的标记也认', () => {
    render({
      toolName: 'mcp__ssh__exec',
      args: { host: 'prod', command: 'uptime' },
      result: `[MCP Error] ${unattendedApprovalText('prod: uptime')}`
    })
    expect(row('mcp__ssh__exec').getAttribute('data-tool-status')).toBe('error')
    expect(marks()).toHaveLength(1)
    expect(marks()[0]!.getAttribute('title')).toBe(HINT)
  })

  it('TB-8 shuvix 工具要用户填值而没人在', () => {
    render({
      toolName: 'shuvix',
      args: { action: 'call', channel: 'provider:update' },
      result: UNATTENDED_FIELDS_TEXT
    })
    expect(marks()).toHaveLength(1)
    expect(row('shuvix').getAttribute('data-tool-status')).toBe('error')
  })
})

describe('TB-9 合并行不吞掉这些行', () => {
  const tool = (
    id: string,
    name: string,
    opts: { result?: string; isError?: boolean; details?: ToolResultDetails } = {}
  ): AssistantToolBlock =>
    ({
      type: 'tool',
      toolCallId: id,
      toolName: name,
      ...(opts.result !== undefined ? { result: opts.result } : {}),
      ...(opts.isError ? { isError: true } : {}),
      ...(opts.details ? { details: opts.details } : {})
    }) as AssistantToolBlock
  const shape = (blocks: AssistantBlock[]): string[] =>
    groupConsecutiveSteps(blocks).map((group) =>
      group.kind === 'stepGroup'
        ? `group:${group.blocks.length}`
        : `single:${(group.block as AssistantToolBlock).toolCallId}`
    )

  it('没人答的 ask 夹在两次 read 之间：三段单行，ask 自己一行', () => {
    const blocks = [
      tool('r1', 'read', { result: 'A' }),
      tool('q', 'ask', { result: UNATTENDED_QUESTION_TEXT, details: ASK_DETAILS([]) }),
      tool('r2', 'read', { result: 'B' })
    ]
    expect(shape(blocks)).toEqual(['single:r1', 'single:q', 'single:r2'])
  })

  it('没人答的 ask 夹在两组 read 之间：组、单行、组', () => {
    const blocks = [
      tool('r1', 'read', { result: 'A' }),
      tool('r2', 'read', { result: 'B' }),
      tool('q', 'ask', { result: UNATTENDED_QUESTION_TEXT, details: ASK_DETAILS([]) }),
      tool('r3', 'read', { result: 'C' }),
      tool('r4', 'read', { result: 'D' })
    ]
    expect(shape(blocks)).toEqual(['group:2', 'single:q', 'group:2'])
  })

  it('被拒的权限询问是失败的调用：不并进两边的组', () => {
    const blocks = [
      tool('r1', 'read', { result: 'A' }),
      tool('r2', 'read', { result: 'B' }),
      tool('x', 'bash', { result: REFUSED, isError: true }),
      tool('r3', 'read', { result: 'C' }),
      tool('r4', 'read', { result: 'D' })
    ]
    expect(shape(blocks)).toEqual(['group:2', 'single:x', 'group:2'])
  })
})

describe('TB-10 live 与重开会话同一份 DOM', () => {
  it.each<[string, BlockProps]>([
    ['被拒的 bash', {}],
    ['没人答的 ask', ASK_PROPS]
  ])('%s：卸掉重挂（没有任何 store 状态）结果相同', (_label, props) => {
    render(props)
    const live = container.innerHTML
    act(() => root.unmount())
    resetStore(SID)
    useChatStore.setState({ toolPresentations: { bash: PRESENTATION } })
    root = createRoot(container)
    render(props)
    expect(container.innerHTML).toBe(live)
    expect(marks()).toHaveLength(1)
  })
})
