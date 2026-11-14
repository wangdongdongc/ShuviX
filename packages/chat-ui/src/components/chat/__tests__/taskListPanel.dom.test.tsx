// @vitest-environment jsdom
/**
 * 任务列表（TaskListPanel，内置工具 `update_plan`，docs/task-list-design.md §3.4；jsdom）：
 *
 *   TLU-1      没有列表调用 / 只有失败的或还在跑的 → 不渲染
 *   TLU-2      进行中：样子、逐行状态与图标
 *   TLU-3      已完成（空闲 + 最终回复收尾）：全部算完成，没有转圈
 *   TLU-4 / 5  已停止（空闲 + 末条带工具 / 是错误行）：状态照实，进行中那步换成暂停
 *   TLU-5b     末条是被中止截断的正文（投影带 `metadata.stopped`）→ 已停止，不是完成
 *   TLU-6      被中断的会话按收尾方式判，从不显示进行中
 *   TLU-7      乐观占位的新消息 → 让位；撤下占位（没有新消息）→ 回来
 *   TLU-8 / 9  新请求清掉列表；插话（带说明 Token）、系统通知不算新请求
 *   TLU-10     还在跑的推进、失败的推进都不折进去
 *   TLU-11     只有步骤行：没有标题行、没有按钮，三种样子、两个位置都不折叠（2026-11-10 简化）
 *   TLU-12     触屏密度：行距与字号放大
 *   TLU-13     进行中但没有进行中的步骤：全是待做，没有转圈
 *   TLU-14     列表的无障碍名称三种语言
 *   TLU-15     长列表自身封顶滚动
 *   TLU-18     两个位置：对话里自带圆角描边、外面套一层居中的列宽；输入框里只有 border-b
 *
 * 直接挂 `<TaskListPanel/>`；状态只经 `applySessionView` 写（与 inputAreaQueue.dom.test.tsx 同一种做法）。
 * 文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { RunViewState } from '@shuvix/chat-protocol/types/sessionView'
import { TASK_LIST_TOOL_NAME, type TaskListStatus } from '@shuvix/chat-protocol/taskList'
import { MID_RUN_NOTE_UID, midRunNoteToken } from '@shuvix/chat-protocol/midRunNote'

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))

import { applySessionView, pendingPromptMessage } from '../../../stores/chatStore'
import { ChatHostContext, type ChatHostValue } from '../../../host/chatHostContext'
import { TaskListPanel } from '../TaskListPanel'
import {
  V,
  assistant,
  errorRow,
  resetStore,
  store,
  text,
  toolBlock,
  user
} from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PLAN = TASK_LIST_TOOL_NAME
const STEPS = ['Read the code', 'Write the fix', 'Run the tests']

let container: HTMLDivElement
let root: Root

// ─── 造数据 ────────────────────────────────────────────────

/** `items` 参数：按给定状态逐步配上 STEPS 的文字 */
function items(...statuses: TaskListStatus[]): Record<string, unknown> {
  return {
    items: statuses.map((status, i) => ({ content: STEPS[i] ?? `Step ${i + 1}`, status }))
  }
}

/** 成功的列表调用 */
const planOk = (id: string, args: Record<string, unknown>): ReturnType<typeof toolBlock> =>
  toolBlock(id, PLAN, args, { result: 'Plan shown.' })

/** 运行中插进来的话：投影里带插话说明 Token */
const steer = (id: string, content: string): ChatMessage =>
  user(id, content, 's1', { inlineTokens: { [MID_RUN_NOTE_UID]: midRunNoteToken() } })

/** 一个请求：用户消息 + 一张发列表的卡（同一条消息里带一次真的工具调用） */
function request(
  uid: string,
  args: Record<string, unknown>,
  sid = 's1',
  planId = `p-${uid}`
): ChatMessage[] {
  return [
    user(uid, 'please', sid),
    assistant(
      `a-${uid}`,
      [text('starting'), planOk(planId, args), toolBlock(`r-${uid}`, 'read', {}, { result: 'x' })],
      sid
    )
  ]
}

const finalAnswer = (id: string, sid = 's1'): ChatMessage => assistant(id, [text('All done.')], sid)

