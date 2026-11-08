// @vitest-environment jsdom
/**
 * Conversation 的消息列表挂载时机、初始落点与「回到底部」按钮（jsdom）。
 *
 *   - 挂载门：视图到了（或有乐观占位）才挂 Virtuoso、才画空态；视图未到时什么都不挂（不画空态、
 *     不出按钮）。挂上时的初始位置是 `{index:'LAST', align:'end'}`（真底，含 Footer）；
 *   - 进度条：有历史要等就从第一刻挂上（CSS 让它 100ms 后露面），上屏就撤；列表不等它，数据一到就挂、定位好就可见；
 *   - 宽限期：挂上后先不认「不在底部」，直到第一次报「在底部」或过了 800ms；
 *   - 点击：离底超过三屏（严格大于）或拿不到滚动区 → `behavior:'auto'`，否则 `'smooth'`；
 *   - 换会话（key 变）整个重来；按钮的显示 / 隐藏属性、aria-label；运行中且显示时的运行指示；
 *   - 日历跳转：挂载时已有请求 → 直接当初始位置、清掉、不再滚；挂载后才到 → 等初始定位过了再
 *     `scrollToIndex`、清掉；目标不在列表里 → 清掉、不滚；别的会话的请求不碰；
 *   - 询问卡片（CS 系列）：卡片在 Footer 里；人在底部才把新卡片露出来（400ms 的跟随，人一动就松开）；「等你批准」提示看的是
 *     量出来的卡片位置（滚动、总高变化时重量），不是 Virtuoso 那 160px 的「在底部」；看不见的卡片数字键不算数。
 *
 * Virtuoso 换成一个记录 props / 挂载次数 / `scrollToIndex` 的桩（会把假滚动区交给 `scrollerRef`）；
 * 输入区、消息渲染、Footer 等重组件都顶成空壳 —— 被测的是 MessageList 的门与按钮，不是它们。桩把 `components.Footer`
 * 画进一层 `[data-virtuoso-scroller]`（矩形跟着假滚动区），询问面板换成只挂真 `useOptionHotkeys` 的空壳：外框与把关是真的。
 * 数据走真的 chatStore（`applySessionView` / `markSessionRunning` / `setPendingPrompt`）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { Session } from '@shuvix/chat-protocol/chatApi'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'

interface VirtuosoStubProps {
  data: Array<{ key: string; msg: { id: string } }>
  itemContent: (index: number, item: unknown) => ReactNode
  computeItemKey: (index: number, item: unknown) => string
  initialTopMostItemIndex: unknown
  scrollerRef?: (el: HTMLElement | Window | null) => void
  atBottomStateChange?: (atBottom: boolean) => void
  atBottomThreshold?: number
  totalListHeightChanged?: (height: number) => void
  components: {
    List: (props: Record<string, unknown>) => ReactNode
    Footer: (props: { context: unknown }) => ReactNode
  }
  context: {
    landed: boolean
    onInputResponse: (requestId: string, response: unknown) => void
  }
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
  scroller: null as HTMLElement | null,
  /** 滚动区的矩形（量询问卡片时用） */
  viewRect: { top: 0, bottom: 500 },
  /** useChatActions 的 handleInputResponse */
  handleInputResponse: vi.fn(),
  /** 询问面板空壳收到的 onResponse（最近一次） */
  panelOnResponse: null as ((requestId: string, response: unknown) => void) | null,
  /** 数字键选中了哪一行 */
  picked: vi.fn(),
  /** 输入卡片空壳收到的 onHeightChange */
  onHeightChange: null as ((height: number) => void) | null
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
      ),
      React.createElement(
        'div',
        {
          'data-virtuoso-scroller': '',
          ref: (el: HTMLElement | null) => {
            if (el) el.getBoundingClientRect = () => virt.viewRect as DOMRect
          }
        },
        React.createElement(props.components.Footer, { context: props.context })
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
  return {
    InputArea: ({ onHeightChange }: { onHeightChange?: (height: number) => void }) => {
      virt.onHeightChange = onHeightChange ?? null
      return React.createElement('div', { 'data-stub-input': '' })
    }
  }
})
vi.mock('../PendingInputsPanel', async () => {
  const { useOptionHotkeys } = await import('../inputs/OptionRows')
  return {
    PendingInputsPanel: ({
      onResponse
    }: {
      onResponse: (requestId: string, response: unknown) => void
    }) => {
      virt.panelOnResponse = onResponse
      useOptionHotkeys(2, (index) => virt.picked(index))
      return null
    }
  }
})
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
    handleInputResponse: virt.handleInputResponse
  })
}))

