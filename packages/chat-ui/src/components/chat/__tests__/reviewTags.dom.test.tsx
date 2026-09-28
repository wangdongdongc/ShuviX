// @vitest-environment jsdom
/**
 * 自动审查在对话里的露面（jsdom）—— 设计稿 docs/permission-review-design.md §11：
 *
 *   - UI-T* 工具卡「审查中」：执行记录上的 reviewing（`tool_review` 事件维护）在运行中顶替转圈；
 *     挂起的询问优先；结束了就不再显示；只读当前会话；
 *   - UI-M* 工具卡「已审查」：details 上的 `shuvixReview` 标记（toolReviewOf）在行尾挂一枚盾牌，
 *     颜色随风险、悬停是「hint + 审查员那句话」；实时与重开同一个样子；只有 done 才挂；
 *     步骤合并行折起来时挂段内风险最高的那一枚；
 *   - UI-A* 询问卡片上的审查意见：审查员交给你的那次，它的大白话放在命令原文上方；
 *   - UI-K* 一条完整的链：tool_start → 审查中 → 转圈 → tool_end 带标记 → finishStreaming 之后仍在。
 *
 * 包入口 `@shuvix/chat-ui` 整个顶掉（AskForm 从入口取 getHostApi）；i18n 走真 zh 资源；期望文案一律用
 * 同一个 i18n 实例算，并先断言它不是键名本身。文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { AskInputRequest, AskReview } from '@shuvix/chat-protocol/types/inputRequest'
import type {
  AssistantMessage,
  AssistantToolBlock,
  ToolResultDetails
} from '@shuvix/chat-protocol/types/chatMessage'
import type { ToolPresentation } from '@shuvix/chat-protocol/types/toolPresentation'
import type { PermissionRisk } from '@shuvix/chat-protocol/types/permissionReview'
import { PERMISSION_RISKS } from '@shuvix/chat-protocol/types/permissionReview'
import { withToolReview, type ToolReviewNote } from '@shuvix/chat-protocol/types/toolReview'

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))

import { useChatStore, type ToolExecution } from '../../../stores/chatStore'
import { ToolCallBlock } from '../ToolCallBlock'
import { StepGroup } from '../StepGroup'
import { AskForm } from '../inputs/AskForm'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const A = 'sess-A'
const B = 'sess-B'

const TERMINAL: ToolPresentation = {
  label: 'Run Command',
  icon: 'Terminal',
  detailView: 'terminal'
}

const NOTE: ToolReviewNote = { risk: 'medium', summary: 'Removes the build folder' }
const bashDetails = (): ToolResultDetails =>
  ({ type: 'bash', exitCode: 0, truncated: false, cwd: '/w' }) as ToolResultDetails
const reviewed = (note: ToolReviewNote = NOTE): ToolResultDetails =>
  withToolReview(bashDetails(), note)
const ARGS = { command: 'rm -rf build', description: 'Clean the build' }

let container: HTMLDivElement
let root: Root

function render(element: ReturnType<typeof createElement>): void {
  act(() => {
    root.render(element)
  })
}

/** 另起一个容器渲染（比较两次渲染的 DOM 时用），返回它的容器；afterEach 一并卸载 */
const extraRoots: Array<{ root: Root; el: HTMLDivElement }> = []
function renderApart(element: ReturnType<typeof createElement>): HTMLDivElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const r = createRoot(el)
  act(() => {
    r.render(element)
  })
  extraRoots.push({ root: r, el })
  return el
}

/** 期望文案：同一个 i18n 实例算出，且先断言不是键名本身 */
function tr(key: string, opts?: Record<string, unknown>): string {
  const text = i18n.t(key, opts)
  expect(text, key).not.toBe(key)
  return text
}
const riskLabel = (risk: PermissionRisk): string => tr(`toolCall.reviewRisk.${risk}`)
const reviewedHint = (risk: PermissionRisk): string =>
  tr('toolCall.reviewedHint', { risk: riskLabel(risk) })

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  useChatStore.setState({
    toolPresentations: { bash: TERMINAL },
    activeSessionId: A,
    sessionToolExecutions: {},
    sessionPendingInputs: {},
    sessionStreams: {},
    messages: []
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  for (const { root: r } of extraRoots.splice(0)) act(() => r.unmount())
  container.remove()
  document.body.innerHTML = ''
})

