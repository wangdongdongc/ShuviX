// @vitest-environment jsdom
/**
 * Conversation 的消息列表挂载时机、初始落点与「回到底部」按钮（jsdom）。
 *
 *   - 挂载门：视图到了（或有乐观占位）才挂 Virtuoso；只有运行中的余项、视图未到时什么都不挂（不画空态、
 *     不出按钮）。挂上时的初始位置是 `{index:'LAST', align:'end'}`（真底，含 Footer）；
 *   - 宽限期：挂上后先不认「不在底部」，直到第一次报「在底部」或过了 800ms；
 *   - 点击：离底超过三屏（严格大于）或拿不到滚动区 → `behavior:'auto'`，否则 `'smooth'`；
 *   - 换会话（key 变）整个重来；按钮的显示 / 隐藏属性、aria-label；运行中且显示时的运行指示；
 *   - 日历跳转：挂载时已有请求 → 直接当初始位置、清掉、不再滚；挂载后才到 → 等初始定位过了再
 *     `scrollToIndex`、清掉；目标不在列表里 → 清掉、不滚；别的会话的请求不碰。
 *
 * Virtuoso 换成一个记录 props / 挂载次数 / `scrollToIndex` 的桩（会把假滚动区交给 `scrollerRef`）；
 * 输入区、消息渲染、Footer 等重组件都顶成空壳 —— 被测的是 MessageList 的门与按钮，不是它们。
 * 数据走真的 chatStore（`applySessionView` / `markSessionRunning` / `setPendingPrompt`）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'

interface VirtuosoStubProps {
  data: Array<{ key: string; msg: { id: string } }>
  itemContent: (index: number, item: unknown) => ReactNode
  computeItemKey: (index: number, item: unknown) => string
  initialTopMostItemIndex: unknown
  scrollerRef?: (el: HTMLElement | Window | null) => void
  atBottomStateChange?: (atBottom: boolean) => void
  atBottomThreshold?: number
}

const virt = vi.hoisted(() => ({
  /** 挂载次数（每挂一次 +1） */
  mounts: 0,
  /** 每次挂载那一刻的 props */
  mountProps: [] as VirtuosoStubProps[],
  /** 最近一次渲染的 props */
  props: null as VirtuosoStubProps | null,
  scrollToIndex: vi.fn(),
  /** 挂载时交给 scrollerRef 的元素（null = 拿不到滚动区） */
  scroller: null as HTMLElement | null
}))

