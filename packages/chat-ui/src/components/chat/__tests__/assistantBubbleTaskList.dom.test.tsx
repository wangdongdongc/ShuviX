// @vitest-environment jsdom
/**
 * 卡片里的任务列表调用（AssistantBubble，docs/task-list-design.md §3.4；jsdom）：`mcp__plan__update` 调用照普通
 * 工具行显示 —— 用户要看得到列表是什么时候、怎么改的（对话末尾那张列表只给出现在的样子）。
 *
 *   TLC-1  落定的卡：成功的列表调用和旁边的 read 并成一个步骤组，展开后两行都在，列表行的摘要是进行中的步骤
 *   TLC-2  还在跑的列表调用（没有结果）：一行，不进步骤组
 *   TLC-3  失败的列表调用：一条红行（任务列表的标签 + 摘要），不并进步骤组
 *   TLC-4  [read, 列表调用, read]：一个步骤组，三步都计进徽章
 *   TLC-5  只有一个列表调用的卡：有一行，不再是空壳
 *   TLC-6  流式卡的最后一块是正在生成的列表调用：有 generating 行
 *   TLC-7  流式卡里已生成完、待执行的列表调用：有 pending 行
 *   TLC-8  末条是 [正文, 列表调用]：这条带工具，正文进过程区、不是终答
 *
 * 真组件（StepGroupView / StepGroup / ToolCallBlock 都不桩）；数据走真的 chatStore（流式用 `applySessionView`
 * 推实时卡，同 assistantBubbleLive.dom.test.tsx 的 A-9）。文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AssistantBlock, AssistantMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { TASK_LIST_TOOL_NAME } from '@shuvix/chat-protocol/taskList'

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))
vi.mock('../../../hooks/useTtsPlayback', () => {
  const tts = {
    isPlaying: false,
    isLoading: false,
    playingMessageId: null,
    speak: () => {},
    stop: () => {}
  }
  return { useTtsPlayback: () => tts }
})

import { applySessionView } from '../../../stores/chatStore'
import { AssistantBubble } from '../AssistantBubble'
import { streamingPlaceholder } from '../conversationItems'
import {
  V,
  assistant,
  liveCard,
  resetStore,
  text,
  toolBlock,
  user
} from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 's1'
const PLAN = TASK_LIST_TOOL_NAME
const ITEMS = {
  items: [
    { content: 'Read the code', status: 'in_progress' },
    { content: 'Write the fix', status: 'pending' }
  ]
}

let container: HTMLDivElement
let root: Root

// ─── 造数据 ────────────────────────────────────────────────

const planOk = (id: string, args: Record<string, unknown> = ITEMS): AssistantBlock =>
  toolBlock(id, PLAN, args, { result: 'Plan shown (2 steps).' })
const readOk = (id: string, path = `${id}.txt`): AssistantBlock =>
  toolBlock(id, 'read', { path }, { result: `R-${id}` })

// ─── 挂载 ──────────────────────────────────────────────────

function show(
  msgs: AssistantMessage[],
  opts: {
    isStreaming?: boolean
    onRegenerate?: (id: string) => void
    onFork?: (id: string) => void
  } = {}
): void {
  act(() => root.render(createElement(AssistantBubble, { msgs, ...opts })))
}

/** 推一张实时卡（会话在跑），再挂流式占位卡 */
function showLive(blocks: AssistantBlock[]): void {
  act(() =>
    applySessionView(
      SID,
      V(SID, {
        messages: [user('u1', 'hi')],
        live: liveCard(1, blocks),
        toolRuns: {},
        run: { state: 'busy' }
      })
    )
  )
  show([streamingPlaceholder(SID)], { isStreaming: true })
}

// ─── 读取 ──────────────────────────────────────────────────

const rows = (name: string): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>(`[data-tool-name="${name}"]`)
]
const planRows = (): HTMLElement[] => rows(PLAN)
/** 流式期间的工具行（待执行 / 正在生成）：工具名 + 状态 */
const liveRows = (): Array<[string | null, string | null]> =>
  [
    ...container.querySelectorAll<HTMLElement>(
      '[data-tool-status="pending"], [data-tool-status="generating"]'
    )
  ].map((el) => [el.getAttribute('data-tool-name'), el.getAttribute('data-tool-status')])
const stepGroups = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-step-group]')
]
/** 卡的内容区（`div.min-w-0`，外层 `div.group` 的唯一孩子） */
const content = (): HTMLElement => container.querySelector<HTMLElement>('div.group > div.min-w-0')!
const actions = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-message-actions]')

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  resetStore(SID)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** 展开第 n 个步骤组 */
function expandGroup(n = 0): void {
  const header = stepGroups()[n].querySelector<HTMLElement>('[role="button"], button')!
  act(() => header.click())
}