// ─── 工具行的几个锚点 ─────────────────────────────────────

function toolRow(scope: ParentNode = container, name = 'bash'): HTMLElement {
  const el = scope.querySelector<HTMLElement>(`[data-tool-name="${name}"]`)
  if (!el) throw new Error(`tool row ${name} not rendered`)
  return el
}
/** 摘要行（工具行里的第一个按钮） */
const summaryButton = (row: HTMLElement): HTMLButtonElement =>
  row.querySelector('button') as HTMLButtonElement
const reviewingEl = (scope: ParentNode = container): HTMLElement | null =>
  scope.querySelector<HTMLElement>('[data-tool-reviewing]')
const spinner = (scope: ParentNode = container): Element | null =>
  scope.querySelector('svg.lucide-loader-circle')
const reviewedMarks = (scope: ParentNode = container): HTMLElement[] => [
  ...scope.querySelectorAll<HTMLElement>('[data-tool-reviewed]')
]

const liveExec = (extra: Partial<ToolExecution> = {}): ToolExecution => ({
  toolCallId: 'tc-1',
  toolName: 'bash',
  args: ARGS,
  status: 'running',
  ...extra
})

function setExecs(sessionId: string, execs: ToolExecution[]): void {
  useChatStore.setState((s) => ({
    sessionToolExecutions: { ...s.sessionToolExecutions, [sessionId]: execs }
  }))
}

const block = (
  props: Partial<Parameters<typeof ToolCallBlock>[0]> = {}
): ReturnType<typeof createElement> =>
  createElement(ToolCallBlock, {
    toolName: 'bash',
    toolCallId: 'tc-1',
    args: ARGS,
    status: 'running',
    ...props
  })

// ─── UI-T：审查中 ─────────────────────────────────────────

describe('ToolCallBlock — 「审查中」', () => {
  it('UI-T1 记录 running 且 reviewing：有 [data-tool-reviewing]（title 为 reviewingHint、里面是盾牌），没有转圈，status 仍是 running', () => {
    setExecs(A, [liveExec({ reviewing: true })])
    render(block())

    const el = reviewingEl()
    expect(el).not.toBeNull()
    expect(el!.getAttribute('title')).toBe(tr('toolCall.reviewingHint'))
    expect(el!.querySelector('svg.lucide-shield-ellipsis')).not.toBeNull()
    expect(spinner()).toBeNull()
    expect(toolRow().getAttribute('data-tool-status')).toBe('running')
  })

  it('UI-T2 依次 reviewing true → false → tool_end：审查中 → 转圈 → 都没有', () => {
    setExecs(A, [liveExec()])
    render(block())
    expect(spinner()).not.toBeNull()

    act(() => useChatStore.getState().setToolReviewing(A, 'tc-1', true))
    expect(reviewingEl()).not.toBeNull()
    expect(spinner()).toBeNull()

    act(() => useChatStore.getState().setToolReviewing(A, 'tc-1', false))
    expect(reviewingEl()).toBeNull()
    expect(spinner()).not.toBeNull()

    act(() => useChatStore.getState().handleToolEnd(A, 'tc-1', { status: 'done', result: 'ok' }))
    expect(reviewingEl()).toBeNull()
    expect(spinner()).toBeNull()
    expect(toolRow().getAttribute('data-tool-status')).toBe('done')
  })

  it('UI-T3 同一调用有挂起的询问时询问优先：shield-alert，不显示审查中', () => {
    setExecs(A, [liveExec({ reviewing: true })])
    const pending: AskInputRequest = {
      id: 'tc-1',
      kind: 'ask',
      toolName: 'bash',
      command: 'rm -rf build',
      createdAt: 0
    }
    useChatStore.setState({ sessionPendingInputs: { [A]: [pending] } })
    render(block())

    expect(toolRow().querySelector('svg.lucide-shield-alert')).not.toBeNull()
    expect(reviewingEl()).toBeNull()
  })

  it('UI-T4 残留态 {done, reviewing: true} 不显示审查中', () => {
    setExecs(A, [liveExec({ status: 'done', result: 'ok', reviewing: true })])
    render(block())
    expect(reviewingEl()).toBeNull()
    expect(toolRow().getAttribute('data-tool-status')).toBe('done')
  })

  it('UI-T5 只读当前会话：B 里的记录在审查，当前是 A → 不显示审查中（仍按 props 转圈）', () => {
    setExecs(B, [liveExec({ reviewing: true })])
    render(block())
    expect(reviewingEl()).toBeNull()
    expect(spinner()).not.toBeNull()

    // 切到 B 就看得见
    act(() => useChatStore.setState({ activeSessionId: B }))
    expect(reviewingEl()).not.toBeNull()
  })

  it('UI-T6 盾牌带 animate-pulse', () => {
    setExecs(A, [liveExec({ reviewing: true })])
    render(block())
    const shield = reviewingEl()!.querySelector('svg.lucide-shield-ellipsis')!
    expect(shield.classList.contains('animate-pulse')).toBe(true)
  })
})

