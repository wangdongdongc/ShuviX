// @vitest-environment jsdom
/**
 * 对话流里「悬浮才显形」的按钮在两种控件密度下（ChatHost `density`：缺省 compact = 桌面，touch = 手机布局的 web
 * 客户端 —— 手机没有悬停，那些按钮要么常驻、要么点一下才出；jsdom）：
 *
 *   MA-U12 compact（没有宿主 / density compact / 宿主没给 density）：回复的操作行 `[data-message-actions]` 恰一行，
 *          按钮的 title 恰是 [Copy, Read aloud, Show source, Regenerate, Fork from here]，每颗 aria-label = title，
 *          悬浮才显形（opacity-0 + group-hover:opacity-100）、p-0.5、图标 12
 *   MA-U13 touch：同样五颗，常驻（没有 opacity-0 / group-hover）、h-8 w-8、图标 15，行带 -ml-2；复制 → 正文；朗读 →
 *          speak 恰一次、第二个参数是卡的 id；源码 → 这颗换成「Show rendered」（aria-label 跟着），行还在；重新生成 /
 *          分支 → 以卡的 id 调用
 *   MA-U14 touch：流式卡没有操作行；落定的纯工具卡没给回调 → 没有行；给了 onFork → 只有分支那颗、常驻；两轮里只有
 *          lastAssistantId 那张有重新生成
 *   MA-U15 代码块的复制（CodeBlock，ts 围栏）：compact 悬浮才显形（opacity-0 group-hover/code:opacity-100
 *          focus-visible:opacity-100）；touch 常驻，点了复制代码原文、title 变 Copied
 *   MA-U18 压缩摘要行（CompactionNoticeRow）展开后的复制：compact 悬浮才显形（group-hover/notice）；touch 常驻，
 *          点了复制摘要全文
 *   MA-U19 错误行（ErrorEventBlock）的删除（aria-label Delete）：compact 悬浮才显形（group-hover）；touch 常驻，点了
 *          以这行的 id 调 removeMessage
 *   MA-U21 守卫：touch 下一组条目（点过的用户气泡、带 ts 代码块的回复、展开的压缩摘要、错误行）里没有一颗按钮的 class
 *          同时带 opacity-0 与 group-hover；compact 下同一组至少有 5 颗
 *
 * 桩：包入口 `@shuvix/chat-ui` 顶掉（getHostApi → null）；`useTtsPlayback` 顶成带 speak spy 的常量；剪贴板顶成 spy。
 * 可见项由真的 `buildVisibleItems` 造。i18n 走真 en 资源；文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

const spies = vi.hoisted(() => ({
  speak: vi.fn(),
  stop: vi.fn(),
  copy: vi.fn(),
  regenerate: vi.fn(),
  fork: vi.fn()
}))

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))
vi.mock('../../../hooks/useTtsPlayback', () => {
  const tts = {
    isPlaying: false,
    isLoading: false,
    playingMessageId: null,
    speak: (...args: unknown[]) => spies.speak(...args),
    stop: () => spies.stop()
  }
  return { useTtsPlayback: () => tts }
})
vi.mock('../../../utils/clipboard', () => ({
  copyToClipboard: (...args: unknown[]) => spies.copy(...args)
}))

import { useChatStore } from '../../../stores/chatStore'
import { ChatHostContext, type ChatHostValue } from '../../../host/chatHostContext'
import { AssistantBubble } from '../AssistantBubble'
import { CodeBlock } from '../CodeBlock'
import { MessageRenderer, type VisibleItem } from '../MessageRenderer'
import { buildVisibleItems } from '../conversationItems'
import {
  assistant,
  errorRow,
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
const TITLES = [
  en.message.copy,
  en.message.playTts,
  en.message.showSource,
  en.message.regenerate,
  en.message.fork
]

let container: HTMLDivElement
let root: Root
const originalRemoveMessage = useChatStore.getState().removeMessage

type Host = 'none' | 'compact' | 'no-density' | 'touch'
const COMPACT_HOSTS: Host[] = ['none', 'compact', 'no-density']
const DENSITIES = ['compact', 'touch'] as const

function wrap(host: Host, el: ReactElement): ReactElement {
  if (host === 'none') return el
  const value = (host === 'no-density' ? {} : { density: host }) as ChatHostValue
  return createElement(ChatHostContext.Provider, { value }, el)
}
function show(host: Host, el: ReactElement): void {
  act(() => {
    root.render(wrap(host, el))
  })
}
function renderItems(
  host: Host,
  items: VisibleItem[],
  extra: {
    lastAssistantId?: string | null
    onRegenerate?: (id: string) => void
    onFork?: (id: string) => void
    onRollback?: (id: string) => void
  } = {}
): void {
  show(
    host,
    createElement(
      'div',
      null,
      items.map((item) =>
        createElement(MessageRenderer, {
          key: item.key,
          item,
          lastAssistantId: extra.lastAssistantId ?? null,
          onRegenerate: extra.onRegenerate,
          onFork: extra.onFork,
          onRollback: extra.onRollback
        })
      )
    )
  )
}

const click = (el: Element): void => {
  act(() => {
    ;(el as HTMLElement).click()
  })
}
const classesOf = (el: Element): string[] => (el.getAttribute('class') ?? '').split(/\s+/)
/** 悬浮才显形：带 opacity-0，且带某个 `group-hover…:opacity-100` */
const hoverOnly = (el: Element, group = 'group-hover'): boolean => {
  const cls = classesOf(el)
  return cls.includes('opacity-0') && cls.includes(`${group}:opacity-100`)
}
/** 常驻：既没有 opacity-0，也没有任何 group-hover */
const alwaysVisible = (el: Element): boolean => {
  const cls = classesOf(el)
  return !cls.includes('opacity-0') && !cls.some((c) => c.startsWith('group-hover'))
}
const svgWidth = (el: Element): string | null =>
  el.querySelector('svg')?.getAttribute('width') ?? null