describe('落定的卡（TLC-1…TLC-5）', () => {
  it('TLC-1 [A1: 正文 + 成功的列表调用 + read][A2: 终答]：两步并成一组，展开后列表调用一行、摘要是进行中的步骤', () => {
    show([
      assistant('a1', [text('start'), planOk('p1'), readOk('r1')], SID),
      assistant('a2', [text('final')], SID)
    ])
    const groups = stepGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0].getAttribute('data-group-size')).toBe('2')
    expect(groups[0].textContent).toContain(en.tool.taskListLabel)
    expandGroup()
    const [row, ...more] = planRows()
    expect(more).toHaveLength(0)
    expect(row.getAttribute('data-tool-status')).toBe('done')
    expect(row.querySelector('span.font-mono')?.textContent).toBe('Read the code')
    expect(rows('read')).toHaveLength(1)
    expect(container.textContent).toContain('start')
    expect(container.textContent).toContain('final')
  })

  it('TLC-2 还在跑的列表调用（没有结果）：一行，不进步骤组', () => {
    show([assistant('a1', [text('start'), toolBlock('p1', PLAN, ITEMS), readOk('r1')], SID)])
    const [row, ...more] = planRows()
    expect(more).toHaveLength(0)
    expect(row.closest('[data-step-group]')).toBeNull()
    expect(rows('read')).toHaveLength(1)
  })

  it('TLC-3 失败的列表调用：一条红行（error 状态、任务列表标签、当前步骤作摘要），不并进步骤组', () => {
    show([
      assistant(
        'a1',
        [
          readOk('ra'),
          toolBlock('p1', PLAN, ITEMS, { result: 'Step 9 does not exist', isError: true }),
          readOk('rb')
        ],
        SID
      ),
      assistant('a2', [text('final')], SID)
    ])
    const [row, ...more] = planRows()
    expect(more).toHaveLength(0)
    expect(row.getAttribute('data-tool-status')).toBe('error')
    expect(row.querySelector('[data-step-label]')?.textContent).toBe(en.tool.taskListLabel)
    expect(row.querySelector('span.font-mono')?.textContent).toBe('Read the code')
    // 图标槽里是出错的 ×（所有工具出错时都一样，状态图标顶替工具图标）
    expect(row.querySelector('svg.lucide-x')).not.toBeNull()
    // 不进步骤组：它把两个 read 隔开，三行各自独立
    expect(row.closest('[data-step-group]')).toBeNull()
    expect(stepGroups()).toHaveLength(0)
    expect(rows('read')).toHaveLength(2)
  })

  it('TLC-4 [read a, 成功的列表调用, read b]：一个步骤组、计数 3', () => {
    show([
      assistant('a1', [readOk('ra'), planOk('p1'), readOk('rb')], SID),
      assistant('a2', [text('final')], SID)
    ])
    const groups = stepGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0].getAttribute('data-group-size')).toBe('3')
    expect(groups[0].querySelector('[data-group-count]')?.textContent).toBe('3')
    expandGroup()
    expect(planRows()).toHaveLength(1)
    expect(rows('read')).toHaveLength(2)
  })

  it('TLC-5 只有一个列表调用的卡（后面是用户消息）：卡里有这一行，不是空壳', () => {
    const fork = vi.fn()
    const regenerate = vi.fn()
    show([assistant('a1', [planOk('p1')], SID)], { onFork: fork, onRegenerate: regenerate })
    expect(container.querySelector('.markdown-body')).toBeNull()
    const [row, ...more] = planRows()
    expect(more).toHaveLength(0)
    expect(row.getAttribute('data-tool-status')).toBe('done')
    expect(row.querySelector('[data-step-label]')?.textContent).toBe(en.tool.taskListLabel)
    expect(actions()).not.toBeNull()
  })
})

describe('流式卡（TLC-6 / TLC-7）', () => {
  it('TLC-6 实时卡最后一块是还没执行的列表调用：有一行 generating', () => {
    showLive([text('planning'), toolBlock('p1', PLAN, ITEMS)])
    expect(liveRows()).toEqual([[PLAN, 'generating']])
  })

  it('TLC-7 实时卡 [列表调用, read]（都没进 toolRuns）：列表调用 pending、read generating；反过来也一样', () => {
    showLive([toolBlock('p1', PLAN, ITEMS), toolBlock('r1', 'read', { path: 'a' })])
    expect(liveRows()).toEqual([
      [PLAN, 'pending'],
      ['read', 'generating']
    ])

    showLive([toolBlock('r1', 'read', { path: 'a' }), toolBlock('p1', PLAN, { advance: true })])
    expect(liveRows()).toEqual([
      ['read', 'pending'],
      [PLAN, 'generating']
    ])
  })
})

describe('末条带一个列表调用（TLC-8）', () => {
  it('TLC-8 末条 [正文, 成功的列表调用]：正文画在过程区，不是终答（没有复制按钮）', () => {
    show([
      assistant('a1', [readOk('r1')], SID),
      assistant('a2', [text('all set'), planOk('p2', { advance: true })], SID)
    ])
    const md = [...container.querySelectorAll<HTMLElement>('.markdown-body')]
    expect(md).toHaveLength(1)
    expect(md[0].textContent).toBe('all set')
    // 过程区里的中间文本（在步骤列表 `div.space-y-0.5` 里），不是内容区直接挂着的终答正文
    expect(md[0].closest('.space-y-0\\.5')).not.toBeNull()
    expect(md[0].parentElement).not.toBe(content())
    expect(container.querySelector(`button[title="${en.message.copy}"]`)).toBeNull()

    // 对照：去掉那个列表调用，同样的正文就是终答（内容区直接挂着、带复制）
    show([assistant('a1', [readOk('r1')], SID), assistant('a2', [text('all set')], SID)], {
      onFork: vi.fn()
    })
    const answer = container.querySelector<HTMLElement>('.markdown-body')!
    expect(answer.parentElement).toBe(content())
    expect(container.querySelector(`button[title="${en.message.copy}"]`)).not.toBeNull()
  })
})
