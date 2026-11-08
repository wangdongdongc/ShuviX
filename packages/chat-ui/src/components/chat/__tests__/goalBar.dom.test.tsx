// @vitest-environment jsdom
/**
 * 目标栏（GoalBar，目标模式 docs/goal-mode-design.md §9.1；jsdom）。后端是假的 `window.api.agent.goalAct`。
 *
 *   GB-1 没有目标、没开编辑器 → 什么都不画
 *   GB-2 进行中：一行状态（第几轮 / 上限、花费 / 上限）+ 实验标签；按钮 暂停 / 编辑 / 清除；暂停 → goalAct(pause)
 *   GB-3 判定中 → 「Checking the goal…」；目标检查被停用 → 警告行；最近判定一行，展开后看原文与下一步
 *   GB-4 暂停在预算上：调高上限并继续 / 继续 / 编辑 / 清除；调高 → 空花费 = `costUsd: null`，先 edit 再 resume；
 *        resume 被拒 → 表单留着、宿主那句话就地显示
 *   GB-5 达成 / 做不到：沿用原文再设 / 移除，没有「编辑」；再设 → set(原文)
 *   GB-6 操作被拒 → 栏上就地显示那句话
 *   GB-7 设新目标（输入框只发了 `/goal`）：上限初值取设置（`off` → 空）；没动过上限就不交 limits；动过就交
 *   GB-8 编辑：原文没改就不交 objective；轮数不合法 → 本地报错，不调 goalAct
 *   GB-9 触屏密度：按钮至少 40px 高
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { GoalActResult, GoalView } from '@shuvix/chat-protocol/types/goal'
import { useChatStore } from '../../../stores/chatStore'
import { ChatHostContext, type ChatHostValue } from '../../../host/chatHostContext'
import { GoalBar } from '../GoalBar'
import { flush } from '../../../__tests__/support/sendFailure'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 's1'

let goalAct: ReturnType<typeof vi.fn<(params: unknown) => Promise<GoalActResult>>>
let results: GoalActResult[]
let settings: Record<string, string>

function goal(over: Partial<GoalView> = {}): GoalView {
  return {
    id: 'g_1',
    sessionId: SID,
    objective: 'All tests in src/ pass',
    status: 'active',
    setAt: 0,
    limits: { costUsd: 10, maxTurns: 50, stallTurns: 3 },
    baselineCostUsd: 0,
    turns: 7,
    stalls: 0,
    activeMs: 0,
    costUsd: 3.1,
    judging: false,
    planning: false,
    checkerMissing: false,
    ...over
  }
}

let container: HTMLDivElement
let root: Root

async function mount(density: 'compact' | 'touch' = 'compact'): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        ChatHostContext.Provider,
        { value: { density } as unknown as ChatHostValue },
        createElement(GoalBar, { sessionId: SID })
      )
    )
  })
  await flush()
}

const bar = (): HTMLElement | null => container.querySelector('[data-goal-bar]')
const actionNames = (): string[] =>
  [...container.querySelectorAll('[data-goal-action]')].map(
    (b) => b.getAttribute('data-goal-action') ?? ''
  )
const action = (name: string): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>(`[data-goal-action="${name}"]`)!
const calls = (): unknown[] => goalAct.mock.calls.map((c) => c[0])

async function click(el: Element): Promise<void> {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}

async function setInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

async function submit(): Promise<void> {
  await click(container.querySelector('[data-goal-editor-save]')!)
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  results = []
  settings = {}
  goalAct = vi.fn(async () => results.shift() ?? { ok: true })
  ;(window as unknown as { api: unknown }).api = {
    agent: { goalAct },
    settings: { get: vi.fn(async (key: string) => settings[key]) }
  }
  useChatStore.setState({ sessionGoals: {}, goalEditor: null, sessionPendingInputs: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

const setGoal = (g: GoalView | null): void => useChatStore.getState().setSessionGoal(SID, g)

describe('GoalBar', () => {
  it('GB-1 没有目标、没开编辑器 → 不画', async () => {
    await mount()
    expect(bar()).toBeNull()
  })

  it('GB-2 进行中：状态行、实验标签、三个按钮；暂停', async () => {
    setGoal(goal())
    await mount()
    expect(bar()!.getAttribute('data-goal-status')).toBe('active')
    const state = container.querySelector('[data-goal-state]')!.textContent
    expect(state).toContain('Goal in progress')
    expect(state).toContain('turn 7/50')
    expect(state).toContain('$3.10 / $10')
    expect(container.querySelector('[data-experimental="goal"]')).not.toBeNull()
    expect(actionNames()).toEqual(['pause', 'edit', 'clear'])

    await click(action('pause'))
    expect(calls()).toEqual([{ sessionId: SID, action: { type: 'pause' } }])
  })

  it('GB-3 判定中 / 检查停用 / 最近判定与展开', async () => {
    setGoal(
      goal({
        judging: true,
        checkerMissing: true,
        lastVerdict: {
          verdict: 'not_met',
          reason: 'login.spec still fails',
          nextStep: 'Fix the redirect',
          at: 1
        }
      })
    )
    await mount()
    expect(container.querySelector('[data-goal-state]')!.textContent).toContain(
      'Checking the goal…'
    )
    expect(container.querySelector('[data-goal-checker-missing]')!.textContent).toBe(
      en.goal.checkerMissing
    )
    expect(container.querySelector('[data-goal-verdict="not_met"]')!.textContent).toBe(
      'Last check: not met — login.spec still fails'
    )

    await click(container.querySelector('[data-goal-toggle]')!)
    const details = container.querySelector('[data-goal-details]')!
    expect(details.querySelector('[data-goal-objective]')!.textContent).toBe(
      'All tests in src/ pass'
    )
    expect(details.textContent).toContain('Fix the redirect')
    expect(details.querySelector('[data-goal-limits]')!.textContent).toContain('spending limit $10')
    // 展开后折叠行让位
    expect(container.querySelector('[data-goal-verdict]')).toBeNull()
  })

  it('GB-4 暂停在预算上：调高上限并继续 = 先 edit（空花费 → null）再 resume；resume 被拒就地显示', async () => {
    setGoal(goal({ status: 'paused', pauseReason: 'budget', costUsd: 10 }))
    await mount()
    expect(container.querySelector('[data-goal-state]')!.textContent).toContain(
      'Paused — spending limit reached'
    )
    expect(actionNames()).toEqual(['raise', 'resume', 'edit', 'clear'])

    await click(action('raise'))
    expect(useChatStore.getState().goalEditor).toMatchObject({ sessionId: SID, mode: 'raise' })
    expect(container.querySelector('[data-goal-editor="raise"]')).not.toBeNull()
    // 编辑器开着时栏上的按钮收起
    expect(actionNames()).toEqual([])

    results.push({ ok: true }, { ok: false, error: en.goal.resumeBlocked.turns })
    await setInput(container.querySelector<HTMLInputElement>('[data-goal-cost-input]')!, '')
    await submit()
    expect(calls()).toEqual([
      { sessionId: SID, action: { type: 'edit', limits: { costUsd: null, maxTurns: 50 } } },
      { sessionId: SID, action: { type: 'resume' } }
    ])
    expect(container.querySelector('[data-goal-editor-error]')!.textContent).toBe(
      en.goal.resumeBlocked.turns
    )
    expect(useChatStore.getState().goalEditor).not.toBeNull()

    // 再来一次，这回都成了：编辑器关上
    await submit()
    expect(useChatStore.getState().goalEditor).toBeNull()
  })

  it.each(['met', 'impossible'] as const)(
    'GB-5 %s：沿用原文再设 / 移除，没有编辑',
    async (status) => {
      setGoal(goal({ status }))
      await mount()
      expect(actionNames()).toEqual(['set-again', 'dismiss'])
      await click(action('set-again'))
      expect(calls()).toEqual([
        { sessionId: SID, action: { type: 'set', objective: 'All tests in src/ pass' } }
      ])
      await click(action('dismiss'))
      expect(calls()[1]).toEqual({ sessionId: SID, action: { type: 'clear' } })
    }
  )

  it('GB-6 操作被拒 → 栏上就地显示', async () => {
    setGoal(goal())
    results.push({ ok: false, error: 'This conversation has no goal.' })
    await mount()
    await click(action('clear'))
    expect(container.querySelector('[data-goal-error]')!.textContent).toBe(
      'This conversation has no goal.'
    )
  })

  it('GB-7 设新目标：上限初值取设置；没动过不交 limits，动过就交', async () => {
    settings['goal.defaultCostUsd'] = 'off'
    settings['goal.defaultMaxTurns'] = '20'
    useChatStore.getState().openGoalEditor(SID, 'new')
    await mount()
    expect(bar()!.getAttribute('data-goal-status')).toBe('new')
    const cost = container.querySelector<HTMLInputElement>('[data-goal-cost-input]')!
    const turns = container.querySelector<HTMLInputElement>('[data-goal-turns-input]')!
    expect([cost.value, turns.value]).toEqual(['', '20'])

    // 原文空着不能保存
    expect(container.querySelector<HTMLButtonElement>('[data-goal-editor-save]')!.disabled).toBe(
      true
    )
    await setInput(
      container.querySelector<HTMLTextAreaElement>('[data-goal-objective-input]')!,
      '  Ship the beta  '
    )
    await submit()
    expect(calls()).toEqual([
      { sessionId: SID, action: { type: 'set', objective: 'Ship the beta' } }
    ])
    expect(useChatStore.getState().goalEditor).toBeNull()

    useChatStore.getState().openGoalEditor(SID, 'new')
    await flush()
    await setInput(
      container.querySelector<HTMLTextAreaElement>('[data-goal-objective-input]')!,
      'Ship it'
    )
    await setInput(container.querySelector<HTMLInputElement>('[data-goal-cost-input]')!, '2.5')
    await submit()
    expect(calls()[1]).toEqual({
      sessionId: SID,
      action: { type: 'set', objective: 'Ship it', limits: { costUsd: 2.5, maxTurns: 20 } }
    })
  })

  it('GB-8 编辑：原文没改不交 objective；轮数不合法本地报错', async () => {
    setGoal(goal())
    await mount()
    await click(action('edit'))
    const turns = container.querySelector<HTMLInputElement>('[data-goal-turns-input]')!
    await setInput(turns, '0')
    await submit()
    expect(goalAct).not.toHaveBeenCalled()
    expect(container.querySelector('[data-goal-editor-error]')!.textContent).toBe(
      en.goal.errorTurnsInvalid
    )

    await setInput(turns, '80')
    await submit()
    expect(calls()).toEqual([
      { sessionId: SID, action: { type: 'edit', limits: { costUsd: 10, maxTurns: 80 } } }
    ])

    await click(action('edit'))
    await setInput(
      container.querySelector<HTMLTextAreaElement>('[data-goal-objective-input]')!,
      'All tests pass, and lint is clean'
    )
    await submit()
    expect(calls()[1]).toEqual({
      sessionId: SID,
      action: {
        type: 'edit',
        objective: 'All tests pass, and lint is clean',
        limits: { costUsd: 10, maxTurns: 50 }
      }
    })
  })

  it('GB-9 触屏：按钮至少 40px 高', async () => {
    setGoal(goal({ status: 'paused', pauseReason: 'user' }))
    await mount('touch')
    expect(actionNames()).toEqual(['resume', 'edit', 'clear'])
    for (const name of actionNames()) {
      expect(action(name).className).toContain('min-h-[40px]')
    }
  })
})
