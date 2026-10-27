// @vitest-environment jsdom
/**
 * 审批卡片（inputs/AskForm）的形状：问题在上，下面一列占满宽度、带序号的选项行；桌面上数字键选行。
 *
 *   AC-1  各种请求（命令 / 能记文件夹的文件 / 家目录里的文件 / 目录 / 会话对话 / 没有宿主的文件）：第 i 行的序号是
 *         i + 1；点它交出的答复 = 焦点在 body 上按数字 i + 1 交出的答复；按「行数 + 1」什么都不交
 *   AC-2  目录询问：1 → 记住这个文件夹（rememberPath: true），2 → 拒绝
 *   AC-3  焦点在卡片外的 <textarea> 里按 1 → 什么都不交
 *   AC-4  触屏档、四行的文件询问：1–4 都不交；点一行照交
 *   AC-5  没有审查意见、说明前后带空白：`[data-ask-description]` 是去掉空白的说明；顶行 `[data-ask-title]` 是动作名
 *         （宿主表里 bash = Run Command）、截断（只断 class）；有审查意见时顶行同样截断
 *   AC-6  没有说明（未给 / 空串 / 只有空白）也没有审查意见：没有说明、没有审查意见那一栏；动作名自己就是标题
 *         （font-medium、不截断）；各种路径 / diff 询问的动作名
 *   AC-7  选项行在同一个 `[role=group]` 里，aria-label = 顶行的动作名；组里只有 `[data-ask-option]` 的按钮
 *         （策略角标、标签、预览都在组外）
 *   AC-8  titleAccessory 挂在顶行（`[data-ask-title]` 的父节点）的最末；有审查意见时风险标签在同一行、在它之前
 *   AC-9  策略角标：在预览之后、组外；平时只写策略名，title 是原文 + 署名；点开铺出原文（不交答复），再点收起；
 *         两份策略 'a · b'；没署名时角标就是原文；没有策略提示就没有角标；有角标时 1 照旧 = 允许这一次
 *   AC-10 （只断结构）预览最近的 `.overflow-y-auto` 祖先里有顶行、审查意见、策略角标，没有选项行；200 行的命令照样
 *         摆出全部选项行
 *   AC-11 各风险等级：风险标签的字；「需注意」那一句的颜色 class（低 text-text-secondary / 中 text-warning /
 *         高与严重 text-error，只断 class）
 *   AC-12 审批的选项行都不是勾选态：没有 aria-pressed
 *
 * 包入口 `@shuvix/chat-ui` 顶掉（AskForm 从那里取 getHostApi）；i18n 走真 en 资源。按键在目标元素上派发（bubbles +
 * cancelable + composed），每一下各自一个 act。文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type {
  AskInputRequest,
  AskReview,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import type { ToolPresentation } from '@shuvix/chat-protocol/types/toolPresentation'
import { PERMISSION_RISKS, type PermissionRisk } from '@shuvix/chat-protocol/types/permissionReview'

const host = vi.hoisted(() => ({ api: {} as unknown }))
vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => host.api }))

import { AskForm } from '../inputs/AskForm'
import { useChatStore } from '../../../stores/chatStore'
import { ChatHostContext, type ChatHostValue } from '../../../host/chatHostContext'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TERMINAL: ToolPresentation = {
  label: 'Run Command',
  icon: 'Terminal',
  detailView: 'terminal'
}
const REVIEW: AskReview = {
  risk: 'high',
  summary: 'Deletes the build folder and everything in it',
  reason: 'The user did not ask to delete anything'
}

let container: HTMLDivElement
let root: Root
/** 每次 render 换一个 key：卡片是新挂的一张（「重新渲染一张新的」） */
let renderSeq = 0

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
  useChatStore.setState({ toolPresentations: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  useChatStore.setState({ toolPresentations: {} })
})

const ask = (extra: Partial<AskInputRequest> = {}): AskInputRequest => ({
  id: 'tc-1',
  kind: 'ask',
  toolName: 'read',
  command: 'Read(/Users/u/proj/docs/a.md)',
  description: '',
  createdAt: 0,
  ...extra
})

