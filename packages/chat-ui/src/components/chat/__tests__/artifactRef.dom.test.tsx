// @vitest-environment jsdom
/**
 * ```artifact 引用块按**它所在那条回复**取钉住的版本（jsdom）—— AssistantBubble / StepGroupView 把消息 id 交给
 * 引用块、引用块带着它去 `artifact.read`，再按回包在标题栏标出「已有新版」/「当前版本」，并跟着 `artifacts.changed` 重取。
 *
 *   CR-1 落定的终答：按卡的**最后一条**消息 id 读（一张卡两条消息时也是末条）
 *   CR-2 流式卡：不带 messageId（还没有条目 id），回包没钉也不标「当前版本」
 *   CR-3 一张卡三条消息：过程区里每段中间文本各按**自己那条**消息的 id 读，终答按末条
 *   CR-4 标记：pinned && !latest → `[data-artifact-newer]`「Newer version」，点它 → `artifactRevealRequest`
 *        `{ sessionId: 回包的 sessionId（产物所在会话）, name: 回包的真实文件名 }`，再点 nonce 加一；pinned && latest →
 *        不标；没钉、有 id →`[data-artifact-unpinned]`「Current version」；没有 id / 找不到 → 不标
 *   CR-5 中文界面：「已有新版」/「当前版本」
 *   CR-6 跟着 `artifacts.changed`：点到这场会话 → 重取，回包一样时 `.html` 的 iframe 还是同一个节点；没钉 → 钉了，
 *        标记跟着换；别的会话 → 不重取；产物所在的子会话 → 重取；不带 sessionIds → 重取；卸载时退订；
 *        面板用的 `ArtifactPreview`（不给 messageId、不 followChanges）从不订阅、不标记
 *
 * 宿主面经 `setChatApi` 注入：`artifact.read` 按用例回包，`events.subscribe` 记下监听者（退订也记下）。
 * 数据走真的 chatStore（`resetStore`、流式正文直接写 `sessionStreams`）；文件是 .tsx 但一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
import type { ArtifactRefContent } from '@shuvix/chat-protocol/artifacts'
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'
import type { AssistantMessage } from '@shuvix/chat-protocol/types/chatMessage'

vi.mock('../../../hooks/useTtsPlayback', () => ({
  useTtsPlayback: () => ({
    isPlaying: false,
    isLoading: false,
    playingMessageId: null,
    speak: () => {},
    stop: () => {}
  })
}))

import { setChatApi } from '../../../api/chatApi'
import { ChatHostProvider } from '../../../host/ChatHost'
import type { ChatHostValue } from '../../../host/chatHostContext'
import { useChatStore } from '../../../stores/chatStore'
import { emptyStream } from '../../../stores/viewDerivation'
import { AssistantBubble } from '../AssistantBubble'
import { ArtifactPreview } from '../CodeBlock'
import { streamingPlaceholder } from '../conversationItems'
import { MarkdownText } from '../markdownComponents'
import { assistant, resetStore, text, toolBlock } from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 's1'

// ── 宿主桩 ────────────────────────────────────────────────────────────────

type ReadParams = { sessionId: string; name: string; messageId?: string }

const read = vi.fn<(p: ReadParams) => Promise<ArtifactRefContent | null>>()
const listeners = new Set<(e: AppEvent) => void>()
const unsubscribed = vi.fn()

const API = {
  artifact: { read: (p: ReadParams) => read(p), list: async () => [] },
  events: {
    subscribe: (cb: (e: AppEvent) => void) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
        unsubscribed()
      }
    }
  }
} as unknown as ChatApi

const SVG = (label: string, rects = 1): string =>
  `<svg viewBox="0 0 4 4" aria-label="${label}">${'<rect width="1" height="1"/>'.repeat(rects)}</svg>`

/** 一份回包（缺省：本会话的 bar-chart.svg，钉了、是最新） */
const row = (over: Partial<ArtifactRefContent> = {}): ArtifactRefContent => ({
  sessionId: SID,
  name: 'bar-chart.svg',
  title: 'Bar chart',
  content: SVG('Bar chart'),
  pinned: true,
  latest: true,
  ...over
})