vi.mock('react-virtuoso', async () => {
  const React = await import('react')
  const Virtuoso = React.forwardRef<unknown, VirtuosoStubProps>(function VirtuosoStub(props, ref) {
    React.useImperativeHandle(ref, () => ({ scrollToIndex: virt.scrollToIndex }), [])
    virt.props = props
    React.useEffect(() => {
      virt.mounts++
      virt.mountProps.push(props)
      props.scrollerRef?.(virt.scroller)
      // 只在挂载 / 卸载时跑：与真 Virtuoso 一样，初始位置之类只认挂载那一刻
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return React.createElement(
      'div',
      { 'data-virtuoso-stub': '' },
      props.data.map((item, i) =>
        React.createElement(
          React.Fragment,
          { key: props.computeItemKey(i, item) },
          props.itemContent(i, item)
        )
      )
    )
  })
  return { Virtuoso }
})

vi.mock('@shuvix/chat-ui', () => ({
  useChatHost: () => ({ appearance: { focusMode: false } })
}))

vi.mock('../InputArea', async () => {
  const React = await import('react')
  return { InputArea: () => React.createElement('div', { 'data-stub-input': '' }) }
})
vi.mock('../PendingInputsPanel', () => ({ PendingInputsPanel: () => null }))
vi.mock('../StreamingFooter', () => ({ StreamingFooter: () => null }))
vi.mock('../../common/ConfirmDialog', () => ({ ConfirmDialog: () => null }))
vi.mock('../MessageRenderer', async () => {
  const React = await import('react')
  return {
    STREAMING_PLACEHOLDER_ID: 'streaming-live',
    MessageRenderer: ({ item }: { item: { key: string } }) =>
      React.createElement('div', { 'data-stub-item': item.key })
  }
})
vi.mock('../../../hooks/useChatActions', () => ({
  useChatActions: () => ({
    handleRollback: () => {},
    pendingRollbackId: null,
    confirmRollback: () => {},
    cancelRollback: () => {},
    handleRegenerate: () => {},
    canRollback: true,
    handleInputResponse: () => {}
  })
}))

import {
  applySessionView,
  pendingPromptMessage,
  useChatStore,
  type ChatMessage
} from '../../../stores/chatStore'
import { Conversation } from '../Conversation'
import { V, assistant, resetStore, text, user } from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const S1 = 's1'
const S2 = 's2'
const LIST_BOTTOM = { index: 'LAST', align: 'end' }
/** 三轮对话：u1 a1 u2 a2 u3 a3 —— 可见项下标就是消息下标（每张卡只有一条终答） */
const history = (sid: string): ChatMessage[] => [
  user(`${sid}-u1`, 'first', sid),
  assistant(`${sid}-a1`, [text('one')], sid),
  user(`${sid}-u2`, 'second', sid),
  assistant(`${sid}-a2`, [text('two')], sid),
  user(`${sid}-u3`, 'third', sid),
  assistant(`${sid}-a3`, [text('three')], sid)
]

let container: HTMLDivElement
let root: Root
/** 假滚动区的尺寸（scrollerRef 拿到的元素按它报 scrollHeight / scrollTop / clientHeight） */
const metrics = { scrollHeight: 10_000, scrollTop: 0, clientHeight: 500 }

function fakeScroller(): HTMLElement {
  const el = document.createElement('div')
  for (const key of ['scrollHeight', 'scrollTop', 'clientHeight'] as const) {
    Object.defineProperty(el, key, { configurable: true, get: () => metrics[key] })
  }
  return el
}

/** 把假滚动区摆到「离真底 dist」的位置 */
function distFromBottom(dist: number): void {
  metrics.scrollTop = metrics.scrollHeight - metrics.clientHeight - dist
}

const emptyMarker = createElement('div', { 'data-empty-marker': '' })

function render(sessionId: string): void {
  act(() => {
    root.render(createElement(Conversation, { sessionId, emptyState: emptyMarker }))
  })
}

function loadView(sid: string, messages: ChatMessage[], busy = false): void {
  act(() => {
    applySessionView(sid, V(sid, { messages, run: { state: busy ? 'busy' : 'idle' } }))
  })
}

const button = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('[data-scroll-to-bottom]')
const stubPresent = (): boolean => container.querySelector('[data-virtuoso-stub]') !== null
const emptyPresent = (): boolean => container.querySelector('[data-empty-marker]') !== null
/** 按钮是否处于显示态（aria-hidden 是唯一不随样式类变的判据；样式类另由 BTN-ATTR 用例钉） */
const shown = (): boolean => button()?.getAttribute('aria-hidden') === 'false'
const dots = (): number =>
  button()?.querySelectorAll(':scope > span[aria-hidden] > span').length ?? 0

const atBottom = (value: boolean): void => {
  act(() => virt.props!.atBottomStateChange!(value))
}
const advance = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}
const click = (): void => {
  act(() => button()!.click())
}
const request = (sid: string, messageId: string): void => {
  act(() => useChatStore.getState().requestScrollToMessage(sid, messageId))
}
const pendingRequest = (): unknown => useChatStore.getState().scrollToMessageRequest

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  vi.useFakeTimers()
  virt.mounts = 0
  virt.mountProps = []
  virt.props = null
  virt.scrollToIndex.mockReset()
  metrics.scrollHeight = 10_000
  metrics.clientHeight = 500
  metrics.scrollTop = 0
  virt.scroller = fakeScroller()
  resetStore(S1)
  useChatStore.setState({ scrollToMessageRequest: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('挂载门', () => {
  it('GATE-1 只有运行中的余项、视图未到：不挂列表、不画空态、没有按钮；视图一到挂且只挂一次，落在真底', () => {
    act(() => useChatStore.getState().markSessionRunning(S1, true))
    render(S1)
    expect(virt.mounts).toBe(0)
    expect(stubPresent()).toBe(false)
    expect(emptyPresent()).toBe(false)
    expect(button()).toBeNull()

    loadView(S1, history(S1), true)
    expect(virt.mounts).toBe(1)
    expect(virt.mountProps[0].initialTopMostItemIndex).toEqual(LIST_BOTTOM)
    // 挂上那一刻手里就是真消息（外加末尾的流式卡），而不是一张孤零零的流式占位
    const keys = virt.mountProps[0].data.map((item) => item.msg.id)
    expect(keys.slice(0, 6)).toEqual(history(S1).map((m) => m.id))
    expect(keys.at(-1)).toBe('streaming-live')

    // 之后视图再变：同一份列表接着用，不重挂
    loadView(S1, [...history(S1), user(`${S1}-u4`, 'fourth')], true)
    expect(virt.mounts).toBe(1)
  })

  it('GATE-2 只有乐观占位、视图未到：立刻挂（刚发出的那句话不等后端），初始位置同样是真底', () => {
    act(() => useChatStore.getState().setPendingPrompt(S1, pendingPromptMessage(S1, 'hello')))
    render(S1)
    expect(virt.mounts).toBe(1)
    expect(virt.mountProps[0].initialTopMostItemIndex).toEqual(LIST_BOTTOM)
    expect(virt.mountProps[0].data.map((item) => item.msg.id)).toContain('pending-prompt')
  })

  it('GATE-3 视图到了、一条消息都没有、也没在跑：画空态，不挂列表、没有按钮', () => {
    render(S1)
    loadView(S1, [])
    expect(emptyPresent()).toBe(true)
    expect(stubPresent()).toBe(false)
    expect(virt.mounts).toBe(0)
    expect(button()).toBeNull()
  })

  it('GATE-4 列表的到底阈值是 160px', () => {
    loadView(S1, history(S1))
    render(S1)
    expect(virt.props!.atBottomThreshold).toBe(160)
  })
})

describe('宽限期', () => {
  beforeEach(() => {
    loadView(S1, history(S1))
    render(S1)
  })

  it('GRACE-1 挂上就报「不在底部」：799ms 时仍隐藏，800ms 起显示', () => {
    atBottom(false)
    expect(shown()).toBe(false)
    advance(799)
    expect(shown()).toBe(false)
    advance(1)
    expect(shown()).toBe(true)
  })

  it('GRACE-2 先报过一次「在底部」（初始定位落地）：之后的「不在底部」立刻显示', () => {
    atBottom(true)
    expect(shown()).toBe(false)
    atBottom(false)
    expect(shown()).toBe(true)
  })

  it('GRACE-3 先「不在底部」、300ms 时落到底：宽限期满之后仍隐藏', () => {
    atBottom(false)
    advance(300)
    atBottom(true)
    advance(500)
    expect(shown()).toBe(false)
    advance(2_000)
    expect(shown()).toBe(false)
  })
})

describe('点击', () => {
  const showButton = (): void => {
    atBottom(true)
    atBottom(false)
    expect(shown()).toBe(true)
  }

  it.each([
    ['两屏', 2, 'smooth'],
    ['恰好三屏', 3, 'smooth'],
    ['四屏', 4, 'auto']
  ] as const)('CLICK-1 离底%s → behavior %s', (_label, screens, behavior) => {
    loadView(S1, history(S1))
    render(S1)
    showButton()
    distFromBottom(metrics.clientHeight * screens)
    click()
    expect(virt.scrollToIndex).toHaveBeenCalledTimes(1)
    expect(virt.scrollToIndex).toHaveBeenCalledWith({ index: 'LAST', align: 'end', behavior })
  })

  it('CLICK-2 拿不到滚动区 → behavior auto', () => {
    virt.scroller = null
    loadView(S1, history(S1))
    render(S1)
    showButton()
    click()
    expect(virt.scrollToIndex).toHaveBeenCalledWith({
      index: 'LAST',
      align: 'end',
      behavior: 'auto'
    })
  })
})

describe('按钮', () => {
  it('BTN-ATTR 隐藏态与显示态的属性；aria-label 是 chat.scrollToBottom 的真文案', () => {
    loadView(S1, history(S1))
    render(S1)
    const btn = button()!
    expect(btn.getAttribute('aria-hidden')).toBe('true')
    expect(btn.tabIndex).toBe(-1)
    expect(btn.className).toContain('pointer-events-none')
    expect(btn.className).toContain('opacity-0')
    expect(btn.getAttribute('aria-label')).toBe(zh.chat.scrollToBottom)
    expect(zh.chat.scrollToBottom.length).toBeGreaterThan(0)

    atBottom(true)
    atBottom(false)
    expect(btn.getAttribute('aria-hidden')).toBe('false')
    expect(btn.tabIndex).toBe(0)
    expect(btn.className).not.toContain('pointer-events-none')
    expect(btn.className).toContain('opacity-100')
    expect(btn.getAttribute('aria-label')).toBe(zh.chat.scrollToBottom)
  })

  it('BTN-RESET 换会话即从头来过：重挂一次，上一条会话的「显示」不带过来，宽限期重新计', () => {
    loadView(S1, history(S1))
    loadView(S2, history(S2))
    render(S1)
    atBottom(true)
    atBottom(false)
    expect(shown()).toBe(true)

    act(() => useChatStore.getState().setActiveSessionId(S2))
    render(S2)
    expect(virt.mounts).toBe(2)
    expect(virt.mountProps[1].initialTopMostItemIndex).toEqual(LIST_BOTTOM)
    expect(shown()).toBe(false)
    atBottom(false)
    advance(799)
    expect(shown()).toBe(false)
    advance(1)
    expect(shown()).toBe(true)
  })

  it('RUN-1 运行中且显示：带 data-running 与三个圆点', () => {
    loadView(S1, history(S1), true)
    render(S1)
    atBottom(true)
    atBottom(false)
    expect(shown()).toBe(true)
    expect(button()!.hasAttribute('data-running')).toBe(true)
    expect(dots()).toBe(3)
  })

  it('RUN-2 显示但没在跑：没有 data-running、没有圆点', () => {
    loadView(S1, history(S1))
    render(S1)
    atBottom(true)
    atBottom(false)
    expect(shown()).toBe(true)
    expect(button()!.hasAttribute('data-running')).toBe(false)
    expect(dots()).toBe(0)
  })

  it('RUN-3 在跑但按钮隐藏：圆点不挂、没有 data-running', () => {
    loadView(S1, history(S1), true)
    render(S1)
    atBottom(true)
    expect(shown()).toBe(false)
    expect(button()!.hasAttribute('data-running')).toBe(false)
    expect(dots()).toBe(0)
  })
})

describe('日历跳转', () => {
  it('CAL-1 挂载时已有本会话的请求：直接当初始位置（目标项、顶边对齐），清掉，不再另滚', () => {
    loadView(S1, history(S1))
    act(() => useChatStore.getState().requestScrollToMessage(S1, `${S1}-u3`))
    render(S1)
    expect(virt.mounts).toBe(1)
    expect(virt.mountProps[0].initialTopMostItemIndex).toEqual({ index: 4, align: 'start' })
    expect(pendingRequest()).toBeNull()
    atBottom(false)
    advance(1_000)
    atBottom(true)
    expect(virt.scrollToIndex).not.toHaveBeenCalled()
  })

  it('CAL-2 挂载之后才到：初始定位过了之前不滚、请求留着；过了再滚到目标并清掉', () => {
    loadView(S1, history(S1))
    render(S1)
    request(S1, `${S1}-u2`)
    expect(virt.scrollToIndex).not.toHaveBeenCalled()
    expect(pendingRequest()).not.toBeNull()

    advance(800)
    expect(virt.scrollToIndex).toHaveBeenCalledTimes(1)
    expect(virt.scrollToIndex).toHaveBeenCalledWith({ index: 2, align: 'start' })
    expect(pendingRequest()).toBeNull()
  })

  it('CAL-3 初始定位已落地后才到（第一次报「在底部」）：立刻滚到目标并清掉', () => {
    loadView(S1, history(S1))
    render(S1)
    atBottom(true)
    request(S1, `${S1}-a2`)
    expect(virt.scrollToIndex).toHaveBeenCalledWith({ index: 3, align: 'start' })
    expect(pendingRequest()).toBeNull()
  })

  it('CAL-4 目标不在列表里：清掉，不滚', () => {
    loadView(S1, history(S1))
    render(S1)
    atBottom(true)
    request(S1, 'not-in-context')
    expect(virt.scrollToIndex).not.toHaveBeenCalled()
    expect(pendingRequest()).toBeNull()
  })

  it('CAL-5 别的会话的请求：不碰（不滚、不清）', () => {
    loadView(S1, history(S1))
    render(S1)
    atBottom(true)
    request(S2, `${S2}-u1`)
    expect(virt.scrollToIndex).not.toHaveBeenCalled()
    expect(pendingRequest()).toMatchObject({ sessionId: S2 })
  })

  /**
   * 回归：列表的初始位置是从一条日历请求来的（CAL-1 那条路），之后同一份列表上再来一条日历请求，照样滚过去。
   * `requestScrollToMessage` 的 nonce 取 `(当前请求?.nonce ?? 0) + 1`，用掉的请求又被清成 null，所以清过之后
   * 每一条新请求的 nonce 都重新是 1 —— 列表按 nonce 认「哪条已当初始位置用掉」时，第二条会撞上它、只清不滚
   * （日历里点进会话 X 之后再在日历里点 X，列表不动）。列表现在按请求对象认。
   */
  it('CAL-6 初始位置来自日历请求之后，同一份列表上的下一条日历请求照样滚过去', () => {
    loadView(S1, history(S1))
    act(() => useChatStore.getState().requestScrollToMessage(S1, `${S1}-u3`))
    render(S1)
    expect(pendingRequest()).toBeNull()
    atBottom(true)
    advance(1_000)

    request(S1, `${S1}-u1`)
    expect(virt.scrollToIndex).toHaveBeenCalledWith({ index: 0, align: 'start' })
  })
})