import {
  applySessionView,
  markSessionViewFailed,
  pendingPromptMessage,
  useChatStore,
  type ChatMessage
} from '../../../stores/chatStore'
import { Conversation } from '../Conversation'
import { V, assistant, resetStore, text, toolBlock, user } from '../../../__tests__/support/views'
import { TASK_LIST_TOOL_NAME } from '@shuvix/chat-protocol/taskList'

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
  for (const key of ['scrollHeight', 'clientHeight'] as const) {
    Object.defineProperty(el, key, { configurable: true, get: () => metrics[key] })
  }
  // 贴底时会写它：与真滚动区一样夹在范围内
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (value: number) => {
      metrics.scrollTop = Math.min(value, metrics.scrollHeight - metrics.clientHeight)
    }
  })
  el.getBoundingClientRect = () => ({ top: 0, bottom: metrics.clientHeight }) as DOMRect
  el.querySelectorAll = (() => renderedItems) as unknown as typeof el.querySelectorAll
  // 假滚动区不在文档里，Footer 画在桩的那一层：量询问卡片时替它去容器里找
  el.querySelector = ((selector: string) =>
    container.querySelector(selector)) as typeof el.querySelector
  return el
}

/** 假滚动区里此刻渲染着的项（`hasLanded` 量的就是它们）：缺省一项、就是开头、底边在视口内 */
const fakeItem = (index: number, top: number, bottom: number): HTMLElement =>
  ({
    dataset: { itemIndex: String(index) },
    getBoundingClientRect: () => ({ top, bottom })
  }) as unknown as HTMLElement
let renderedItems: HTMLElement[] = [fakeItem(0, 0, 100)]

/** 把假滚动区摆到「离真底 dist」的位置 */
function distFromBottom(dist: number): void {
  metrics.scrollTop = metrics.scrollHeight - metrics.clientHeight - dist
}

/** 侧栏数据里这条会话的行：只有 createdAt / lastActiveAt 影响进度条 */
function setRow(id: string, times: { createdAt: number; lastActiveAt: number }): void {
  act(() => useChatStore.setState({ sessions: [{ id, ...times } as Session] }))
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
const BAR = '[data-conversation-load-bar]'
/** 进度条在屏上且没在淡出 */
const barShown = (): boolean => container.querySelector(`${BAR}:not(.opacity-0)`) !== null
/** 进度条还在 DOM 里（淡出中也算） */
const barInDom = (): boolean => container.querySelector(BAR) !== null
const failedPresent = (): boolean =>
  container.querySelector('[data-conversation-load-failed]') !== null
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
/** 列表定位好了：量到贴底，Virtuoso 也报到底 */
const land = (): void => {
  distFromBottom(0)
  atBottom(true)
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
  virt.viewRect = { top: 0, bottom: 500 }
  virt.handleInputResponse.mockReset()
  virt.panelOnResponse = null
  virt.picked.mockReset()
  metrics.scrollHeight = 10_000
  metrics.clientHeight = 500
  metrics.scrollTop = 0
  renderedItems = [fakeItem(0, 0, 100)]
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

  it('GATE-3a 视图未到、也没有余项：不画空态（打开有记录的会话不闪空态）；视图带着消息到了直接是列表', () => {
    render(S1)
    expect(emptyPresent()).toBe(false)
    expect(virt.mounts).toBe(0)

    loadView(S1, history(S1))
    expect(emptyPresent()).toBe(false)
    expect(virt.mounts).toBe(1)
  })

  it('GATE-3b 切到另一条视图未到的会话：同样不画空态，上一条的列表也不留着', () => {
    loadView(S1, history(S1))
    render(S1)
    expect(stubPresent()).toBe(true)

    render(S2)
    expect(emptyPresent()).toBe(false)
    expect(stubPresent()).toBe(false)
  })

  it('GATE-3c 视图不可用（会话被删，视图回到空）：画空态', () => {
    loadView(S1, history(S1))
    render(S1)
    act(() => applySessionView(S1, null))
    expect(emptyPresent()).toBe(true)
    expect(stubPresent()).toBe(false)
  })

  it('GATE-4 列表的到底阈值是 160px', () => {
    loadView(S1, history(S1))
    render(S1)
    expect(virt.props!.atBottomThreshold).toBe(160)
  })
})