// ── 挂载 ──────────────────────────────────────────────────────────────────

const HOST: ChatHostValue = {
  appearance: { theme: 'light', darkTheme: 'd', lightTheme: 'l', fontSize: 14, focusMode: false },
  models: {
    activeProvider: '',
    activeModel: '',
    setActiveProvider: () => {},
    setActiveModel: () => {}
  },
  interactiveFigures: true
}
const HostProvider = ChatHostProvider as (props: {
  value: ChatHostValue
  children?: ReactNode
}) => React.JSX.Element

let container: HTMLDivElement
let root: Root

function show(node: ReactNode): void {
  act(() => {
    root.render(createElement(HostProvider, { value: HOST }, node))
  })
}

const bubble = (msgs: AssistantMessage[], isStreaming?: boolean): ReactNode =>
  createElement(AssistantBubble, { msgs, ...(isStreaming === undefined ? {} : { isStreaming }) })

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

async function emit(event: AppEvent): Promise<void> {
  act(() => {
    for (const cb of [...listeners]) cb(event)
  })
  await flush()
}

const fence = (name: string): string => `\`\`\`artifact\n${name}\n\`\`\``

/** 每次 read 的参数，按调用次序 */
const reads = (): ReadParams[] => read.mock.calls.map(([p]) => p)
const newerMark = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('[data-artifact-newer]')
const unpinnedMark = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-artifact-unpinned]')
const iframe = (): HTMLIFrameElement | null =>
  container.querySelector<HTMLIFrameElement>('[data-interactive-figure] iframe')

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en }, zh: { translation: zh } },
    showSupportNotice: false
  })
  setChatApi(API)
})

beforeEach(() => {
  resetStore(SID)
  useChatStore.setState({ artifactRevealRequest: null })
  read.mockReset()
  read.mockResolvedValue(row())
  listeners.clear()
  unsubscribed.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  if (i18n.language !== 'en') await i18n.changeLanguage('en')
})

describe('引用块带着回复的消息 id 去读', () => {
  it('CR-1 落定的终答按卡的末条消息 id 读', async () => {
    show(bubble([assistant('41', [text(`Here it is:\n\n${fence('bar-chart.svg')}`)])]))
    await flush()
    expect(reads()).toEqual([{ sessionId: SID, name: 'bar-chart.svg', messageId: '41' }])
    expect(container.querySelector('svg[aria-label="Bar chart"]')).not.toBeNull()

    // 一张卡两条消息：终答在末条
    act(() => root.unmount())
    root = createRoot(container)
    read.mockClear()
    show(
      bubble([
        assistant('50', [text('working'), toolBlock('t1', 'read', {}, { result: 'ok' })]),
        assistant('52', [text(fence('bar-chart.svg'))])
      ])
    )
    await flush()
    expect(reads()).toEqual([{ sessionId: SID, name: 'bar-chart.svg', messageId: '52' }])
  })

  it('CR-2 流式卡：不带 messageId，没钉也不标', async () => {
    read.mockResolvedValue(row({ pinned: false }))
    useChatStore.setState((s) => ({
      sessionStreams: {
        ...s.sessionStreams,
        [SID]: { ...emptyStream(true), content: `Drawing\n\n${fence('bar-chart.svg')}\n` }
      }
    }))
    show(bubble([streamingPlaceholder(SID)], true))
    await flush()
    expect(reads()).toEqual([{ sessionId: SID, name: 'bar-chart.svg' }])
    expect(reads()[0]).not.toHaveProperty('messageId')
    expect(container.querySelector('svg[aria-label="Bar chart"]')).not.toBeNull()
    expect(unpinnedMark()).toBeNull()
    expect(newerMark()).toBeNull()
  })

  it('CR-3 一张卡三条消息：过程区每段中间文本按自己那条消息的 id 读，终答按末条', async () => {
    read.mockImplementation(async (p) => row({ name: p.name, title: p.name }))
    show(
      bubble([
        assistant('11', [text(fence('a.svg')), toolBlock('t1', 'read', {}, { result: 'ok' })]),
        assistant('13', [text(fence('b.svg')), toolBlock('t2', 'edit', {}, { result: 'ok' })]),
        assistant('15', [text(`Done.\n\n${fence('c.svg')}`)])
      ])
    )
    await flush()
    const byName = Object.fromEntries(reads().map((p) => [p.name, p.messageId]))
    expect(byName).toEqual({ 'a.svg': '11', 'b.svg': '13', 'c.svg': '15' })
    expect(reads()).toHaveLength(3)
  })
})