function show(messages: ChatMessage[], state: RunViewState = 'busy', sid = 's1'): void {
  act(() => applySessionView(sid, V(sid, { messages, run: { state } })))
}

// ─── 挂载 ──────────────────────────────────────────────────

function mount(density?: ChatHostValue['density'], placement?: 'conversation' | 'composer'): void {
  const panel = createElement(TaskListPanel, placement ? { placement } : {})
  act(() =>
    root.render(
      density
        ? createElement(ChatHostContext.Provider, { value: { density } as ChatHostValue }, panel)
        : panel
    )
  )
}

// ─── 读取 ──────────────────────────────────────────────────

const panel = (): HTMLElement | null => container.querySelector<HTMLElement>('[data-task-list]')
const phase = (): string | null => panel()?.getAttribute('data-task-list-phase') ?? null
const stepRows = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-task-step]')
]
const steps = (): Array<{ n: string | null; status: string | null; text: string }> =>
  stepRows().map((row) => ({
    n: row.getAttribute('data-task-step'),
    status: row.getAttribute('data-status'),
    text: row.textContent ?? ''
  }))
const statuses = (): Array<string | null> => steps().map((s) => s.status)

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en }, zh: { translation: zh }, ja: { translation: ja } },
    showSupportNotice: false
  })
})

