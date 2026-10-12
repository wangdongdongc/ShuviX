// @vitest-environment jsdom
/**
 * 设置 → 监视器 → 分类器日志（ClassifierLogSettings）：每次调用分类模型一行，展开后按题型通用地渲染。
 *
 *   CLV-1  挂载：list 恰以 { limit: 200 } 调一次、scenes 调一次；提示行带上限 5000
 *   CLV-2  行：data-classifier-log-id / data-status、场景标签、对象摘要、耗时；ok 行的结果摘要是「选中项 把握%」
 *   CLV-3  非 ok 的行显示状态标签（incomplete 带着答案也一样），不显示摘要
 *   CLV-4  不认识的场景：行里与场景筛选里都显示原名
 *   CLV-5  空列表：空态文案，清空按钮禁用
 *   CLV-6  展开 ok 行（单选题）：选项按准则顺序、只有选中项 data-chosen、概率百分比；状态绿色；发送内容是 state；原始答案在
 *   CLV-7  是非题：0.7 → true 选中、0.5 → true 选中（边界）、0.3 → false 选中；两边概率互补
 *   CLV-8  打分题：选中 round(score) 那一档；越界的分数哪档都不选；底下一行 score / confidence
 *   CLV-9  认不出的题型：按原文（JSON）显示
 *   CLV-10 非 ok 的详情（failed）：琥珀色状态、错误框、一个选项都不选中、没有原始答案
 *   CLV-11 元信息行：模型 provider/model、耗时、用量只在 > 0 时、会话标题 → 会话 id → —、工具调用只在有时
 *   CLV-12 request 解析不了：题目处是 —，发送内容显示原文
 *   CLV-13 展开是手风琴：同时只开一条、再点收起、每次展开取一次详情；刷新后那条还在就留着、没了就收起
 *   CLV-14 筛选只带选中的那个键；刷新沿用当前筛选；清空要确认（确认 → clear、列表空；取消 → 不清）
 *
 * 桌面 vitest 对渲染层只收 `*.test.ts`（本文件自己切 jsdom），不带 react 插件 —— 一律 createElement。
 * 会话下拉、确认框换成小替身；ZenSelect 换成可驱动的替身（每个选项一个按钮）。i18n 走真 zh 资源。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'

vi.mock('../../common/SessionPicker', async () => {
  const { createElement: h } = await import('react')
  return {
    SessionPicker: ({ value, onChange }: { value: string; onChange: (v: string) => void }) =>
      h(
        'div',
        { 'data-session-picker': '', 'data-value': value },
        h('button', { 'data-session-pick': 's1', onClick: () => onChange('s1') }),
        h('button', { 'data-session-pick': '', onClick: () => onChange('') })
      )
  }
})
vi.mock('../../common/ZenSelect', async () => {
  const { createElement: h } = await import('react')
  return {
    ZenSelect: ({
      value,
      onChange,
      placeholder,
      options
    }: {
      value: string
      onChange: (v: string) => void
      placeholder: string
      options: Array<{ value: string; label: string }>
    }) =>
      h(
        'div',
        { 'data-zen-select': placeholder, 'data-value': value },
        ...options.map((o) =>
          h(
            'button',
            { key: o.value, 'data-zen-option': o.value, onClick: () => onChange(o.value) },
            o.label
          )
        ),
        h('button', { 'data-zen-clear': '', onClick: () => onChange('') })
      )
  }
})
vi.mock('../../common/ConfirmDialog', async () => {
  const { createElement: h } = await import('react')
  return {
    ConfirmDialog: ({
      title,
      onConfirm,
      onCancel
    }: {
      title: string
      onConfirm: () => void
      onCancel: () => void
    }) =>
      h(
        'div',
        { 'data-confirm': title },
        h('button', { 'data-confirm-ok': '', onClick: onConfirm }),
        h('button', { 'data-confirm-cancel': '', onClick: onCancel })
      )
  }
})

import { ClassifierLogSettings } from '../ClassifierLogSettings'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CATEGORIES = ['read_only', 'personal_data', 'destructive']
const CRITERIA = {
  read_only: 'Only reads',
  personal_data: 'Reads personal files',
  destructive: 'Deletes data'
}
const CHOICE_QUESTION = {
  type: 'choice',
  instructions: 'Which one best describes it?',
  criteria: CRITERIA
}
const OK_ANSWERS = {
  category: {
    type: 'choice',
    choice: 'read_only',
    probabilities: { read_only: 0.93, personal_data: 0.05, destructive: 0.02 },
    confidence: 0.93
  }
}

interface Row {
  id: string
  createdAt: number
  scene: string
  sessionId: string
  sessionTitle: string
  toolCallId: string
  subject: string
  provider: string
  model: string
  response: string
  status: string
  error: string
  ms: number
  inputTokens: number
  cost: number
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'log-ok',
    createdAt: new Date(2026, 9, 12, 9, 5, 7).getTime(),
    scene: 'command-risk',
    sessionId: 's1',
    sessionTitle: 'First session',
    toolCallId: 'call_1',
    subject: 'ls -la',
    provider: 'openrouter',
    model: '~typesafe/jev-latest',
    response: JSON.stringify(OK_ANSWERS),
    status: 'ok',
    error: '',
    ms: 412,
    inputTokens: 57,
    cost: 0.00002,
    ...over
  }
}

const OK_ROW = row()
const FAILED_ROW = row({
  id: 'log-failed',
  subject: 'pwd',
  response: '',
  status: 'failed',
  error: 'error: No API key for provider: openrouter',
  ms: 3,
  inputTokens: 0,
  toolCallId: ''
})
const INCOMPLETE_ROW = row({
  id: 'log-incomplete',
  subject: 'cat x',
  status: 'incomplete',
  error: 'answers are incomplete or out of range'
})

const STATE = { command: 'ls -la', shell: 'bash', platform: 'darwin', sandboxed: false }

/** 一行的详情：request 默认是单选题 + STATE */
function detailOf(
  r: Row,
  request: unknown = { state: STATE, questions: { category: CHOICE_QUESTION } }
): Omit<Row, 'sessionTitle'> & { request: string } {
  const { sessionTitle: _title, ...rest } = r
  return { ...rest, request: typeof request === 'string' ? request : JSON.stringify(request) }
}