describe('版本标记', () => {
  it('CR-4 已有新版 → 按钮，点它发揭示请求（产物所在会话 + 真实文件名）、再点 nonce 加一', async () => {
    // 围栏写的是标题；产物在子会话里
    read.mockResolvedValue(row({ sessionId: 'child-1', pinned: true, latest: false }))
    show(bubble([assistant('7', [text(fence('Bar chart'))])]))
    await flush()
    const button = newerMark()
    expect(button).not.toBeNull()
    expect(button!.tagName).toBe('BUTTON')
    expect(button!.textContent).toBe(en.message.artifactNewer)
    expect(button!.title).toBe(en.message.artifactNewerHint)
    expect(unpinnedMark()).toBeNull()

    click(button!)
    expect(useChatStore.getState().artifactRevealRequest).toEqual({
      sessionId: 'child-1',
      name: 'bar-chart.svg',
      nonce: 1
    })
    click(newerMark()!)
    expect(useChatStore.getState().artifactRevealRequest).toEqual({
      sessionId: 'child-1',
      name: 'bar-chart.svg',
      nonce: 2
    })
  })

  it('CR-4b 钉了且是最新 → 不标；没钉、有 id → 当前版本；没有 id / 找不到 → 不标', async () => {
    // 钉了、最新
    show(bubble([assistant('7', [text(fence('bar-chart.svg'))])]))
    await flush()
    expect(container.querySelector('svg[aria-label="Bar chart"]')).not.toBeNull()
    expect(newerMark()).toBeNull()
    expect(unpinnedMark()).toBeNull()

    // 没钉、有 id
    act(() => root.unmount())
    root = createRoot(container)
    read.mockResolvedValue(row({ pinned: false, latest: true }))
    show(bubble([assistant('8', [text(fence('bar-chart.svg'))])]))
    await flush()
    expect(unpinnedMark()?.textContent).toBe(en.message.artifactUnpinned)
    expect(unpinnedMark()?.title).toBe(en.message.artifactUnpinnedHint)
    expect(newerMark()).toBeNull()

    // 没有 id（不在某条回复里）：同样的回包，不标
    act(() => root.unmount())
    root = createRoot(container)
    read.mockResolvedValue(row({ pinned: true, latest: false }))
    show(createElement(MarkdownText, { text: fence('bar-chart.svg') }))
    await flush()
    expect(reads().at(-1)).toEqual({ sessionId: SID, name: 'bar-chart.svg' })
    expect(container.querySelector('svg[aria-label="Bar chart"]')).not.toBeNull()
    expect(newerMark()).toBeNull()
    expect(unpinnedMark()).toBeNull()

    // 找不到
    act(() => root.unmount())
    root = createRoot(container)
    read.mockResolvedValue(null)
    show(bubble([assistant('9', [text(fence('gone.svg'))])]))
    await flush()
    expect(container.textContent).toContain('gone.svg')
    expect(newerMark()).toBeNull()
    expect(unpinnedMark()).toBeNull()
  })

  it('CR-5 中文界面：已有新版 / 当前版本', async () => {
    await act(async () => {
      await i18n.changeLanguage('zh')
    })
    read.mockImplementation(async (p) =>
      p.name === 'old.svg'
        ? row({ name: 'old.svg', pinned: true, latest: false })
        : row({ name: 'new.svg', pinned: false })
    )
    show(bubble([assistant('3', [text(`${fence('old.svg')}\n\n${fence('new.svg')}`)])]))
    await flush()
    expect(newerMark()?.textContent).toBe('已有新版')
    expect(newerMark()?.textContent).toBe(zh.message.artifactNewer)
    expect(unpinnedMark()?.textContent).toBe('当前版本')
    expect(unpinnedMark()?.textContent).toBe(zh.message.artifactUnpinned)
  })
})