beforeEach(async () => {
  await i18n.changeLanguage('en')
  resetStore('s1')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('什么时候不画（TLU-1）', () => {
  it('TLU-1 没有列表调用（别的工具照样有）→ 不渲染', () => {
    show([user('u1', 'hi'), assistant('a1', [toolBlock('r1', 'read', {}, { result: 'x' })])])
    mount()
    expect(panel()).toBeNull()
  })

  it('TLU-1 只有失败的列表调用，或还在跑的（没有结果）→ 不渲染', () => {
    show([
      user('u1', 'hi'),
      assistant('a1', [
        toolBlock('p1', PLAN, items('in_progress', 'pending'), {
          result: 'bad',
          isError: true
        }),
        toolBlock('p2', PLAN, items('in_progress', 'pending'))
      ])
    ])
    mount()
    expect(panel()).toBeNull()
  })
})

describe('三种样子（TLU-2…TLU-6）', () => {
  it('TLU-2 进行中：phase running、三行状态与图标', () => {
    show(request('u1', items('completed', 'in_progress', 'pending')))
    mount()
    expect(phase()).toBe('running')
    expect(steps()).toEqual([
      { n: '1', status: 'completed', text: STEPS[0] },
      { n: '2', status: 'in_progress', text: STEPS[1] },
      { n: '3', status: 'pending', text: STEPS[2] }
    ])
    const [done, current, pending] = stepRows()
    expect(current.querySelector('svg.animate-spin')).not.toBeNull()
    expect(done.querySelector('svg.lucide-circle-check')).not.toBeNull()
    expect(done.querySelector('svg.animate-spin')).toBeNull()
    expect(pending.querySelector('svg.lucide-circle')).not.toBeNull()
    expect(pending.querySelector('svg.animate-spin')).toBeNull()
    // 完成的那一步划掉，其余不划
    expect(done.querySelector('span.line-through')?.textContent).toBe(STEPS[0])
    expect(current.querySelector('span.line-through')).toBeNull()
    expect(pending.querySelector('span.line-through')).toBeNull()
  })

  it('TLU-3 已完成（空闲 + 最终回复）：phase done，每步都是 completed，没有转圈', () => {
    show(
      [...request('u1', items('completed', 'in_progress', 'pending')), finalAnswer('a2')],
      'idle'
    )
    mount()
    expect(phase()).toBe('done')
    expect(statuses()).toEqual(['completed', 'completed', 'completed'])
    expect(container.querySelector('svg.animate-spin')).toBeNull()
  })

  it('TLU-4 已停止（空闲 + 末条带工具）：phase stopped、状态照实，进行中那步是暂停图标', () => {
    show(request('u1', items('completed', 'in_progress', 'pending')), 'idle')
    mount()
    expect(phase()).toBe('stopped')
    expect(statuses()).toEqual(['completed', 'in_progress', 'pending'])
    const current = stepRows()[1]
    expect(current.querySelector('svg.lucide-circle-pause')).not.toBeNull()
    expect(current.querySelector('svg.animate-spin')).toBeNull()
  })

  it('TLU-5 末条是错误行 → 已停止', () => {
    show(
      [...request('u1', items('completed', 'in_progress', 'pending')), errorRow('e1', 'boom')],
      'idle'
    )
    mount()
    expect(phase()).toBe('stopped')
    expect(statuses()).toEqual(['completed', 'in_progress', 'pending'])
  })

  it('TLU-5b 末条是被中止截断的正文（`metadata.stopped`，没有工具块）→ 已停止，状态不被补满', () => {
    const aborted = assistant('a2', [text('I was saying')], 's1', { stopped: true })
    show([...request('u1', items('completed', 'in_progress', 'pending')), aborted], 'idle')
    mount()
    expect(phase()).toBe('stopped')
    expect(statuses()).toEqual(['completed', 'in_progress', 'pending'])

    // 对照：同样的正文不带 stopped → 完成
    show(
      [...request('u1', items('completed', 'in_progress', 'pending')), finalAnswer('a2')],
      'idle'
    )
    expect(phase()).toBe('done')
    expect(statuses()).toEqual(['completed', 'completed', 'completed'])
  })

  it('TLU-6 被中断的会话按收尾方式判：末条带工具 → stopped；末条是最终回复 → done；从不 running', () => {
    show(request('u1', items('completed', 'in_progress', 'pending')), 'interrupted')
    mount()
    expect(phase()).toBe('stopped')

    show(
      [...request('u1', items('completed', 'in_progress', 'pending')), finalAnswer('a2')],
      'interrupted'
    )
    expect(phase()).toBe('done')
  })
})

describe('请求的边界（TLU-7…TLU-10）', () => {
  it('TLU-7 乐观占位的新消息 → 不渲染（旧请求的列表让位）；撤下占位、也没有新消息 → 列表回来', () => {
    show(request('u1', items('in_progress', 'pending')))
    mount()
    expect(panel()).not.toBeNull()

    act(() => store().setPendingPrompt('s1', pendingPromptMessage('s1', 'next thing')))
    expect(panel()).toBeNull()

    act(() => store().setPendingPrompt('s1', null))
    expect(panel()).not.toBeNull()
    expect(phase()).toBe('running')
  })

  it('TLU-8 列表之后来了一条发起一轮的用户消息 → 不渲染', () => {
    show([...request('u1', items('in_progress', 'pending')), user('u2', 'something else')])
    mount()
    expect(panel()).toBeNull()
  })

  it('TLU-8 列表之后是一条插话（带说明 Token）→ 列表还在，会话在跑时仍是 running', () => {
    show([...request('u1', items('in_progress', 'pending')), steer('u2', 'also do X')])
    mount()
    expect(phase()).toBe('running')
    expect(statuses()).toEqual(['in_progress', 'pending'])
  })

  it('TLU-9 列表之后是一条系统通知（自动续跑）→ 列表还在', () => {
    show([
      ...request('u1', items('in_progress', 'pending')),
      user('n1', '<background-task id="t1">done</background-task>', 's1', { isSystemNotice: true })
    ])
    mount()
    expect(phase()).toBe('running')
    expect(statuses()).toEqual(['in_progress', 'pending'])
  })

  it('TLU-10 列表发出后：还在跑的 advance（没有结果）不折进去；失败的 advance 也不', () => {
    show([
      ...request('u1', items('in_progress', 'pending', 'pending')),
      assistant('a2', [toolBlock('p2', PLAN, { advance: true })])
    ])
    mount()
    expect(statuses()).toEqual(['in_progress', 'pending', 'pending'])

    show([
      ...request('u1', items('in_progress', 'pending', 'pending')),
      assistant('a2', [toolBlock('p2', PLAN, { advance: true }, { result: 'no', isError: true })])
    ])
    expect(statuses()).toEqual(['in_progress', 'pending', 'pending'])

    // 对照：成功的 advance 折进去
    show([
      ...request('u1', items('in_progress', 'pending', 'pending')),
      assistant('a2', [planOk('p2', { advance: true })])
    ])
    expect(statuses()).toEqual(['completed', 'in_progress', 'pending'])
  })
})

describe('只有步骤行（TLU-11）', () => {
  it.each([
    ['running', 'busy', false],
    ['done', 'idle', true],
    ['stopped', 'idle', false]
  ] as const)(
    'TLU-11 %s：列表本身就是 ol，子元素全是步骤行，没有按钮',
    (expected, state, withAnswer) => {
      const r = request('u1', items('completed', 'in_progress', 'pending'))
      show(withAnswer ? [...r, finalAnswer('a2')] : r, state)
      mount()
      expect(phase()).toBe(expected)
      const el = panel()!
      expect(el.tagName).toBe('OL')
      expect([...el.children].every((c) => c.hasAttribute('data-task-step'))).toBe(true)
      expect(stepRows()).toHaveLength(3)
      expect(container.querySelector('button')).toBeNull()
    }
  )

  it('TLU-11 输入框里（笔记本）、触屏密度：同样直接列出全部步骤', () => {
    show(request('u1', items('completed', 'in_progress', 'pending')))
    mount('touch', 'composer')
    expect(stepRows()).toHaveLength(3)
    expect(container.querySelector('button')).toBeNull()
  })
})

describe('触屏、全是待做、文案、长列表（TLU-12…TLU-15）', () => {
  it('TLU-12 触屏密度：行 py-1.5、文字 text-[14px]', () => {
    show(request('u1', items('completed', 'in_progress', 'pending')))
    mount('touch')
    expect(stepRows()).toHaveLength(3)
    for (const row of stepRows()) {
      expect(row.className).toContain('py-1.5')
      expect(row.querySelector('span.text-\\[14px\\]')).not.toBeNull()
    }
  })

  it('TLU-12 对照：桌面密度的行是 py-0.5 / text-[12px]', () => {
    show(request('u1', items('completed', 'in_progress', 'pending')))
    mount()
    for (const row of stepRows()) {
      expect(row.className).toContain('py-0.5')
      expect(row.querySelector('span.text-\\[12px\\]')).not.toBeNull()
    }
  })

  it('TLU-13 进行中但没有进行中的步骤（全是待做）：三行待做，没有转圈', () => {
    show(request('u1', items('pending', 'pending', 'pending')))
    mount()
    expect(phase()).toBe('running')
    expect(statuses()).toEqual(['pending', 'pending', 'pending'])
    expect(container.querySelector('svg.animate-spin')).toBeNull()
  })

  it.each([
    ['en', 'Task list'],
    ['zh', '任务列表'],
    ['ja', 'タスクリスト']
  ])('TLU-14 列表的无障碍名称（%s）：%s', async (lng, title) => {
    await i18n.changeLanguage(lng)
    show(request('u1', items('in_progress', 'pending')))
    mount()
    expect(panel()!.getAttribute('aria-label')).toBe(title)
  })

  it('TLU-15 长列表：列表自身封顶 30vh、竖向滚动', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      content: `Step ${i + 1}`,
      status: i === 0 ? 'in_progress' : 'pending'
    }))
    show(request('u1', { items: many }))
    mount()
    expect(stepRows()).toHaveLength(12)
    const list = panel()!
    expect(list.className).toContain('max-h-[30vh]')
    expect(list.className).toContain('overflow-y-auto')
  })
})

describe('两个位置（TLU-18）', () => {
  it('TLU-18 缺省（对话里）：自带圆角描边，外面套一层居中的列宽', () => {
    show(request('u1', items('in_progress', 'pending')))
    mount()
    const el = panel()!
    expect(el.getAttribute('data-task-list-placement')).toBe('conversation')
    expect(el.className).toContain('rounded-xl')
    expect(el.className).toContain('border ')
    expect(el.parentElement!.className).toContain('max-w-[784px]')
  })

  it('TLU-18 输入框里（笔记本）：只有 border-b，没有外层', () => {
    show(request('u1', items('in_progress', 'pending')))
    mount(undefined, 'composer')
    const el = panel()!
    expect(el.getAttribute('data-task-list-placement')).toBe('composer')
    expect(el.className).toContain('border-b')
    expect(el.className).not.toContain('rounded-xl')
    expect(el.parentElement).toBe(container)
  })
})