// ─── UI-M：已审查 ─────────────────────────────────────────

describe('ToolCallBlock — 「已审查」', () => {
  it('UI-M1 done 且 details 带标记：摘要行按钮里恰一枚 [data-tool-reviewed="medium"]，在摘要之后，里面是 shield-check；title 恰为 hint + 换行 + summary', () => {
    render(block({ status: 'done', result: 'ok', details: reviewed() }))

    const button = summaryButton(toolRow())
    const marks = reviewedMarks(button)
    expect(marks).toHaveLength(1)
    const mark = marks[0]
    expect(mark.getAttribute('data-tool-reviewed')).toBe('medium')
    expect(mark.querySelector('svg.lucide-shield-check')).not.toBeNull()
    expect(mark.getAttribute('title')).toBe(`${reviewedHint('medium')}\n${NOTE.summary}`)

    const detail = button.querySelector('span.font-mono')!
    expect(detail.textContent).toBeTruthy()
    expect(detail.compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('UI-M2 实时（store 记录 done + 标记）与重开（只靠 props）渲染出的标记 outerHTML 相同', () => {
    setExecs(A, [liveExec({ status: 'done', result: 'ok', details: reviewed() })])
    const live = renderApart(block({ status: 'running' }))
    const liveMark = reviewedMarks(live)
    expect(liveMark).toHaveLength(1)

    useChatStore.setState({ sessionToolExecutions: {} })
    const reopened = renderApart(block({ status: 'done', result: 'ok', details: reviewed() }))
    const reopenedMark = reviewedMarks(reopened)
    expect(reopenedMark).toHaveLength(1)

    expect(liveMark[0].outerHTML).toBe(reopenedMark[0].outerHTML)
  })

  it('UI-M3 status error：带标记也不显示', () => {
    render(block({ status: 'error', result: 'boom', details: reviewed() }))
    expect(reviewedMarks()).toHaveLength(0)
  })

  it('UI-M4 status running：带标记也不显示', () => {
    render(block({ status: 'running', details: reviewed() }))
    expect(reviewedMarks()).toHaveLength(0)
  })

  it("UI-M5 坏标记（risk 'severe'）与没有标记渲染出的 innerHTML 逐字相同", () => {
    const bad = {
      ...bashDetails(),
      shuvixReview: { risk: 'severe', summary: 'x' }
    } as unknown as ToolResultDetails
    const withBad = renderApart(block({ status: 'done', result: 'ok', details: bad }))
    const without = renderApart(block({ status: 'done', result: 'ok', details: bashDetails() }))
    expect(reviewedMarks(withBad)).toHaveLength(0)
    expect(withBad.innerHTML).toBe(without.innerHTML)
  })

  it.each(PERMISSION_RISKS)(
    'UI-M6 风险 %s：data-tool-reviewed 取该档、title 插该档说法、配色对应',
    (risk) => {
      render(block({ status: 'done', result: 'ok', details: reviewed({ risk, summary: 's' }) }))
      const [mark] = reviewedMarks()
      expect(mark.getAttribute('data-tool-reviewed')).toBe(risk)
      expect(mark.getAttribute('title')).toBe(`${reviewedHint(risk)}\ns`)
      expect(mark.getAttribute('title')).toContain(riskLabel(risk))

      const cls = mark.classList
      if (risk === 'low') {
        expect(cls.contains('text-error')).toBe(false)
        expect(cls.contains('text-warning')).toBe(false)
      } else if (risk === 'medium') {
        expect(cls.contains('text-warning')).toBe(true)
        expect(cls.contains('text-error')).toBe(false)
      } else {
        expect(cls.contains('text-error')).toBe(true)
      }
    }
  )

  it("UI-M7 summary '{{risk}} <b>x</b>'：title 逐字以它结尾（不被插值劫持），DOM 里没有 b 元素", () => {
    const summary = '{{risk}} <b>x</b>'
    render(block({ status: 'done', result: 'ok', details: reviewed({ risk: 'high', summary }) }))
    const [mark] = reviewedMarks()
    expect(mark.getAttribute('title')!.endsWith(`\n${summary}`)).toBe(true)
    expect(mark.getAttribute('title')).toBe(`${reviewedHint('high')}\n${summary}`)
    expect(container.querySelector('b')).toBeNull()
  })

  it.each([
    ['空串', ''],
    ['只有空白', '  \n\t ']
  ])('UI-M8 summary 为%s：title 恰为 hint，没有尾随换行', (_label, summary) => {
    render(block({ status: 'done', result: 'ok', details: reviewed({ risk: 'low', summary }) }))
    const [mark] = reviewedMarks()
    expect(mark.getAttribute('title')).toBe(reviewedHint('low'))
  })

  it('UI-M9 块没有 toolCallId 时也显示标记', () => {
    render(block({ toolCallId: undefined, status: 'done', result: 'ok', details: reviewed() }))
    expect(reviewedMarks()).toHaveLength(1)
  })

  it('UI-M10 展开之后，摘要行上仍有且只有一枚', () => {
    render(block({ status: 'done', result: 'ok', details: reviewed() }))
    const row = toolRow()
    act(() => summaryButton(row).click())
    // 确实展开了：终端形态的提示符出现
    expect([...row.querySelectorAll('span')].some((s) => s.textContent === '❯')).toBe(true)
    expect(reviewedMarks(summaryButton(row))).toHaveLength(1)
    expect(reviewedMarks(row)).toHaveLength(1)
  })
})

// ─── UI-M11：步骤合并行 ───────────────────────────────────

describe('StepGroup — 折起来时挂段内风险最高的那一枚', () => {
  const toolBlock = (id: string, details?: ToolResultDetails): AssistantToolBlock => ({
    type: 'tool',
    toolCallId: id,
    toolName: 'bash',
    args: { command: `echo ${id}`, description: `step ${id}` },
    result: 'ok',
    details
  })
  const group = (): HTMLElement => container.querySelector<HTMLElement>('[data-step-group]')!
  const groupButton = (): HTMLButtonElement => group().querySelector('button') as HTMLButtonElement

  it('UI-M11 两步分别 low / high → 合并行恰一枚 high；展开后合并行本身不挂、各行自己挂', () => {
    render(
      createElement(StepGroup, {
        blocks: [
          toolBlock('c1', reviewed({ risk: 'low', summary: 'first' })),
          toolBlock('c2', reviewed({ risk: 'high', summary: 'second' }))
        ]
      })
    )
    expect(group().getAttribute('data-group-state')).toBe('collapsed')
    const marks = reviewedMarks(group())
    expect(marks).toHaveLength(1)
    expect(marks[0].getAttribute('data-tool-reviewed')).toBe('high')
    expect(marks[0].getAttribute('title')).toBe(`${reviewedHint('high')}\nsecond`)
    expect(groupButton().contains(marks[0])).toBe(true)

    act(() => groupButton().click())
    expect(group().getAttribute('data-group-state')).toBe('expanded')
    expect(reviewedMarks(groupButton())).toHaveLength(0)
    const rows = [...group().querySelectorAll<HTMLElement>('[data-tool-name="bash"]')]
    expect(rows).toHaveLength(2)
    expect(
      rows.map((r) => reviewedMarks(r).map((m) => m.getAttribute('data-tool-reviewed')))
    ).toEqual([['low'], ['high']])
  })

  it('UI-M11 段内没有标记 → 合并行不挂', () => {
    render(
      createElement(StepGroup, {
        blocks: [toolBlock('c1', bashDetails()), toolBlock('c2', undefined)]
      })
    )
    expect(reviewedMarks(group())).toHaveLength(0)
  })
})

// ─── UI-A：询问卡片上的审查意见 ────────────────────────────

describe('AskForm — 审查员交给你的那次，卡片上附它的意见', () => {
  const REVIEW: AskReview = {
    risk: 'high',
    summary: 'Deletes the build folder and everything in it',
    reason: 'The user did not ask to delete anything'
  }
  const ask = (extra: Partial<AskInputRequest> = {}): AskInputRequest => ({
    id: 'tc-1',
    kind: 'ask',
    toolName: 'bash',
    command: 'rm -rf build',
    description: 'Clean the build',
    createdAt: 0,
    ...extra
  })
  const form = (
    request: AskInputRequest,
    onSubmit: (response: unknown) => void = vi.fn()
  ): ReturnType<typeof createElement> =>
    createElement(AskForm, { request, draft: {}, onDraftChange: vi.fn(), onSubmit })

  const opinion = (scope: ParentNode = container): HTMLElement[] => [
    ...scope.querySelectorAll<HTMLElement>('[data-ask-review]')
  ]
  const before = (a: Node, b: Node): boolean =>
    !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
  const button = (text: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll('button')].find((b) => b.textContent === text)
    if (!found) throw new Error(`button ${text} not rendered`)
    return found
  }

  it('UI-A1 review high：恰一栏 [data-ask-review="high"]，含风险标签、summary 原文与「审查员： reason」一行', () => {
    render(form(ask({ review: REVIEW })))
    const els = opinion()
    expect(els).toHaveLength(1)
    const el = els[0]
    expect(el.getAttribute('data-ask-review')).toBe('high')
    expect(el.textContent).toContain(riskLabel('high'))
    expect(el.textContent).toContain(REVIEW.summary)
    const reasonLine = el.querySelector('p')
    expect(reasonLine?.textContent).toBe(`${tr('toolCall.reviewReasonLabel')} ${REVIEW.reason}`)
  })

  it('UI-A2 这一栏在标题行之后、命令原文 code.hljs 之前', () => {
    render(form(ask({ review: REVIEW })))
    const title = container.querySelector('p')!
    const [el] = opinion()
    const code = container.querySelector('code.hljs')!
    expect(code).not.toBeNull()
    expect(before(title, el)).toBe(true)
    expect(before(el, code)).toBe(true)
  })

  it.each<[string, Partial<AskInputRequest>, (scope: HTMLElement) => Element | null]>([
    ['命令', {}, (scope) => scope.querySelector('code.hljs')],
    [
      '路径询问 Read(/w/a.txt)',
      { toolName: 'read', command: 'Read(/w/a.txt)' },
      (scope) =>
        [...scope.querySelectorAll('div.font-mono')].find((d) =>
          d.textContent?.startsWith('/w/a.txt')
        ) ?? null
    ],
    [
      'diff 预览',
      {
        toolName: 'write',
        command: 'Write(/w/a.txt)',
        preview: { kind: 'diff', path: '/w/a.txt', diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n' }
      },
      (scope) => scope.querySelector('table')
    ]
  ])('UI-A3 %s：审查意见在预览之上', (_label, extra, previewOf) => {
    render(form(ask({ review: REVIEW, ...extra })))
    const preview = previewOf(container)
    expect(preview).not.toBeNull()
    const [el] = opinion()
    expect(before(el, preview!)).toBe(true)
  })

  it('UI-A4 同一请求有 / 无 review 各渲染一次：前者去掉 [data-ask-review] 之后 innerHTML 与后者逐字相同', () => {
    const withReview = renderApart(form(ask({ review: REVIEW })))
    const withoutReview = renderApart(form(ask()))
    expect(opinion(withReview)).toHaveLength(1)
    expect(opinion(withoutReview)).toHaveLength(0)
    const clone = withReview.cloneNode(true) as HTMLElement
    clone.querySelector('[data-ask-review]')!.remove()
    expect(clone.innerHTML).toBe(withoutReview.innerHTML)
  })

  it.each([
    ['空串', ''],
    ['只有空白', '   \n ']
  ])('UI-A5 summary 为%s：显示 reviewNoSummary 兜底', (_label, summary) => {
    render(form(ask({ review: { ...REVIEW, summary } })))
    expect(opinion()[0].textContent).toContain(tr('toolCall.reviewNoSummary'))
  })

  it('UI-A5 summary 非空：不出现兜底', () => {
    render(form(ask({ review: REVIEW })))
    expect(container.textContent).not.toContain(tr('toolCall.reviewNoSummary'))
  })

  it.each([
    ['空串', ''],
    ['只有空白', ' \t ']
  ])('UI-A6 reason 为%s：没有 reason 行', (_label, reason) => {
    render(form(ask({ review: { ...REVIEW, reason } })))
    const [el] = opinion()
    expect(el.querySelector('p')).toBeNull()
    expect(el.textContent).not.toContain(tr('toolCall.reviewReasonLabel'))
  })

  it('UI-A7 summary / reason 里的 <img onerror> 不生成元素，原串作为文字出现', () => {
    const summary = '<img src=x onerror="alert(1)"> summary'
    const reason = '<img src=y onerror="alert(2)"> reason'
    render(form(ask({ review: { risk: 'medium', summary, reason } })))
    expect(container.querySelector('img')).toBeNull()
    const [el] = opinion()
    expect(el.textContent).toContain(summary)
    expect(el.textContent).toContain(reason)
  })

  it('UI-A8 带 review 时点允许 → {kind:ask, allowed:true}；点拒绝 → allowed:false', () => {
    const onSubmit = vi.fn()
    render(form(ask({ review: REVIEW }), onSubmit))
    act(() => button(tr('toolCall.allow')).click())
    expect(onSubmit).toHaveBeenLastCalledWith({ kind: 'ask', allowed: true })
    act(() => button(tr('toolCall.deny')).click())
    expect(onSubmit).toHaveBeenLastCalledWith({ kind: 'ask', allowed: false })
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  it('UI-A9 栏内顺序：风险标签 → summary → reason', () => {
    render(form(ask({ review: REVIEW })))
    const [el] = opinion()
    const spans = [...el.querySelectorAll('span')]
    const badge = spans.find((s) => s.textContent === riskLabel('high'))!
    const summary = spans.find((s) => s.textContent === REVIEW.summary)!
    const reason = el.querySelector('p')!
    expect(badge).toBeDefined()
    expect(summary).toBeDefined()
    expect(before(badge, summary)).toBe(true)
    expect(before(summary, reason)).toBe(true)
  })

  it('UI-A10 与后台标签、完全访问标签同时出现', () => {
    render(form(ask({ review: REVIEW, background: true, unsandboxed: true })))
    expect(opinion()).toHaveLength(1)
    expect(container.textContent).toContain(tr('toolCall.backgroundTag'))
    expect(container.querySelector('[data-full-access]')).not.toBeNull()
  })
})

// ─── UI-K：一条完整的链 ───────────────────────────────────

describe('工具卡走完一次审查放行的调用（store 驱动）', () => {
  const MESSAGE_ID = 'msg-1'

  /** 与 StepGroupView 同一条规则：从 store 的卡片取块，按 result / isError 推 status 再交给 ToolCallBlock */
  function Probe(): React.JSX.Element | null {
    const blk = useChatStore((s) => {
      const card = s.messages.find((m) => m.id === MESSAGE_ID) as AssistantMessage | undefined
      return card?.blocks.find((b): b is AssistantToolBlock => b.type === 'tool')
    })
    if (!blk) return null
    return createElement(ToolCallBlock, {
      toolName: blk.toolName,
      toolCallId: blk.toolCallId,
      args: blk.args,
      result: blk.result,
      details: blk.details,
      status: blk.result === undefined ? 'running' : blk.isError ? 'error' : 'done'
    })
  }

  function seedCard(): void {
    const card: AssistantMessage = {
      id: MESSAGE_ID,
      sessionId: A,
      role: 'assistant',
      type: 'message',
      content: '',
      model: 'test-model',
      createdAt: 0,
      blocks: [{ type: 'tool', toolCallId: 'tc-1', toolName: 'bash', args: ARGS }],
      metadata: null
    }
    useChatStore.setState({ messages: [card] })
  }

  it('UI-K1 转圈 → 审查中 → 转圈 → 已审查（记下 title）→ finishStreaming 之后标记仍在、title 不变', () => {
    seedCard()
    render(createElement(Probe))
    const s = (): ReturnType<typeof useChatStore.getState> => useChatStore.getState()

    act(() => s().handleToolStart(A, liveExec({ messageId: MESSAGE_ID })))
    expect(spinner()).not.toBeNull()
    expect(reviewingEl()).toBeNull()

    act(() => s().setToolReviewing(A, 'tc-1', true))
    expect(reviewingEl()).not.toBeNull()
    expect(spinner()).toBeNull()

    act(() => s().setToolReviewing(A, 'tc-1', false))
    expect(reviewingEl()).toBeNull()
    expect(spinner()).not.toBeNull()

    act(() =>
      s().handleToolEnd(
        A,
        'tc-1',
        { status: 'done', result: 'removed', details: reviewed() },
        MESSAGE_ID
      )
    )
    const marks = reviewedMarks()
    expect(marks).toHaveLength(1)
    const title = marks[0].getAttribute('title')
    expect(title).toBe(`${reviewedHint('medium')}\n${NOTE.summary}`)
    expect(spinner()).toBeNull()

    act(() => s().finishStreaming(A))
    expect(s().sessionToolExecutions[A]).toBeUndefined()
    const after = reviewedMarks()
    expect(after).toHaveLength(1)
    expect(after[0].getAttribute('title')).toBe(title)
  })

  it('UI-K2 同一条链但 tool_end 为 error（审查拒绝）：没有标记、没有审查中，显示错误 X', () => {
    seedCard()
    render(createElement(Probe))
    const s = (): ReturnType<typeof useChatStore.getState> => useChatStore.getState()

    act(() => s().handleToolStart(A, liveExec({ messageId: MESSAGE_ID })))
    act(() => s().setToolReviewing(A, 'tc-1', true))
    act(() =>
      s().handleToolEnd(
        A,
        'tc-1',
        { status: 'error', result: 'Blocked by the reviewer: not what the user asked' },
        MESSAGE_ID
      )
    )

    expect(reviewedMarks()).toHaveLength(0)
    expect(reviewingEl()).toBeNull()
    expect(toolRow().querySelector('svg.lucide-x')).not.toBeNull()
    expect(toolRow().getAttribute('data-tool-status')).toBe('error')

    act(() => s().finishStreaming(A))
    expect(reviewedMarks()).toHaveLength(0)
    expect(toolRow().querySelector('svg.lucide-x')).not.toBeNull()
  })
})