const SESSION_ID = 'sess-0123456789ab'
const sessionAsk = (): AskInputRequest =>
  ask({
    toolName: 'session',
    command: `session "Refactor plan" (${SESSION_ID})`,
    session: {
      sessionId: SESSION_ID,
      title: 'Refactor plan',
      access: 'write',
      operation: 'prompt-session'
    },
    preview: { kind: 'message', text: 'Please summarize the plan.' }
  })

function render(
  request: AskInputRequest,
  opts: {
    onSubmit?: ReturnType<typeof vi.fn>
    touch?: boolean
    accessory?: ReturnType<typeof createElement>
  } = {}
): ReturnType<typeof vi.fn> {
  const onSubmit = opts.onSubmit ?? vi.fn()
  const form = createElement(AskForm, {
    key: `card-${++renderSeq}`,
    request,
    draft: {},
    onDraftChange: vi.fn(),
    onSubmit: onSubmit as (response: InputResponse) => void,
    titleAccessory: opts.accessory
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
  ...container.querySelectorAll<HTMLButtonElement>('[data-ask-option]')
]
const rowIds = (): string[] => rows().map((r) => r.dataset.askOption ?? '')
const row = (id: string): HTMLButtonElement => {
  const el = container.querySelector<HTMLButtonElement>(`[data-ask-option="${id}"]`)
  if (!el) throw new Error(`option row ${id} not rendered`)
  return el
}
/** 行首的序号格（按钮的第一个子元素） */
const badgeOf = (r: HTMLElement): HTMLElement => r.firstElementChild as HTMLElement
const titleEl = (): HTMLElement => {
  const el = container.querySelector<HTMLElement>('[data-ask-title]')
  if (!el) throw new Error('ask title not rendered')
  return el
}
const classesOf = (el: Element): string[] => (el.getAttribute('class') ?? '').split(/\s+/)
const before = (a: Node, b: Node): boolean =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
const tr = (key: string, opts?: Record<string, unknown>): string => {
  const text = i18n.t(key, opts)
  expect(text, key).not.toBe(key)
  return text
}

// ─── AC-1..4：序号与数字键 ─────────────────────────────────

describe('AskForm：选项行的序号与数字键', () => {
  it.each<[string, () => AskInputRequest, number, unknown]>([
    ['命令 bash ls', () => ask({ toolName: 'bash', command: 'ls' }), 2, {}],
    ['能记文件夹的文件', () => ask(), 4, {}],
    ['家目录里的文件', () => ask({ command: 'Read(/Users/u/notes.txt)' }), 3, {}],
    ['目录', () => ask({ command: 'Read(/Users/u/proj/docs)', pathIsDirectory: true }), 2, {}],
    ['会话对话询问', sessionAsk, 3, {}],
    ['没有宿主的文件读', () => ask(), 2, null]
  ])('AC-1 %s：第 i 行序号 i+1；点它 = 按数字 i+1；行数 + 1 不交', (_label, make, count, api) => {
    host.api = api
    render(make())
    expect(rows()).toHaveLength(count)
    const ids = rowIds()
    const payloads: unknown[] = []
    ids.forEach((id, i) => {
      expect(badgeOf(row(id)).textContent, `${id} badge`).toBe(String(i + 1))
      const onSubmit = render(make())
      act(() => row(id).click())
      expect(onSubmit, `${id} click`).toHaveBeenCalledTimes(1)
      payloads.push(onSubmit.mock.calls[0]![0])
    })
    ids.forEach((id, i) => {
      const onSubmit = render(make())
      expect(document.activeElement).toBe(document.body)
      expect(press(String(i + 1)), `${id} digit handled`).toBe(false)
      expect(onSubmit, `${id} digit`).toHaveBeenCalledTimes(1)
      expect(onSubmit.mock.lastCall![0]).toEqual(payloads[i])
    })
    const onSubmit = render(make())
    expect(press(String(count + 1))).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('AC-2 目录询问：1 = 记住这个文件夹，2 = 拒绝', () => {
    const dir = (): AskInputRequest =>
      ask({ command: 'Read(/Users/u/proj/docs)', pathIsDirectory: true })
    let onSubmit = render(dir())
    press('1')
    expect(onSubmit.mock.calls).toEqual([
      [{ kind: 'ask', allowed: true, extra: { rememberPath: true } }]
    ])
    onSubmit = render(dir())
    press('2')
    expect(onSubmit.mock.calls).toEqual([[{ kind: 'ask', allowed: false }]])
  })

  it('AC-3 焦点在卡片外的 <textarea> 里按 1 → 什么都不交', () => {
    const onSubmit = render(ask({ toolName: 'bash', command: 'ls' }))
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    ta.focus()
    expect(document.activeElement).toBe(ta)
    expect(press('1', ta)).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('AC-4 触屏档、四行的文件询问：1–4 都不交；点一行照交', () => {
    const onSubmit = render(ask(), { touch: true })
    expect(rows()).toHaveLength(4)
    for (const key of ['1', '2', '3', '4']) expect(press(key), key).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
    act(() => row('deny').click())
    expect(onSubmit.mock.calls).toEqual([[{ kind: 'ask', allowed: false }]])
  })
})

// ─── AC-5..8：顶行、标题、选项组 ────────────────────────────

describe('AskForm：顶行与标题', () => {
  it('AC-5 说明去掉首尾空白成标题；顶行是动作名（宿主表里的 Run Command）、截断', () => {
    useChatStore.setState({ toolPresentations: { bash: TERMINAL } })
    render(ask({ toolName: 'bash', command: 'rm -rf build', description: '  Clean the build  ' }))
    expect(container.querySelector('[data-ask-description]')?.textContent).toBe('Clean the build')
    expect(titleEl().textContent).toBe('Run Command')
    expect(classesOf(titleEl())).toContain('truncate')
  })

  it('AC-5 有审查意见（也有说明）：顶行同样截断', () => {
    useChatStore.setState({ toolPresentations: { bash: TERMINAL } })
    render(
      ask({
        toolName: 'bash',
        command: 'rm -rf build',
        description: 'Clean the build',
        review: REVIEW
      })
    )
    expect(classesOf(titleEl())).toContain('truncate')
    expect(container.querySelector('[data-ask-description]')).toBeNull()
  })

  it.each<[string, string | undefined]>([
    ['未给', undefined],
    ['空串', ''],
    ['只有空白', '   ']
  ])(
    'AC-6 说明%s、没有审查意见：动作名自己就是标题（font-medium、不截断）',
    (_label, description) => {
      useChatStore.setState({ toolPresentations: { bash: TERMINAL } })
      render(ask({ toolName: 'bash', command: 'ls', description }))
      expect(container.querySelector('[data-ask-description]')).toBeNull()
      expect(container.querySelector('[data-ask-review]')).toBeNull()
      expect(titleEl().textContent).toBe('Run Command')
      const cls = classesOf(titleEl())
      expect(cls).toContain('font-medium')
      expect(cls).not.toContain('truncate')
    }
  )

  const DIFF = '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n'
  it.each<[string, Partial<AskInputRequest>]>([
    ['pendingPathWrite', { toolName: 'write', command: 'Write(/Users/u/proj/out/b.txt)' }],
    ['pendingPathReadDir', { command: 'Read(/Users/u/proj/docs)', pathIsDirectory: true }],
    [
      'pendingCreatePreview',
      {
        toolName: 'write',
        command: 'Write(/Users/u/proj/new.txt)',
        preview: { kind: 'diff', path: '/Users/u/proj/new.txt', diff: DIFF, isNewFile: true }
      }
    ],
    [
      'pendingEditPreview',
      {
        toolName: 'edit',
        command: 'Write(/Users/u/proj/a.txt)',
        preview: { kind: 'diff', path: '/Users/u/proj/a.txt', diff: DIFF }
      }
    ],
    [
      'pendingWritePreview',
      {
        toolName: 'write',
        command: 'Write(/Users/u/proj/a.txt)',
        preview: { kind: 'diff', path: '/Users/u/proj/a.txt', diff: DIFF }
      }
    ]
  ])('AC-6 %s 的动作名就是标题', (key, extra) => {
    render(ask({ description: undefined, ...extra }))
    expect(titleEl().textContent).toBe(tr(`toolCall.${key}`))
    expect(classesOf(titleEl())).toContain('font-medium')
    expect(classesOf(titleEl())).not.toContain('truncate')
    expect(container.querySelector('[data-ask-description]')).toBeNull()
  })

  it('AC-7 选项行在一个 [role=group] 里，aria-label = 动作名；组里只有选项行（角标、标签、预览都在组外）', () => {
    useChatStore.setState({ toolPresentations: { bash: TERMINAL } })
    render(
      ask({
        toolName: 'bash',
        command: 'rm -rf build',
        review: REVIEW,
        background: true,
        unsandboxed: true,
        policyPrompt: { text: 'Runs with full access.', policies: ['ask-on-command'] }
      })
    )
    const groups = container.querySelectorAll<HTMLElement>('[role="group"]')
    expect(groups).toHaveLength(1)
    const group = groups[0]
    expect(group.getAttribute('aria-label')).toBe(titleEl().textContent)
    expect(group.getAttribute('aria-label')).toBe('Run Command')
    const kids = [...group.children]
    expect(kids.length).toBe(rows().length)
    for (const kid of kids) {
      expect(kid.tagName).toBe('BUTTON')
      expect(kid.hasAttribute('data-ask-option')).toBe(true)
    }
    expect(group.querySelectorAll('button')).toHaveLength(rows().length)
    for (const sel of [
      '[data-ask-policy]',
      '[data-ask-preview]',
      '[data-ask-review-risk]',
      '[data-ask-review]',
      '[data-full-access]',
      '[data-ask-title]'
    ]) {
      expect(container.querySelector(sel), sel).not.toBeNull()
      expect(group.querySelector(sel), sel).toBeNull()
    }
    expect(group.textContent).not.toContain(tr('toolCall.backgroundTag'))
  })

  it('AC-8 titleAccessory 是顶行的最后一个元素；有审查意见时风险标签在同一行、在它之前', () => {
    const acc = (): ReturnType<typeof createElement> =>
      createElement('span', { 'data-acc': '' }, 'ACC')
    render(ask({ toolName: 'bash', command: 'ls' }), { accessory: acc() })
    let line = titleEl().parentElement!
    let accEl = container.querySelector('[data-acc]')!
    expect(accEl.parentElement).toBe(line)
    expect(line.lastElementChild).toBe(accEl)

    render(ask({ toolName: 'bash', command: 'ls', review: REVIEW }), { accessory: acc() })
    line = titleEl().parentElement!
    accEl = container.querySelector('[data-acc]')!
    const risk = container.querySelector('[data-ask-review-risk]')!
    expect(accEl.parentElement).toBe(line)
    expect(line.lastElementChild).toBe(accEl)
    expect(risk.parentElement).toBe(line)
    expect(before(risk, accEl)).toBe(true)
  })
})

// ─── AC-9：策略角标 ─────────────────────────────────────────

describe('AskForm：策略角标', () => {
  const T = 'Allowed commands run with your full system permissions.'
  const chip = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('[data-ask-policy]')
  const expandedText = (text: string): HTMLParagraphElement[] =>
    [...container.querySelectorAll('p')].filter((p) => p.textContent === text)

  it('AC-9a 一份策略：在预览之后、组外；字是策略名，title 是原文 + 署名；点开铺出原文、不交答复，再点收起', () => {
    const onSubmit = render(
      ask({
        toolName: 'bash',
        command: 'ls',
        policyPrompt: { text: T, policies: ['ask-on-command'] }
      })
    )
    const c = chip()!
    expect(c).not.toBeNull()
    const preview = container.querySelector('[data-ask-preview]')!
    expect(before(preview, c)).toBe(true)
    expect(c.closest('[role="group"]')).toBeNull()
    expect(c.textContent).toBe('ask-on-command')
    expect(c.title).toBe(`${T}\n${tr('toolCall.policyPromptFrom', { policies: 'ask-on-command' })}`)
    expect(container.textContent).not.toContain(T)
    expect(expandedText(T)).toHaveLength(0)

    act(() => c.click())
    expect(expandedText(T)).toHaveLength(1)
    expect(onSubmit).not.toHaveBeenCalled()

    act(() => chip()!.click())
    expect(expandedText(T)).toHaveLength(0)
    expect(container.textContent).not.toContain(T)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("AC-9b 两份策略 → 'a · b'", () => {
    render(
      ask({ toolName: 'bash', command: 'ls', policyPrompt: { text: T, policies: ['a', 'b'] } })
    )
    expect(chip()!.textContent).toBe('a · b')
    expect(chip()!.title).toBe(`${T}\n${tr('toolCall.policyPromptFrom', { policies: 'a · b' })}`)
  })

  it('AC-9c 没有署名 → 角标就是原文，title 也是原文', () => {
    render(ask({ toolName: 'bash', command: 'ls', policyPrompt: { text: T, policies: [] } }))
    expect(chip()!.textContent).toBe(T)
    expect(chip()!.title).toBe(T)
  })

  it('AC-9d 没有策略提示 → 没有角标', () => {
    render(ask({ toolName: 'bash', command: 'ls' }))
    expect(chip()).toBeNull()
  })

  it('AC-9e 有角标时选项行与数字键照旧：1 = 允许这一次', () => {
    const onSubmit = render(
      ask({ toolName: 'bash', command: 'ls', policyPrompt: { text: T, policies: ['p'] } })
    )
    expect(rowIds()).toEqual(['allow', 'deny'])
    expect(rows().map((r) => badgeOf(r).textContent)).toEqual(['1', '2'])
    press('1')
    expect(onSubmit.mock.calls).toEqual([[{ kind: 'ask', allowed: true }]])
  })
})

// ─── AC-10..12 ──────────────────────────────────────────────

describe('AskForm：滚动段、风险等级、选项不是勾选态', () => {
  it('AC-10 预览所在的滚动段里有顶行、审查意见、策略角标，没有选项行；200 行的命令照样摆出全部选项行', () => {
    const command = Array.from({ length: 200 }, (_, i) => `echo line-${i}`).join('\n')
    render(
      ask({
        toolName: 'bash',
        command,
        review: { risk: 'medium', summary: 'Prints many lines', reason: 'Nothing risky' },
        policyPrompt: { text: 'Policy words', policies: ['ask-on-command'] }
      })
    )
    const preview = container.querySelector('[data-ask-preview]')!
    const scroller = preview.closest('.overflow-y-auto')
    expect(scroller).not.toBeNull()
    expect(scroller!.contains(titleEl())).toBe(true)
    expect(scroller!.querySelector('[data-ask-review]')).not.toBeNull()
    expect(scroller!.querySelector('[data-ask-policy]')).not.toBeNull()
    expect(scroller!.querySelector('[data-ask-option]')).toBeNull()
    expect(rowIds()).toEqual(['allow', 'deny'])
    expect(preview.textContent).toContain('echo line-199')
  })

  const REASON_CLASS: Record<PermissionRisk, string> = {
    low: 'text-text-secondary',
    medium: 'text-warning',
    high: 'text-error',
    critical: 'text-error'
  }
  it.each(PERMISSION_RISKS.map((r) => [r] as [PermissionRisk]))(
    'AC-11 风险 %s：标签的字与「需注意」那一句的颜色',
    (risk) => {
      render(
        ask({
          toolName: 'bash',
          command: 'ls',
          review: { risk, summary: 'Lists files', reason: 'Look before approving' }
        })
      )
      const badge = container.querySelector('[data-ask-review-risk]')!
      expect(badge.getAttribute('data-ask-review-risk')).toBe(risk)
      expect(badge.textContent).toBe(tr(`toolCall.reviewRisk.${risk}`))
      const reason = container.querySelector('[data-ask-review-reason]')!
      const cls = classesOf(reason)
      expect(cls).toContain(REASON_CLASS[risk])
      for (const other of new Set(Object.values(REASON_CLASS))) {
        if (other !== REASON_CLASS[risk]) expect(cls).not.toContain(other)
      }
    }
  )

  it('AC-12 审批的选项行都没有 aria-pressed', () => {
    for (const make of [
      () => ask(),
      () => ask({ toolName: 'bash', command: 'ls' }),
      () => ask({ command: 'Read(/Users/u/proj/docs)', pathIsDirectory: true }),
      sessionAsk
    ]) {
      render(make())
      expect(rows().length).toBeGreaterThan(0)
      for (const r of rows())
        expect(r.hasAttribute('aria-pressed'), r.dataset.askOption).toBe(false)
    }
  })
})