const actionRows = (scope: ParentNode = container): HTMLElement[] => [
  ...scope.querySelectorAll<HTMLElement>('[data-message-actions]')
]
const actionButtons = (scope: ParentNode = container): HTMLButtonElement[] =>
  actionRows(scope).flatMap((row) => [...row.querySelectorAll<HTMLButtonElement>('button')])
const byTitle = (title: string, scope: ParentNode = container): HTMLButtonElement | null =>
  scope.querySelector<HTMLButtonElement>(`button[title="${title}"]`)
const rowOf = (msgId: string): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-msg-id="${msgId}"]`)!

/** 一张只有一段终答的卡 */
const answerCard = (id = 'a1', body = 'answer'): ReactElement =>
  createElement(AssistantBubble, {
    msgs: [assistant(id, [text(body)], SID)],
    onRegenerate: spies.regenerate,
    onFork: spies.fork
  })

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
})

beforeEach(() => {
  resetStore(SID)
  useChatStore.setState({ removeMessage: originalRemoveMessage })
  for (const spy of [spies.speak, spies.stop, spies.copy, spies.regenerate, spies.fork]) {
    spy.mockReset()
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  useChatStore.setState({ removeMessage: originalRemoveMessage })
})

describe('MA-U12 compact：回复的操作行悬浮才显形', () => {
  it.each(COMPACT_HOSTS)(
    'MA-U12 %s：恰一行、五颗按 title 排好，aria-label = title，hover-only + p-0.5，图标 12',
    (host) => {
      show(host, answerCard())
      expect(actionRows()).toHaveLength(1)
      const buttons = actionButtons()
      expect(buttons.map((b) => b.title)).toEqual(TITLES)
      for (const btn of buttons) {
        expect(btn.getAttribute('aria-label'), btn.title).toBe(btn.title)
        expect(hoverOnly(btn), `${btn.title}: ${btn.className}`).toBe(true)
        expect(classesOf(btn)).toContain('p-0.5')
        expect(classesOf(btn)).not.toContain('h-8')
        expect(svgWidth(btn), btn.title).toBe('12')
      }
      expect(classesOf(actionRows()[0]!)).not.toContain('-ml-2')
    }
  )
})

describe('MA-U13 touch：回复的操作行常驻、放大', () => {
  it('MA-U13 五颗常驻、h-8 w-8、图标 15，行 -ml-2；各自点下去做该做的', () => {
    show('touch', answerCard())
    const [row] = actionRows()
    expect(row).toBeDefined()
    expect(classesOf(row!)).toContain('-ml-2')
    const buttons = actionButtons()
    expect(buttons.map((b) => b.title)).toEqual(TITLES)
    for (const btn of buttons) {
      expect(alwaysVisible(btn), `${btn.title}: ${btn.className}`).toBe(true)
      expect(classesOf(btn)).toContain('h-8')
      expect(classesOf(btn)).toContain('w-8')
      expect(svgWidth(btn), btn.title).toBe('15')
      expect(btn.getAttribute('aria-label')).toBe(btn.title)
    }

    click(byTitle(en.message.copy)!)
    expect(spies.copy).toHaveBeenCalledTimes(1)
    expect(spies.copy).toHaveBeenCalledWith('answer')

    click(byTitle(en.message.playTts)!)
    expect(spies.speak).toHaveBeenCalledTimes(1)
    expect(spies.speak.mock.calls[0]![1]).toBe('a1')

    click(byTitle(en.message.showSource)!)
    const rendered = byTitle(en.message.showRendered)
    expect(rendered).not.toBeNull()
    expect(rendered!.getAttribute('aria-label')).toBe(en.message.showRendered)
    expect(byTitle(en.message.showSource)).toBeNull()
    expect(actionRows()).toHaveLength(1)
    expect(alwaysVisible(rendered!)).toBe(true)

    click(byTitle(en.message.regenerate)!)
    expect(spies.regenerate.mock.calls).toEqual([['a1']])
    click(byTitle(en.message.fork)!)
    expect(spies.fork.mock.calls).toEqual([['a1']])
  })
})

describe('MA-U14 touch：操作行只在落定、有可操作项时出现', () => {
  it('MA-U14 流式卡（给了 onFork）→ 没有操作行', () => {
    show(
      'touch',
      createElement(AssistantBubble, {
        msgs: [assistant('live', [toolBlock('t-live', 'read')], SID)],
        isStreaming: true,
        onFork: spies.fork
      })
    )
    expect(actionRows()).toHaveLength(0)
    expect(container.querySelector('[data-fork-reply]')).toBeNull()
  })

  it('MA-U14 落定的纯工具卡、没给回调 → 没有行；给了 onFork → 只有分支那颗、常驻', () => {
    const msgs = [assistant('t1', [toolBlock('t1-c', 'read', {}, { result: 'ok' })], SID)]
    show('touch', createElement(AssistantBubble, { msgs }))
    expect(container.querySelector('[data-tool-name="read"]')).not.toBeNull()
    expect(actionRows()).toHaveLength(0)

    show('touch', createElement(AssistantBubble, { msgs, onFork: spies.fork }))
    expect(actionRows()).toHaveLength(1)
    const buttons = actionButtons()
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.hasAttribute('data-fork-reply')).toBe(true)
    expect(alwaysVisible(buttons[0]!)).toBe(true)
  })

  it('MA-U14 两轮（MessageRenderer，lastAssistantId = a2）→ 只有 a2 有重新生成', () => {
    const items = buildVisibleItems(
      [
        user('u1', 'q1', SID),
        assistant('a1', [text('one')], SID),
        user('u2', 'q2', SID),
        assistant('a2', [text('two')], SID)
      ],
      false
    )
    renderItems('touch', items, { lastAssistantId: 'a2', onRegenerate: spies.regenerate })
    expect(byTitle(en.message.regenerate, rowOf('a1'))).toBeNull()
    expect(byTitle(en.message.regenerate, rowOf('a2'))).not.toBeNull()
    expect(container.querySelectorAll(`button[title="${en.message.regenerate}"]`)).toHaveLength(1)
    // 两张卡的其它按钮都常驻
    for (const btn of actionButtons()) expect(alwaysVisible(btn), btn.title).toBe(true)
  })
})

/** react-markdown 交给 CodeBlock 的 hast：pre > code.language-<lang> > text */
interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}
const hast = (lang: string, code: string): HastNode => ({
  type: 'element',
  tagName: 'pre',
  properties: {},
  children: [
    {
      type: 'element',
      tagName: 'code',
      properties: { className: [`language-${lang}`] },
      children: [{ type: 'text', value: code }]
    }
  ]
})
const TS = 'const answer: number = 42\n'

describe('MA-U15 代码块的复制键', () => {
  it.each(DENSITIES)('MA-U15 %s', (density) => {
    show(
      density,
      createElement(
        CodeBlock,
        { node: hast('ts', TS) },
        createElement('code', { className: 'language-ts' }, TS)
      )
    )
    const btn = byTitle('Copy')
    expect(btn).not.toBeNull()
    const cls = classesOf(btn!)
    if (density === 'compact') {
      expect(cls).toEqual(
        expect.arrayContaining([
          'opacity-0',
          'group-hover/code:opacity-100',
          'focus-visible:opacity-100'
        ])
      )
    } else {
      expect(alwaysVisible(btn!), btn!.className).toBe(true)
      expect(cls).not.toContain('focus-visible:opacity-100')
      click(btn!)
      expect(spies.copy).toHaveBeenCalledTimes(1)
      expect(spies.copy).toHaveBeenCalledWith('const answer: number = 42')
      expect(btn!.title).toBe('Copied')
    }
  })
})

describe('MA-U18 压缩摘要行的复制键', () => {
  const SUMMARY = assistant('c1', [text('## Sum\nbody')], SID, { isCompactionSummary: true })

  it.each(DENSITIES)('MA-U18 %s：展开后的复制键', (density) => {
    renderItems(density, [{ key: 'c1', msg: SUMMARY }])
    const notice = container.querySelector<HTMLElement>('[data-system-notice="compaction"]')
    expect(notice).not.toBeNull()
    expect(notice!.getAttribute('data-notice-state')).toBe('collapsed')
    click(notice!.querySelector('button')!)
    expect(notice!.getAttribute('data-notice-state')).toBe('expanded')

    const btn = byTitle(en.message.copy, notice!)
    expect(btn).not.toBeNull()
    if (density === 'compact') {
      expect(hoverOnly(btn!, 'group-hover/notice'), btn!.className).toBe(true)
    } else {
      expect(alwaysVisible(btn!), btn!.className).toBe(true)
      click(btn!)
      expect(spies.copy).toHaveBeenCalledTimes(1)
      expect(spies.copy).toHaveBeenCalledWith(SUMMARY.content)
      expect(spies.copy).toHaveBeenCalledWith('## Sum\nbody')
    }
  })
})

describe('MA-U19 错误行的删除键', () => {
  it.each(DENSITIES)('MA-U19 %s', (density) => {
    const remove = vi.fn()
    useChatStore.setState({ removeMessage: remove })
    renderItems(density, [{ key: 'e1', msg: errorRow('e1', 'boom', SID) }])
    expect(rowOf('e1').textContent).toContain('boom')
    const btn = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${en.common.delete}"]`
    )
    expect(btn).not.toBeNull()
    if (density === 'compact') {
      expect(hoverOnly(btn!), btn!.className).toBe(true)
    } else {
      expect(alwaysVisible(btn!), btn!.className).toBe(true)
      click(btn!)
      expect(remove).toHaveBeenCalledTimes(1)
      expect(remove).toHaveBeenCalledWith('e1')
    }
  })
})

