// @vitest-environment jsdom
/**
 * 卡片里的任务列表调用（AssistantBubble，docs/task-list-design.md §3.4；jsdom）：没失败的 `mcp__plan__update`
 * 调用不出行（全部信息在输入框上方那张列表里），失败的照常是红行。
 *
 *   TLC-1  落定的卡：成功的列表调用没有行，旁边的 read 照常有
 *   TLC-2  还在跑的列表调用（没有结果）也没有行
 *   TLC-3  失败的列表调用：一条红行（任务列表的标签 + 摘要），不并进步骤组
 *   TLC-4  步骤合并跳过藏起来的块：它既不切断一串，也不计进徽章
 *   TLC-5  只有藏起来的列表调用的卡：没有过程区；卡片外壳与操作行的去留钉在这里
 *   TLC-6  流式卡的最后一块是正在生成的列表调用：没有 generating 行（Z S2）
 *   TLC-7  流式卡里已生成完、待执行的列表调用：没有 pending 行（Z S2）
 *   TLC-8  末条是 [正文, 列表调用]：藏起来的工具块照样算「这条带工具」，正文进过程区、不是终答（O4）
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

describe('落定的卡（TLC-1…TLC-5）', () => {
  it('TLC-1 [A1: 正文 + 成功的列表调用 + read][A2: 终答]：卡里没有列表调用的行，read 那一行照常有', () => {
    show([
      assistant('a1', [text('start'), planOk('p1'), readOk('r1')], SID),
      assistant('a2', [text('final')], SID)
    ])
    expect(planRows()).toHaveLength(0)
    expect(rows('read')).toHaveLength(1)
    expect(container.textContent).toContain('start')
    expect(container.textContent).toContain('final')
  })

  it('TLC-2 还在跑的列表调用（没有结果）也没有行', () => {
    show([assistant('a1', [text('start'), toolBlock('p1', PLAN, ITEMS), readOk('r1')], SID)])
    expect(planRows()).toHaveLength(0)
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

  it('TLC-4 [read a, 成功的列表调用, read b]：一个步骤组、计数 2 —— 藏起来的块不切断这一串，也不计数', () => {
    show([
      assistant('a1', [readOk('ra'), planOk('p1'), readOk('rb')], SID),
      assistant('a2', [text('final')], SID)
    ])
    const groups = stepGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0].getAttribute('data-group-size')).toBe('2')
    expect(groups[0].querySelector('[data-group-count]')?.textContent).toBe('2')
    expect(planRows()).toHaveLength(0)
  })

  it('TLC-5 只有藏起来的列表调用的卡（后面是用户消息）：没有过程区、没有正文；不给按钮时卡里什么都没有', () => {
    show([assistant('a1', [planOk('p1')], SID)])
    expect(planRows()).toHaveLength(0)
    expect(stepGroups()).toHaveLength(0)
    expect(container.querySelector('.markdown-body')).toBeNull()
    expect(actions()).toBeNull()
    // 卡片外壳（`div.group` > `div.min-w-0`）还在，只是空的
    expect(content().childElementCount).toBe(0)
  })

  it('TLC-5 同一张卡带分支 / 重新生成按钮（会话列表里每张定稿的卡都带分支）：外壳里只剩一行操作按钮', () => {
    const fork = vi.fn()
    const regenerate = vi.fn()
    show([assistant('a1', [planOk('p1')], SID)], { onFork: fork, onRegenerate: regenerate })
    expect(container.querySelector('.markdown-body')).toBeNull()
    expect(stepGroups()).toHaveLength(0)
    // 钉住现状：操作行照样画出来，卡里只有它（没有复制 / 朗读 —— 没有正文）
    const row = actions()
    expect(row).not.toBeNull()
    expect([...content().children]).toEqual([row])
    expect([...row!.querySelectorAll('button')].map((b) => b.title)).toEqual([
      en.message.regenerate,
      en.message.fork
    ])
  })
})

describe('流式卡（TLC-6 / TLC-7）', () => {
  it('TLC-6 实时卡最后一块是还没执行的列表调用：没有 generating 行，也没有任何列表调用的行', () => {
    showLive([text('planning'), toolBlock('p1', PLAN, ITEMS)])
    expect(planRows()).toHaveLength(0)
    expect(liveRows()).toEqual([])

    // 对照：最后一块换成 read → 有一行 generating
    showLive([text('planning'), toolBlock('r1', 'read', { path: 'a' })])
    expect(liveRows()).toEqual([['read', 'generating']])
  })

  it('TLC-7 实时卡 [列表调用, read]（都没进 toolRuns）：流式工具行只有 read；[read, 列表调用] 也只有 read', () => {
    showLive([toolBlock('p1', PLAN, ITEMS), toolBlock('r1', 'read', { path: 'a' })])
    expect(liveRows()).toEqual([['read', 'generating']])
    expect(planRows()).toHaveLength(0)

    showLive([toolBlock('r1', 'read', { path: 'a' }), toolBlock('p1', PLAN, { advance: true })])
    expect(liveRows()).toEqual([['read', 'pending']])
    expect(planRows()).toHaveLength(0)
  })
})

describe('末条带一个藏起来的列表调用（TLC-8，O4）', () => {
  it('TLC-8 末条 [正文, 成功的列表调用]：正文画在过程区，不是终答（没有复制按钮）', () => {
    show([
      assistant('a1', [readOk('r1')], SID),
      assistant('a2', [text('all set'), planOk('p2', { advance: true })], SID)
    ])
    expect(planRows()).toHaveLength(0)
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