describe('跟着 artifacts.changed 重取', () => {
  it('CR-6 点到这场会话 → 重取；回包一样时 .html 的 iframe 不换；没钉 → 钉了，标记跟着换', async () => {
    const html = '<title>Growth</title><div id="chart">growth</div>'
    read.mockResolvedValue(
      row({ name: 'growth.html', title: 'Growth', content: html, pinned: false })
    )
    show(bubble([assistant('21', [text(fence('growth.html'))])]))
    await flush()
    expect(listeners.size).toBe(1)
    const frame = iframe()
    expect(frame).not.toBeNull()
    expect(unpinnedMark()).not.toBeNull()

    // 别的产物记了一版（回包一模一样）：重取，但沙箱不重载
    await emit({ type: 'artifacts.changed', sessionIds: [SID] })
    expect(read).toHaveBeenCalledTimes(2)
    expect(reads()[1]).toEqual({ sessionId: SID, name: 'growth.html', messageId: '21' })
    expect(iframe()).toBe(frame)
    expect(unpinnedMark()).not.toBeNull()

    // 回复落定后钉才写下：这一次回包变成钉住的那一版、之后又改过
    read.mockResolvedValue(
      row({ name: 'growth.html', title: 'Growth', content: html, pinned: true, latest: false })
    )
    await emit({ type: 'artifacts.changed', sessionIds: [SID] })
    expect(read).toHaveBeenCalledTimes(3)
    expect(unpinnedMark()).toBeNull()
    expect(newerMark()).not.toBeNull()
    expect(iframe()).toBe(frame)
  })

  it('CR-6b 别的会话 → 不重取；产物所在的子会话 → 重取；不带 sessionIds → 重取；卸载退订', async () => {
    read.mockResolvedValue(row({ sessionId: 'kid', pinned: true, latest: true }))
    show(bubble([assistant('5', [text(fence('bar-chart.svg'))])]))
    await flush()
    expect(read).toHaveBeenCalledTimes(1)

    await emit({ type: 'artifacts.changed', sessionIds: ['someone-else'] })
    expect(read).toHaveBeenCalledTimes(1)
    // 别的事件也不碰
    await emit({ type: 'trigger.logged' })
    expect(read).toHaveBeenCalledTimes(1)

    // 产物在子会话 kid 里：它记了新版，点的是 kid
    read.mockResolvedValue(row({ sessionId: 'kid', pinned: true, latest: false }))
    await emit({ type: 'artifacts.changed', sessionIds: ['kid'] })
    expect(read).toHaveBeenCalledTimes(2)
    expect(newerMark()).not.toBeNull()

    // 不知道是谁的（重连后的重拉信号）
    await emit({ type: 'artifacts.changed' })
    expect(read).toHaveBeenCalledTimes(3)

    expect(unsubscribed).not.toHaveBeenCalled()
    act(() => root.unmount())
    root = createRoot(container)
    expect(unsubscribed).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
  })

  it('CR-6c 面板的 ArtifactPreview：不给 messageId、从不订阅、不标记', async () => {
    read.mockResolvedValue(row({ pinned: true, latest: false }))
    show(createElement(ArtifactPreview, { sessionId: SID, name: 'bar-chart.svg' }))
    await flush()
    expect(reads()).toEqual([{ sessionId: SID, name: 'bar-chart.svg' }])
    expect(listeners.size).toBe(0)
    expect(container.querySelector('svg[aria-label="Bar chart"]')).not.toBeNull()
    expect(newerMark()).toBeNull()
    expect(unpinnedMark()).toBeNull()

    await emit({ type: 'artifacts.changed', sessionIds: [SID] })
    expect(read).toHaveBeenCalledTimes(1)
  })
})