describe('MA-U21 守卫：触屏下没有悬浮才显形的按钮', () => {
  /** 一组条目：用户气泡、带 ts 代码块的回复、压缩摘要、错误行 */
  const items = (): VisibleItem[] => [
    ...buildVisibleItems(
      [
        user('u1', 'show me code', SID),
        assistant('a1', [text('Here:\n\n```ts\nconst x = 1\n```\n')], SID)
      ],
      false
    ),
    {
      key: 'c1',
      msg: assistant('c1', [text('## Sum\nbody')], SID, { isCompactionSummary: true })
    },
    { key: 'e1', msg: errorRow('e1', 'boom', SID) }
  ]
  const hoverOnlyButtons = (): HTMLButtonElement[] =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.className.includes('opacity-0') && b.className.includes('group-hover')
    )
  /** 把条目都摆开：点用户气泡（touch 才有用）、展开压缩摘要 */
  const openUp = (): void => {
    click(container.querySelector('[data-user-bubble]')!)
    const notice = container.querySelector<HTMLElement>('[data-system-notice="compaction"]')!
    click(notice.querySelector('button')!)
    expect(notice.getAttribute('data-notice-state')).toBe('expanded')
  }

  it('MA-U21 touch：没有一颗 class 同时带 opacity-0 与 group-hover', () => {
    renderItems('touch', items(), {
      lastAssistantId: 'a1',
      onRegenerate: spies.regenerate,
      onFork: spies.fork,
      onRollback: vi.fn()
    })
    openUp()
    // 前提：各处的按钮真的都在（不然「没有」什么也没证明）
    expect(container.querySelector(`button[aria-label="${en.message.rollback}"]`)).not.toBeNull()
    expect(container.querySelector('.markdown-body pre')).not.toBeNull()
    expect(actionButtons().length).toBe(5)
    expect(container.querySelector(`button[aria-label="${en.common.delete}"]`)).not.toBeNull()
    expect(
      byTitle(en.message.copy, container.querySelector('[data-system-notice="compaction"]')!)
    ).not.toBeNull()
    expect(hoverOnlyButtons().map((b) => b.outerHTML.slice(0, 160))).toEqual([])
  })

  it('MA-U21 compact：同一组至少 5 颗悬浮才显形', () => {
    renderItems('compact', items(), {
      lastAssistantId: 'a1',
      onRegenerate: spies.regenerate,
      onFork: spies.fork,
      onRollback: vi.fn()
    })
    openUp()
    expect(hoverOnlyButtons().length).toBeGreaterThanOrEqual(5)
  })
})