const api = {
  classifierLog: {
    list: vi.fn<(params: unknown) => Promise<Row[]>>(),
    get: vi.fn<(id: string) => Promise<unknown>>(),
    scenes: vi.fn<() => Promise<string[]>>(),
    clear: vi.fn<() => Promise<{ success: boolean }>>()
  }
}

/** id → 详情（get 按它回） */
let details: Record<string, unknown> = {}

let container: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(ClassifierLogSettings))
  })
  await flush()
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el, 'element to click').toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}

const tr = (key: string, opts?: Record<string, unknown>): string => {
  const text = String(i18n.t(key, opts))
  expect(text, key).not.toBe(key)
  return text
}

const rowEl = (id: string): HTMLElement | null =>
  container.querySelector(`[data-classifier-log-id="${id}"]`)
const rowIds = (): string[] =>
  [...container.querySelectorAll('[data-classifier-log-id]')].map(
    (el) => el.getAttribute('data-classifier-log-id') ?? ''
  )
const rowButton = (id: string): HTMLElement => rowEl(id)!.querySelector('button')!
const resultOf = (id: string): HTMLElement =>
  rowEl(id)!.querySelector('[data-classifier-log-result]') as HTMLElement
const expandedIds = (): string[] =>
  rowIds().filter((id) => rowEl(id)!.querySelector('[data-classifier-log-status]') !== null)
const refreshButton = (): HTMLButtonElement =>
  container.querySelector(`button[title="${tr('common.refresh')}"]`) as HTMLButtonElement
const clearButton = (): HTMLButtonElement =>
  container.querySelector(`button[title="${tr('common.clear')}"]`) as HTMLButtonElement
const options = (scope: Element): Array<{ label: string; chosen: boolean; text: string }> =>
  [...scope.querySelectorAll('[data-classifier-option]')].map((el) => ({
    label: el.getAttribute('data-classifier-option') ?? '',
    chosen: el.getAttribute('data-chosen') === 'true',
    text: el.textContent ?? ''
  }))