describe('进度条', () => {
  it('LB-1 视图迟迟不到：进度条从第一刻就挂着（露面交给 CSS）；不画空态、不挂列表、读屏跳过', () => {
    render(S1)
    expect(barShown()).toBe(true)
    expect(container.querySelector(`${BAR} > div`)!.className).toContain(
      'conversation-load-segment'
    )
    expect(container.querySelector(BAR)!.getAttribute('aria-hidden')).toBe('true')
    // 不吞操作：点击和滚轮穿给下面的列表
    expect(container.querySelector(BAR)!.className).toContain('pointer-events-none')
    advance(1000)
    expect(barShown()).toBe(true)
    expect(emptyPresent()).toBe(false)
    expect(virt.mounts).toBe(0)
    expect(button()).toBeNull()
  })

  it('LB-2 视图到了、列表也在 100ms 内定位好：进度条还没露面，直接摘掉，不淡出', () => {
    render(S1)
    advance(50)
    loadView(S1, history(S1))
    expect(virt.mounts).toBe(1)
    advance(49)
    land()
    expect(barShown()).toBe(false)
    advance(0)
    expect(barInDom()).toBe(false)
    expect(virt.mounts).toBe(1)
  })

  it('LB-3 视图很快到、列表迟迟没定位好：进度条叠在已经挂上的列表上，定位好就淡出', () => {
    render(S1)
    advance(50)
    loadView(S1, history(S1))
    expect(virt.mounts).toBe(1)
    advance(150)
    expect(barShown()).toBe(true)
    expect(stubPresent()).toBe(true)

    land()
    expect(barShown()).toBe(false)
    expect(virt.mounts).toBe(1)
  })

  it('LB-4 进度条出现后视图才到：列表当场挂上，落在真底，只挂一次；定位好才淡出', () => {
    render(S1)
    advance(100)
    advance(10)
    loadView(S1, history(S1))
    expect(barShown()).toBe(true)
    expect(virt.mounts).toBe(1)
    expect(virt.mountProps[0].initialTopMostItemIndex).toEqual(LIST_BOTTOM)
    expect(virt.mountProps[0].data.map((item) => item.msg.id)).toEqual(history(S1).map((m) => m.id))

    land()
    expect(barShown()).toBe(false)
    expect(virt.mounts).toBe(1)
  })

  it('LB-5 淡出 150ms 后离开 DOM，之后不再回来', () => {
    render(S1)
    advance(100)
    loadView(S1, history(S1))
    land()
    expect(barInDom()).toBe(true)
    advance(149)
    expect(barInDom()).toBe(true)
    advance(1)
    expect(barInDom()).toBe(false)
    advance(2000)
    expect(barInDom()).toBe(false)
  })

  it('LB-15 初始定位不在底部（日历跳到中间）：列表自己揭开，进度条不等它，也不盖住「回到底部」', () => {
    loadView(S1, history(S1))
    request(S1, `${S1}-u2`)
    render(S1)
    expect(virt.mountProps[0].initialTopMostItemIndex).toEqual({ index: 2, align: 'start' })
    advance(1000)
    expect(barShown()).toBe(false)
  })

  it('LB-16 初始定位不在底部、进度条已经出现：立刻淡出，不等宽限期', () => {
    render(S1)
    advance(100)
    request(S1, `${S1}-u2`)
    loadView(S1, history(S1))
    expect(virt.mountProps[0].initialTopMostItemIndex).toEqual({ index: 2, align: 'start' })
    expect(barShown()).toBe(false)
  })

  it('LB-6 列表一直量不到贴底（窗口在后台）：过了 800ms 宽限期也淡出', () => {
    render(S1)
    loadView(S1, history(S1))
    advance(799)
    expect(barShown()).toBe(true)
    advance(1)
    expect(barShown()).toBe(false)
  })

  it('LB-7 等来的是一条空会话：进度条淡出，当场是空态，不挂列表', () => {
    render(S1)
    advance(100)
    expect(barShown()).toBe(true)
    loadView(S1, [])
    expect(barShown()).toBe(false)
    expect(emptyPresent()).toBe(true)
    expect(virt.mounts).toBe(0)
  })

  it('LB-8 换会话：淡出不带过去，计时从头来', () => {
    render(S1)
    advance(100)
    loadView(S1, history(S1))
    land()
    expect(barShown()).toBe(false)

    act(() => useChatStore.getState().setActiveSessionId(S2))
    render(S2)
    expect(barShown()).toBe(true)
    advance(50)
    loadView(S2, [])
    expect(barShown()).toBe(false)
    // S2 才过了 50ms，还没露面：直接摘掉。计时要是带着 S1 的，这里会走淡出
    advance(0)
    expect(barInDom()).toBe(false)
  })

  it('LB-9 运行中的余项、视图迟迟不到：出进度条，不是孤零零的流式占位', () => {
    act(() => useChatStore.getState().markSessionRunning(S1, true))
    render(S1)
    advance(100)
    expect(barShown()).toBe(true)
    expect(virt.mounts).toBe(0)
  })

  it('LB-10 进度条显示中发出第一句话：列表带着这句话挂上，进度条不等定位就淡出', () => {
    render(S1)
    advance(100)
    expect(barShown()).toBe(true)
    act(() => useChatStore.getState().setPendingPrompt(S1, pendingPromptMessage(S1, 'hello')))
    expect(virt.mountProps[0].data.map((item) => item.msg.id)).toContain('pending-prompt')
    expect(barShown()).toBe(false)
  })

  it('LB-23 淡出途中又有历史要等（发第一句话时视图带着历史到了）：进度条回来，定位好才再淡出', () => {
    render(S1)
    advance(100)
    act(() => useChatStore.getState().setPendingPrompt(S1, pendingPromptMessage(S1, 'hello')))
    expect(barShown()).toBe(false)
    advance(100)
    loadView(S1, history(S1))
    expect(barShown()).toBe(true)
    advance(600)
    expect(barInDom()).toBe(true)
  })

  it('LB-11 打开时是空会话，之后发第一句话：不算打开，进度条不出现', () => {
    render(S1)
    loadView(S1, [])
    expect(emptyPresent()).toBe(true)
    act(() => useChatStore.getState().setPendingPrompt(S1, pendingPromptMessage(S1, 'hello')))
    expect(virt.mounts).toBe(1)
    advance(1000)
    expect(barShown()).toBe(false)
  })

  it('LB-17 欢迎页发第一句话（视图没到，只有乐观占位）：列表迟迟没定位好也不出进度条', () => {
    act(() => useChatStore.getState().setPendingPrompt(S1, pendingPromptMessage(S1, 'hello')))
    render(S1)
    expect(virt.mounts).toBe(1)
    advance(600)
    expect(barInDom()).toBe(false)
  })

  it('LB-24 第一句话发出之后视图才带着这句话到：不算打开，进度条不出现', () => {
    act(() => useChatStore.getState().setPendingPrompt(S1, pendingPromptMessage(S1, 'hello')))
    render(S1)
    advance(100)
    loadView(S1, history(S1))
    advance(500)
    expect(barInDom()).toBe(false)
    expect(virt.mounts).toBe(1)
  })

  it('LB-18 视图到了、还没有消息，同时正发着第一句话：没有历史，不出进度条', () => {
    loadView(S1, [])
    act(() => useChatStore.getState().setPendingPrompt(S1, pendingPromptMessage(S1, 'hello')))
    render(S1)
    expect(virt.mounts).toBe(1)
    advance(1000)
    expect(barShown()).toBe(false)
  })

  it('LB-19 视图到了、没有消息、已经在跑（从主进程发起的新会话）：没有历史，不出进度条', () => {
    loadView(S1, [], true)
    render(S1)
    expect(virt.mounts).toBe(1)
    advance(1000)
    expect(barShown()).toBe(false)
  })

  it('LB-20 从没发过消息的会话、视图迟迟不到：一直不出进度条，也不画空态；视图到了是空态', () => {
    setRow(S1, { createdAt: 1000, lastActiveAt: 1000 })
    render(S1)
    expect(barInDom()).toBe(false)
    advance(2000)
    expect(barShown()).toBe(false)
    expect(emptyPresent()).toBe(false)
    loadView(S1, [])
    expect(emptyPresent()).toBe(true)
    expect(barShown()).toBe(false)
  })

  it('LB-21 发过消息的会话、视图迟迟不到：照常出进度条', () => {
    setRow(S1, { createdAt: 1000, lastActiveAt: 1001 })
    render(S1)
    advance(100)
    expect(barShown()).toBe(true)
  })

  it('LB-22 会话行说没发过消息、视图却带着历史到了（fork）：不补出进度条，列表照常挂上', () => {
    setRow(S1, { createdAt: 1000, lastActiveAt: 1000 })
    render(S1)
    advance(600)
    loadView(S1, history(S1))
    expect(virt.mounts).toBe(1)
    advance(1000)
    expect(barShown()).toBe(false)
  })

  it('LB-12 订阅失败：进度条淡出，当场是失败提示，不画空态', () => {
    render(S1)
    advance(100)
    expect(barShown()).toBe(true)
    act(() => markSessionViewFailed(S1, true))
    expect(barShown()).toBe(false)
    expect(failedPresent()).toBe(true)
    expect(emptyPresent()).toBe(false)
    expect(virt.mounts).toBe(0)
  })

  it('LB-13 订阅在 100ms 内就失败：直接是失败提示，进度条不出现', () => {
    render(S1)
    act(() => markSessionViewFailed(S1, true))
    expect(failedPresent()).toBe(true)
    advance(1000)
    expect(barShown()).toBe(false)
    expect(failedPresent()).toBe(true)
  })

  it('LB-14 视图在、失败标记也在：照常是列表，不是失败提示', () => {
    act(() => markSessionViewFailed(S1, true))
    loadView(S1, history(S1))
    render(S1)
    expect(failedPresent()).toBe(false)
    expect(virt.mounts).toBe(1)
  })
})