/** 详情里某一节（按 Section 标题找） */
const sectionText = (scope: Element, titleKey: string): string | null => {
  const title = tr(titleKey)
  const heading = [...scope.querySelectorAll('div')].find(
    (el) => el.children.length === 0 && el.textContent === title
  )
  return heading ? (heading.parentElement?.textContent ?? '').slice(title.length) : null
}
const zenSelect = (placeholderKey: string): HTMLElement =>
  container.querySelector(`[data-zen-select="${tr(placeholderKey)}"]`) as HTMLElement

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
  ;(window as unknown as { api: unknown }).api = api
})

beforeEach(() => {
  details = {
    [OK_ROW.id]: detailOf(OK_ROW),
    [FAILED_ROW.id]: detailOf(FAILED_ROW),
    [INCOMPLETE_ROW.id]: detailOf(INCOMPLETE_ROW)
  }
  api.classifierLog.list.mockReset().mockResolvedValue([OK_ROW, FAILED_ROW, INCOMPLETE_ROW])
  api.classifierLog.get.mockReset().mockImplementation(async (id) => details[id])
  api.classifierLog.scenes.mockReset().mockResolvedValue(['command-risk'])
  api.classifierLog.clear.mockReset().mockResolvedValue({ success: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('ClassifierLogSettings', () => {
  it('CLV-1 挂载：list 恰以 { limit: 200 } 调一次、scenes 一次；提示行带上限 5000；工具栏在', async () => {
    await mount()
    expect(api.classifierLog.list).toHaveBeenCalledTimes(1)
    expect(api.classifierLog.list.mock.calls[0][0]).toStrictEqual({ limit: 200 })
    expect(api.classifierLog.scenes).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-classifier-log-toolbar]')).not.toBeNull()
    const hint = container.querySelector('[data-classifier-log-hint]')!.textContent
    expect(hint).toBe(tr('settings.classifierLog.hint', { max: 5000 }))
    expect(hint).toContain('5000')
  })

  it('CLV-2 行：id / status 属性、场景标签、对象摘要、耗时；ok 行的结果摘要是「read_only 93%」', async () => {
    await mount()
    expect(rowIds()).toEqual(['log-ok', 'log-failed', 'log-incomplete'])
    const ok = rowEl('log-ok')!
    expect(ok.getAttribute('data-status')).toBe('ok')
    expect(ok.textContent).toContain(tr('settings.classifierLog.scenes.command-risk'))
    expect(ok.textContent).toContain('ls -la')
    expect(ok.textContent).toContain('412 ms')
    expect(ok.textContent).toContain('10-12 09:05:07')
    expect(resultOf('log-ok').textContent).toBe('read_only 93%')
    expect(resultOf('log-ok').className).not.toContain('amber')
  })

  it('CLV-3 非 ok 的行显示状态标签（incomplete 带着答案也一样），不显示摘要', async () => {
    await mount()
    expect(rowEl('log-failed')!.getAttribute('data-status')).toBe('failed')
    expect(resultOf('log-failed').textContent).toBe(tr('settings.classifierLog.status.failed'))
    expect(resultOf('log-failed').className).toContain('amber')
    expect(resultOf('log-incomplete').textContent).toBe(
      tr('settings.classifierLog.status.incomplete')
    )
    expect(resultOf('log-incomplete').textContent).not.toContain('93%')
  })

  it('CLV-4 不认识的场景：行里与场景筛选里都显示原名', async () => {
    api.classifierLog.list.mockResolvedValue([row({ id: 'log-x', scene: 'mystery-scene' })])
    api.classifierLog.scenes.mockResolvedValue(['command-risk', 'mystery-scene'])
    await mount()
    expect(rowEl('log-x')!.textContent).toContain('mystery-scene')
    const sceneFilter = zenSelect('settings.classifierLog.allScenes')
    const labels = [...sceneFilter.querySelectorAll('[data-zen-option]')].map((b) => [
      b.getAttribute('data-zen-option'),
      b.textContent
    ])
    expect(labels).toEqual([
      ['command-risk', tr('settings.classifierLog.scenes.command-risk')],
      ['mystery-scene', 'mystery-scene']
    ])
  })

  it('CLV-5 空列表：空态文案，清空按钮禁用', async () => {
    api.classifierLog.list.mockResolvedValue([])
    api.classifierLog.scenes.mockResolvedValue([])
    await mount()
    expect(rowIds()).toEqual([])
    expect(container.textContent).toContain(tr('settings.classifierLog.empty'))
    expect(clearButton().disabled).toBe(true)
  })

  it('CLV-6 展开 ok 行（单选题）：选项按准则顺序、只有选中项 data-chosen、带百分比；状态绿色；发送内容是 state；原始答案在', async () => {
    await mount()
    await click(rowButton('log-ok'))
    expect(api.classifierLog.get).toHaveBeenCalledWith('log-ok')
    const ok = rowEl('log-ok')!
    const question = ok.querySelector('[data-classifier-question="category"]')!
    expect(question.textContent).toContain('Which one best describes it?')
    expect(question.textContent).toContain('choice')
    const opts = options(question)
    expect(opts.map((o) => o.label)).toEqual(CATEGORIES)
    expect(opts.filter((o) => o.chosen).map((o) => o.label)).toEqual(['read_only'])
    expect(opts[0].text).toContain('93%')
    expect(opts[0].text).toContain('Only reads')
    expect(opts[2].text).toContain('2%')

    const status = ok.querySelector('[data-classifier-log-status]')!
    expect(status.textContent).toBe(tr('settings.classifierLog.status.ok'))
    expect(status.className).toContain('emerald')

    const sent = sectionText(ok, 'settings.classifierLog.sent')
    expect(sent).not.toBeNull()
    expect(JSON.parse(sent!)).toEqual(STATE)
    expect(sectionText(ok, 'settings.classifierLog.subject')).toBe('ls -la')
    const raw = sectionText(ok, 'settings.classifierLog.rawAnswers')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).toEqual(OK_ANSWERS)
  })

  it.each<[number, string, string, string]>([
    [0.7, 'true', '70%', '30%'],
    [0.5, 'true', '50%', '50%'],
    [0.3, 'false', '30%', '70%']
  ])(
    'CLV-7 是非题 probability %f → 选中 %s（true %s / false %s）',
    async (p, chosen, pTrue, pFalse) => {
      const r = row({
        id: 'log-bool',
        response: JSON.stringify({ harmful: { type: 'bool', probability: p } })
      })
      api.classifierLog.list.mockResolvedValue([r])
      details = {
        'log-bool': detailOf(r, {
          state: STATE,
          questions: {
            harmful: {
              type: 'bool',
              instructions: 'Is it harmful?',
              criteria: { true: 'Harmful', false: 'Harmless' }
            }
          }
        })
      }
      await mount()
      expect(resultOf('log-bool').textContent).toBe(`harmful ${Math.round(p * 100)}%`)
      await click(rowButton('log-bool'))
      const opts = options(
        rowEl('log-bool')!.querySelector('[data-classifier-question="harmful"]')!
      )
      expect(opts.map((o) => o.label)).toEqual(['true', 'false'])
      expect(opts.filter((o) => o.chosen).map((o) => o.label)).toEqual([chosen])
      expect(opts[0].text).toContain(pTrue)
      expect(opts[0].text).toContain('Harmful')
      expect(opts[1].text).toContain(pFalse)
      expect(opts[1].text).toContain('Harmless')
    }
  )

  it.each<[number, number | null]>([
    [1.6, 2],
    [0.4, 0],
    [7, null]
  ])('CLV-8 打分题 score %f → 选中第 %s 档；底下一行 score / confidence', async (score, chosen) => {
    const r = row({
      id: 'log-score',
      response: JSON.stringify({ level: { type: 'score', score, confidence: 0.8 } })
    })
    api.classifierLog.list.mockResolvedValue([r])
    details = {
      'log-score': detailOf(r, {
        state: STATE,
        questions: {
          level: {
            type: 'score',
            instructions: 'How risky?',
            criteria: ['none', 'low', 'medium', 'high']
          }
        }
      })
    }
    await mount()
    expect(resultOf('log-score').textContent).toBe(`level ${score.toFixed(1)}`)
    await click(rowButton('log-score'))
    const question = rowEl('log-score')!.querySelector('[data-classifier-question="level"]')!
    const opts = options(question)
    expect(opts.map((o) => o.label)).toEqual(['0', '1', '2', '3'])
    expect(opts.filter((o) => o.chosen).map((o) => o.label)).toEqual(
      chosen === null ? [] : [String(chosen)]
    )
    expect(question.textContent).toContain(`score ${score.toFixed(2)} · confidence 80%`)
  })

  it('CLV-9 认不出的题型：按原文（JSON）显示', async () => {
    const r = row({
      id: 'log-odd',
      response: JSON.stringify({ q: { type: 'rank', order: ['a'] } })
    })
    api.classifierLog.list.mockResolvedValue([r])
    details = {
      'log-odd': detailOf(r, {
        state: STATE,
        questions: { q: { type: 'rank', instructions: 'Rank them', items: ['a', 'b'] } }
      })
    }
    await mount()
    await click(rowButton('log-odd'))
    const question = rowEl('log-odd')!.querySelector('[data-classifier-question="q"]')!
    expect(options(question)).toEqual([])
    const parsed = JSON.parse(question.querySelector('pre')!.textContent!)
    expect(parsed).toEqual({
      question: { type: 'rank', instructions: 'Rank them', items: ['a', 'b'] },
      answer: { type: 'rank', order: ['a'] }
    })
  })

  it('CLV-10 非 ok 的详情（failed）：琥珀色状态、错误框、一个选项都不选中、没有原始答案', async () => {
    await mount()
    await click(rowButton('log-failed'))
    const failed = rowEl('log-failed')!
    const status = failed.querySelector('[data-classifier-log-status]')!
    expect(status.textContent).toBe(tr('settings.classifierLog.status.failed'))
    expect(status.className).toContain('amber')
    expect(failed.textContent).toContain('error: No API key for provider: openrouter')
    const opts = options(failed.querySelector('[data-classifier-question="category"]')!)
    expect(opts.map((o) => o.label)).toEqual(CATEGORIES)
    expect(opts.some((o) => o.chosen)).toBe(false)
    expect(opts.every((o) => !o.text.includes('%'))).toBe(true)
    expect(sectionText(failed, 'settings.classifierLog.rawAnswers')).toBeNull()
  })

  it('CLV-11 元信息行：provider/model、耗时、用量只在 > 0 时、会话标题 → 会话 id → —、工具调用只在有时', async () => {
    const withTitle = row({ id: 'a' })
    const noTitle = row({ id: 'b', sessionTitle: '  ', inputTokens: 0, toolCallId: '' })
    const noSession = row({ id: 'c', sessionTitle: '', sessionId: '' })
    api.classifierLog.list.mockResolvedValue([withTitle, noTitle, noSession])
    details = { a: detailOf(withTitle), b: detailOf(noTitle), c: detailOf(noSession) }
    await mount()

    const metaOf = async (id: string): Promise<string> => {
      await click(rowButton(id))
      const status = rowEl(id)!.querySelector('[data-classifier-log-status]')!
      return status.parentElement!.textContent ?? ''
    }

    const a = await metaOf('a')
    expect(a).toContain(`${tr('settings.classifierLog.model')} openrouter/~typesafe/jev-latest`)
    expect(a).toContain(`${tr('settings.classifierLog.duration')} 412 ms`)
    expect(a).toContain('↑ 57 tk')
    expect(a).toContain(`${tr('settings.classifierLog.session')} First session`)
    expect(a).toContain(`${tr('settings.classifierLog.toolCall')} call_1`)

    const b = await metaOf('b')
    expect(b).not.toContain('tk')
    expect(b).toContain(`${tr('settings.classifierLog.session')} s1`)
    expect(b).not.toContain(tr('settings.classifierLog.toolCall'))

    const c = await metaOf('c')
    expect(c).toContain(`${tr('settings.classifierLog.session')} —`)
  })

  it('CLV-12 request 解析不了：题目处是 —，发送内容显示原文', async () => {
    details[OK_ROW.id] = detailOf(OK_ROW, 'not json {')
    await mount()
    await click(rowButton('log-ok'))
    const ok = rowEl('log-ok')!
    expect(ok.querySelectorAll('[data-classifier-question]')).toHaveLength(0)
    expect(sectionText(ok, 'settings.classifierLog.questions')).toBe('—')
    expect(sectionText(ok, 'settings.classifierLog.sent')).toBe('not json {')
  })

  it('CLV-13 手风琴：同时只开一条、再点收起、每次展开取一次详情；刷新后那条还在就留着、没了就收起', async () => {
    await mount()
    await click(rowButton('log-ok'))
    expect(expandedIds()).toEqual(['log-ok'])
    await click(rowButton('log-failed'))
    expect(expandedIds()).toEqual(['log-failed'])
    expect(api.classifierLog.get.mock.calls.map((c) => c[0])).toEqual(['log-ok', 'log-failed'])

    await click(rowButton('log-failed'))
    expect(expandedIds()).toEqual([])
    expect(api.classifierLog.get).toHaveBeenCalledTimes(2)

    // 刷新：展开的那条还在 → 留着
    await click(rowButton('log-ok'))
    await click(refreshButton())
    expect(api.classifierLog.list).toHaveBeenCalledTimes(2)
    expect(expandedIds()).toEqual(['log-ok'])

    // 刷新：展开的那条没了 → 收起
    api.classifierLog.list.mockResolvedValue([FAILED_ROW])
    await click(refreshButton())
    expect(rowIds()).toEqual(['log-failed'])
    expect(expandedIds()).toEqual([])
  })

  it('CLV-14 筛选只带选中的那个键；刷新沿用当前筛选；清空要确认（取消 → 不清；确认 → clear、列表空）', async () => {
    await mount()
    const lastParams = (): unknown => api.classifierLog.list.mock.calls.at(-1)![0]

    await click(
      zenSelect('settings.classifierLog.allScenes').querySelector(
        '[data-zen-option="command-risk"]'
      )
    )
    expect(lastParams()).toStrictEqual({ limit: 200, scene: 'command-risk' })

    await click(zenSelect('settings.classifierLog.allScenes').querySelector('[data-zen-clear]'))
    expect(lastParams()).toStrictEqual({ limit: 200 })

    await click(
      zenSelect('settings.classifierLog.allStatuses').querySelector('[data-zen-option="failed"]')
    )
    expect(lastParams()).toStrictEqual({ limit: 200, status: 'failed' })
    // 状态筛选的选项：六种状态，标签都译了
    const statusOptions = [
      ...zenSelect('settings.classifierLog.allStatuses').querySelectorAll('[data-zen-option]')
    ].map((b) => [b.getAttribute('data-zen-option'), b.textContent])
    expect(statusOptions).toEqual(
      ['ok', 'incomplete', 'failed', 'timeout', 'aborted', 'misconfigured'].map((s) => [
        s,
        tr(`settings.classifierLog.status.${s}`)
      ])
    )

    await click(container.querySelector('[data-session-pick="s1"]'))
    expect(lastParams()).toStrictEqual({ limit: 200, status: 'failed', sessionId: 's1' })

    const before = api.classifierLog.list.mock.calls.length
    await click(refreshButton())
    expect(api.classifierLog.list.mock.calls.length).toBe(before + 1)
    expect(lastParams()).toStrictEqual({ limit: 200, status: 'failed', sessionId: 's1' })

    // 清空：取消
    await click(clearButton())
    const dialog = container.querySelector('[data-confirm]')!
    expect(dialog.getAttribute('data-confirm')).toBe(tr('settings.classifierLog.clearConfirm'))
    await click(dialog.querySelector('[data-confirm-cancel]'))
    expect(api.classifierLog.clear).not.toHaveBeenCalled()
    expect(container.querySelector('[data-confirm]')).toBeNull()
    expect(rowIds()).not.toEqual([])

    // 清空：确认
    await click(clearButton())
    await click(container.querySelector('[data-confirm-ok]'))
    expect(api.classifierLog.clear).toHaveBeenCalledTimes(1)
    expect(rowIds()).toEqual([])
    expect(container.textContent).toContain(tr('settings.classifierLog.empty'))
  })
})