describe('揭开列表', () => {
  /** 按 Virtuoso 给的样式渲染一次真的 List 组件，读它最后用的 visibility */
  const listVisibility = (): string => {
    const host = document.createElement('div')
    const listRoot = createRoot(host)
    const List = virt.props!.components.List
    act(() => {
      listRoot.render(
        createElement(List, {
          context: virt.props!.context,
          style: { visibility: 'hidden' },
          'data-testid': 'list'
        })
      )
    })
    const el = host.querySelector<HTMLElement>('[data-testid=list]')!
    const value = el.style.visibility
    act(() => listRoot.unmount())
    return value
  }

  it('REV-1 Virtuoso 报到底、量出来也贴底：揭开，不等它的定时器', () => {
    loadView(S1, history(S1))
    render(S1)
    expect(listVisibility()).toBe('hidden')
    distFromBottom(0)
    atBottom(true)
    expect(listVisibility()).toBe('visible')
  })

  it('REV-2 Virtuoso 报到底、量出来还差很远（高度是估的）：不揭开，等真的滚到底', () => {
    loadView(S1, history(S1))
    render(S1)
    distFromBottom(6000)
    atBottom(true)
    expect(listVisibility()).toBe('hidden')

    distFromBottom(0)
    act(() => {
      virt.scroller!.dispatchEvent(new Event('scroll'))
    })
    expect(listVisibility()).toBe('visible')
  })

  it('REV-3 差 4px 以内算贴底，再多不算', () => {
    loadView(S1, history(S1))
    render(S1)
    distFromBottom(5)
    atBottom(true)
    expect(listVisibility()).toBe('hidden')
    distFromBottom(4)
    act(() => {
      virt.scroller!.dispatchEvent(new Event('scroll'))
    })
    expect(listVisibility()).toBe('visible')
  })

  it('REV-4 不贴底的初始定位（日历跳到中间）：一直不强行揭开，交给 Virtuoso 自己', () => {
    loadView(S1, history(S1))
    render(S1)
    distFromBottom(6000)
    advance(1000)
    expect(listVisibility()).toBe('hidden')
  })

  it('REV-6 一项都还没渲染（总高为零，正好「到底」）：不揭开', () => {
    renderedItems = []
    loadView(S1, history(S1))
    render(S1)
    land()
    expect(listVisibility()).toBe('hidden')
  })

  it('REV-7 上沿没铺满（探测阶段只渲染了末项，上面还空着）：不揭开；铺满或渲染到开头才揭开', () => {
    renderedItems = [fakeItem(5, 200, 400)]
    loadView(S1, history(S1))
    render(S1)
    land()
    expect(listVisibility()).toBe('hidden')

    renderedItems = [fakeItem(3, -50, 100), fakeItem(5, 200, 400)]
    act(() => {
      virt.scroller!.dispatchEvent(new Event('scroll'))
    })
    expect(listVisibility()).toBe('visible')
  })

  it('REV-8 最后一项的底边还在视口下面（实际高度比估的高）：不揭开', () => {
    renderedItems = [fakeItem(0, 0, 100), fakeItem(5, 200, 6000)]
    loadView(S1, history(S1))
    render(S1)
    land()
    expect(listVisibility()).toBe('hidden')
  })

  it('REV-5 组件引用稳定：重渲染不会让 Virtuoso 重挂列表', () => {
    loadView(S1, history(S1))
    render(S1)
    const before = virt.props!.components
    distFromBottom(0)
    atBottom(true)
    loadView(S1, [...history(S1), user(`${S1}-u4`, 'fourth')])
    expect(virt.props!.components).toBe(before)
    expect(virt.mounts).toBe(1)
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

describe('询问卡片', () => {
  const ASK: InputRequest = { id: 'r1', kind: 'ask', toolName: 'bash', command: 'ls', createdAt: 0 }
  const ASK2: InputRequest = {
    id: 'r2',
    kind: 'ask',
    toolName: 'bash',
    command: 'pwd',
    createdAt: 1
  }
  const CHOICE: InputRequest = {
    id: 'r3',
    kind: 'choice',
    toolName: 'ask',
    question: 'Which?',
    options: [{ label: 'A', description: '' }],
    createdAt: 2
  }

  const END = (): number => metrics.scrollHeight - metrics.clientHeight
  /** 卡片的矩形（量位置时读），缺省整张露着；--chat-input-h 由 composerH 给 */
  let cardRect = { top: 100, bottom: 300 }
  let composerH = 0

  beforeEach(() => {
    cardRect = { top: 100, bottom: 300 }
    composerH = 0
    const real = window.getComputedStyle.bind(window)
    // 列根上的 --chat-input-h 由真输入卡片量出来再写，这里输入卡片是空壳：直接给量到的值
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const style = real(el, pseudo)
      const original = style.getPropertyValue.bind(style)
      style.getPropertyValue = (name: string) =>
        name === '--chat-input-h' ? `${composerH}px` : original(name)
      return style
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 给（此刻以及之后重挂的）卡片桩上矩形 */
  const placeCard = (): void => {
    const card = container.querySelector<HTMLElement>('[data-pending-card]')
    if (card) card.getBoundingClientRect = () => cardRect as DOMRect
  }
  const setAsks = (asks: InputRequest[], busy = false): void => {
    act(() =>
      applySessionView(
        S1,
        V(S1, {
          messages: history(S1),
          run: { state: busy ? 'busy' : 'idle' },
          asks
        })
      )
    )
    placeCard()
  }
  /** 过一帧：贴底与量位置都在下一帧 */
  const frame = (): void => advance(16)
  const pill = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('[data-pending-jump]')
  const pillShown = (): boolean => pill()?.getAttribute('aria-hidden') === 'false'
  const scrollEvent = (): void => {
    act(() => {
      virt.scroller!.dispatchEvent(new Event('scroll'))
    })
  }
  const heightChanged = (height: number): void => {
    metrics.scrollHeight = height
    act(() => virt.props!.totalListHeightChanged!(height))
  }

  /** 挂好、定位好，落地后的跟随也过了：之后的贴底都是询问那条路带来的 */
  const settledAtBottom = (): void => {
    loadView(S1, history(S1))
    render(S1)
    land()
    advance(3_000)
  }
  /** 人往上翻：离底 dist，Virtuoso 报不在底部 */
  const scrolledUp = (dist = 3_000): void => {
    settledAtBottom()
    distFromBottom(dist)
    atBottom(false)
  }
  /** 卡片在下面、不在屏幕上 */
  const cardBelow = (): void => {
    cardRect = { top: 3_000, bottom: 3_200 }
  }
  const press = (key: string): boolean => {
    let result = true
    act(() => {
      result = document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true })
      )
    })
    return result
  }

  it('CS-1 人在底部、询问露面：下一帧贴到真底', () => {
    settledAtBottom()
    metrics.scrollHeight = 10_200 // 卡片把列表撑高了
    setAsks([ASK])
    expect(metrics.scrollTop).toBe(9_500)
    frame()
    expect(metrics.scrollTop).toBe(END())
    expect(pillShown()).toBe(false)
  })

  it('CS-1b 离底 150px（Virtuoso 还算在底部）时询问露面：同样被带到底（160px 之内不算在翻历史）', () => {
    settledAtBottom()
    distFromBottom(150)
    setAsks([ASK])
    frame()
    expect(metrics.scrollTop).toBe(END())
  })

  it('CS-2 跟随窗口：100ms 时总高变了照贴；400ms 之后不再贴', () => {
    settledAtBottom()
    setAsks([ASK])
    frame()

    advance(84)
    heightChanged(10_300)
    frame()
    expect(metrics.scrollTop).toBe(END())

    advance(400)
    const before = metrics.scrollTop
    heightChanged(10_600)
    frame()
    expect(metrics.scrollTop).toBe(before)
  })

  it('CS-3 人在往上翻：询问露面不动滚动位置，总高变了也不动', () => {
    scrolledUp()
    const top = metrics.scrollTop
    cardBelow()
    setAsks([ASK])
    placeCard()
    frame()
    advance(600)
    expect(metrics.scrollTop).toBe(top)

    heightChanged(10_400)
    frame()
    expect(metrics.scrollTop).toBe(top)
    expect(virt.scrollToIndex).not.toHaveBeenCalled()
  })

  it('CS-4 卡片不在屏幕上：提示真的露着（aria-hidden=false、能 Tab 到、不透明），文字随种类', () => {
    scrolledUp()
    cardBelow()
    setAsks([ASK])
    frame()
    expect(pill()!.getAttribute('data-pending-jump')).toBe('ask')
    expect(pill()!.getAttribute('aria-hidden')).toBe('false')
    expect(pill()!.tabIndex).toBe(0)
    expect(pill()!.classList.contains('opacity-100')).toBe(true)
    expect(pill()!.textContent).toBe(zh.pendingInputs.jumpAsk)

    setAsks([CHOICE])
    frame()
    expect(pill()!.getAttribute('data-pending-jump')).toBe('choice')
    expect(pill()!.textContent).toBe(zh.pendingInputs.jumpChoice)
    expect(pillShown()).toBe(true)
  })

  it.each([
    ['近', 2, 'smooth'],
    ['远', 4, 'auto']
  ] as const)('CS-5 点提示（离底%s）：滚到真底', (_label, screens, behavior) => {
    scrolledUp()
    cardBelow()
    setAsks([ASK])
    frame()
    distFromBottom(metrics.clientHeight * screens)
    act(() => pill()!.click())
    expect(virt.scrollToIndex).toHaveBeenCalledWith({ index: 'LAST', align: 'end', behavior })
  })

  it('CS-6 询问没了：换回普通按钮（没有 data-pending-jump），在跑就是圆点', () => {
    scrolledUp()
    cardBelow()
    setAsks([ASK], true)
    frame()
    expect(pillShown()).toBe(true)

    setAsks([], true)
    expect(pill()).toBeNull()
    expect(button()).not.toBeNull()
    expect(shown()).toBe(true)
    expect(dots()).toBe(3)
  })

  it('CS-7 卡片露着：提示在 DOM 里但藏着（aria-hidden=true、不进 Tab 序、透明）', () => {
    settledAtBottom()
    setAsks([ASK])
    frame()
    advance(400)
    expect(pill()).not.toBeNull()
    expect(pill()!.getAttribute('aria-hidden')).toBe('true')
    expect(pill()!.tabIndex).toBe(-1)
    expect(pill()!.classList.contains('opacity-0')).toBe(true)
  })

  it('CS-7b 卡片露着时人翻走了又回来：提示跟着滚动事件重量', () => {
    settledAtBottom()
    setAsks([ASK])
    frame()
    advance(400)
    expect(pillShown()).toBe(false)

    distFromBottom(2_000)
    cardRect = { top: 2_500, bottom: 2_700 }
    atBottom(false)
    scrollEvent()
    expect(pillShown()).toBe(true)

    distFromBottom(0)
    cardRect = { top: 100, bottom: 300 }
    atBottom(true)
    scrollEvent()
    expect(pillShown()).toBe(false)
  })

  it('CS-7c 总高变化也重量：上面的内容把卡片顶到屏幕外，提示出来', () => {
    settledAtBottom()
    setAsks([ASK])
    frame()
    advance(400)
    expect(pillShown()).toBe(false)

    distFromBottom(1_000)
    cardBelow()
    heightChanged(metrics.scrollHeight)
    expect(pillShown()).toBe(true)
  })

  it('CS-7d 离底 150px、卡片一半压在输入卡片底下（Virtuoso 还算在底部）：提示露着，数字键不算数', () => {
    settledAtBottom()
    setAsks([ASK])
    frame()
    advance(400)

    composerH = 120
    distFromBottom(150)
    // 可见区下沿 = 500 - 120 = 380；卡片底 450
    cardRect = { top: 250, bottom: 450 }
    atBottom(true) // 160px 之内，Virtuoso 仍报在底部
    scrollEvent()

    expect(pillShown()).toBe(true)
    expect(pill()!.classList.contains('opacity-100')).toBe(true)
    expect(press('1')).toBe(true)
    expect(virt.picked).not.toHaveBeenCalled()

    // 滚回露全了：提示收起，数字键认
    distFromBottom(0)
    cardRect = { top: 100, bottom: 300 }
    scrollEvent()
    expect(pillShown()).toBe(false)
    expect(press('1')).toBe(false)
    expect(virt.picked).toHaveBeenCalledWith(0)
  })

  it('CS-7e 已经到列表真底、卡片比可见区还高（窗口很矮）：不提示（点了也没处可去），数字键仍不算数', () => {
    settledAtBottom()
    setAsks([ASK])
    frame()
    advance(400)

    distFromBottom(0)
    cardRect = { top: -100, bottom: 600 }
    scrollEvent()
    expect(pillShown()).toBe(false)
    expect(press('1')).toBe(true)
    expect(virt.picked).not.toHaveBeenCalled()

    // 离真底 3px 就不算到底了
    distFromBottom(3)
    scrollEvent()
    expect(pillShown()).toBe(true)
  })

  it('CS-8 又在跑又在等：提示优先，没有圆点', () => {
    scrolledUp()
    cardBelow()
    setAsks([ASK], true)
    frame()
    expect(pillShown()).toBe(true)
    expect(pill()!.querySelectorAll('span[aria-hidden] > span')).toHaveLength(0)
  })

  const stepTo = (id: string): void => {
    act(() => useChatStore.getState().setActiveInputId(S1, id))
    placeCard()
  }

  it('CS-9 步进到另一张（人在底部）：算露面，再贴一次', () => {
    settledAtBottom()
    setAsks([ASK, ASK2])
    frame()
    advance(400)

    metrics.scrollTop = END() - 100
    stepTo('r2')
    frame()
    expect(metrics.scrollTop).toBe(END())
  })

  it('CS-9b 在翻历史时步进到另一张：不动', () => {
    scrolledUp()
    cardBelow()
    setAsks([ASK, ASK2])
    frame()
    const top = metrics.scrollTop
    stepTo('r2')
    frame()
    advance(500)
    expect(metrics.scrollTop).toBe(top)
  })

  it('CS-10 前一张答完换下一张（在底部）：再露面一次', () => {
    settledAtBottom()
    setAsks([ASK, ASK2])
    frame()
    advance(400)

    metrics.scrollTop = END() - 100
    setAsks([ASK2])
    frame()
    expect(metrics.scrollTop).toBe(END())
  })

  it('CS-11 日历跳到中间、同时有询问挂着：不被拉回底部', () => {
    act(() =>
      applySessionView(S1, V(S1, { messages: history(S1), run: { state: 'idle' }, asks: [ASK] }))
    )
    act(() => useChatStore.getState().requestScrollToMessage(S1, `${S1}-u2`))
    distFromBottom(2_000)
    const top = metrics.scrollTop
    render(S1)
    placeCard()
    frame()
    expect(virt.mountProps[0].initialTopMostItemIndex).toEqual({ index: 2, align: 'start' })
    expect(metrics.scrollTop).toBe(top)
  })

  it('CS-12 跟随窗口里卸载：计时器清掉，之后什么都不发生', () => {
    settledAtBottom()
    setAsks([ASK])
    const before = vi.getTimerCount()
    expect(before).toBeGreaterThan(0)
    act(() => root.render(createElement('div')))
    expect(() => advance(1_000)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('CS-13 一条消息都没有、只有询问（派生 agent 的询问）：不是空态，列表挂着，卡片在 Footer', () => {
    act(() => applySessionView(S1, V(S1, { messages: [], run: { state: 'idle' }, asks: [ASK] })))
    render(S1)
    expect(emptyPresent()).toBe(false)
    expect(stubPresent()).toBe(true)
    expect(
      container.querySelector('[data-virtuoso-scroller] [data-pending-card="ask"]')
    ).not.toBeNull()
  })

  it.each(['wheel', 'touchstart', 'pointerdown', 'keydown'])(
    'CS-14 跟随窗口里人动了（%s）：松开，总高再变也不拉回去',
    (type) => {
      settledAtBottom()
      setAsks([ASK])
      frame()

      distFromBottom(100)
      const top = metrics.scrollTop
      act(() => {
        virt.scroller!.dispatchEvent(new Event(type))
      })
      advance(84)
      heightChanged(metrics.scrollHeight + 200)
      frame()
      expect(metrics.scrollTop).toBe(top)
    }
  )

  describe('输入卡片变高时（CS-16）', () => {
    const cardScroller = (): HTMLElement =>
      container.querySelector<HTMLElement>('[data-virtuoso-scroller]')!
    /** 输入卡片量到的高度（量位置在写新值之前，所以 --chat-input-h 给的是上一次的） */
    const composerIs = (height: number): void => {
      act(() => virt.onHeightChange!(height))
      composerH = height
    }
    const withCard = (): void => {
      settledAtBottom()
      setAsks([ASK])
      frame()
      composerIs(60)
      cardScroller().scrollTop = 400
    }

    it('CS-16 卡片整张露着、输入卡片长高：卡片那层滚动区上移同样的量，变量也写了', () => {
      withCard()
      composerIs(100)
      expect(cardScroller().scrollTop).toBe(440)
      const root = container
        .querySelector<HTMLElement>('[data-virtuoso-stub]')!
        .closest<HTMLElement>('[style*="--chat-input-h"]')!
      expect(root.style.getPropertyValue('--chat-input-h')).toBe('100px')
    })

    it('CS-16 量的是长高之前的位置：现在才被盖住也算露着', () => {
      withCard()
      cardRect = { top: 100, bottom: 430 } // 只在长高之前的 60px 下面放得下
      composerIs(100)
      expect(cardScroller().scrollTop).toBe(440)
    })

    it('CS-16 卡片没露全：不动', () => {
      withCard()
      cardRect = { top: 100, bottom: 470 }
      composerIs(100)
      expect(cardScroller().scrollTop).toBe(400)
    })

    it('CS-16 输入卡片变矮：不动', () => {
      withCard()
      composerIs(40)
      expect(cardScroller().scrollTop).toBe(400)
    })

    it('CS-16 高度没变：不动', () => {
      withCard()
      composerIs(60)
      expect(cardScroller().scrollTop).toBe(400)
    })

    it('CS-16 没有卡片：不动，也不抛', () => {
      settledAtBottom()
      composerIs(60)
      cardScroller().scrollTop = 400
      composerIs(100)
      expect(cardScroller().scrollTop).toBe(400)
    })
  })

  it('CS-15 卡片的回答经 Virtuoso 的 context 到 handleInputResponse，带着那条请求的 id', () => {
    settledAtBottom()
    setAsks([ASK])
    expect(virt.props!.context.onInputResponse).toBe(virt.handleInputResponse)
    virt.panelOnResponse!('r1', { kind: 'ask', allowed: true })
    expect(virt.handleInputResponse).toHaveBeenCalledWith('r1', { kind: 'ask', allowed: true })
  })
  it('CS-17 任务列表在 Footer 里：排在询问卡片之前；输入框里不再有它', () => {
    settledAtBottom()
    const withList: ChatMessage[] = [
      ...history(S1),
      user('u-plan', 'go', S1),
      assistant(
        'a-plan',
        [
          toolBlock(
            'p1',
            TASK_LIST_TOOL_NAME,
            { items: [{ content: 'Read the code', status: 'in_progress' }] },
            { result: 'Plan shown (1 step).' }
          )
        ],
        S1
      )
    ]
    act(() =>
      applySessionView(S1, V(S1, { messages: withList, run: { state: 'busy' }, asks: [ASK] }))
    )
    const list = container.querySelector('[data-task-list]')
    const card = container.querySelector('[data-pending-card]')
    expect(list).not.toBeNull()
    expect(card).not.toBeNull()
    expect(list!.getAttribute('data-task-list-placement')).toBe('conversation')
    expect(list!.closest('[data-virtuoso-scroller]')).not.toBeNull()
    expect(list!.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
