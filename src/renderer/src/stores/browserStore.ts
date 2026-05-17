import { create } from 'zustand'
import { persistPanelLayout } from './panelLayout'

/** resize handle 宽度（BrowserResizeHandle 的 w-px = 1px） */
const HANDLE_WIDTH = 1

/** 调整窗口宽度（仅 Electron 环境生效），返回 Promise */
function adjustWindowWidth(delta: number): Promise<void> {
  if (window.api?.app?.platform !== 'web' && window.api?.app?.adjustWindowWidth) {
    return window.api.app.adjustWindowWidth(delta)
  }
  return Promise.resolve()
}

/** 通知主进程浏览器面板占用的额外宽度（关闭窗口时扣除） */
function syncBrowserOffset(offset: number): void {
  if (window.api?.app?.platform !== 'web' && window.api?.app?.setBrowserOffset) {
    window.api.app.setBrowserOffset(offset)
  }
}

/** ChatView 容器的 data 属性，用于 DOM 测量 */
export const CHAT_CONTAINER_ATTR = 'data-chat-container'

/** 右侧面板激活的标签页 */
export type PanelTab = 'browser' | 'terminal' | 'files' | 'widget' | 'subagent'

const BROWSER_MIN = 320
const BROWSER_MAX = 960

interface BrowserState {
  /** 面板是否展开 */
  isOpen: boolean
  /** 当前浏览 URL */
  url: string
  /** 面板宽度（px） */
  width: number
  /** ChatView 锁定宽度（仅在开关瞬间短暂锁定，窗口 resize 完成后自动解锁） */
  lockedChatWidth: number | null
  /** 右侧面板当前激活的标签页 */
  activeTab: PanelTab

  toggle: () => void
  open: (url?: string) => void
  close: () => void
  setUrl: (url: string) => void
  setWidth: (width: number) => void
  /** 切换右侧面板标签页 */
  setActiveTab: (tab: PanelTab) => void
}

/** 测量 ChatView 容器当前宽度 */
function measureChatWidth(): number | null {
  const el = document.querySelector(`[${CHAT_CONTAINER_ATTR}]`)
  return el ? el.getBoundingClientRect().width : null
}

/** 计算面板 + resize handle 的总占用宽度 */
function totalOffset(panelWidth: number): number {
  return panelWidth + HANDLE_WIDTH
}

/** macOS setBounds 动画时长（ms），留少许余量 */
const MACOS_ANIMATE_DURATION = 320

/** 防抖更新窗口最小宽度（拖拽面板时避免高频 IPC） */
let syncOffsetTimer: ReturnType<typeof setTimeout> | null = null
function debouncedSyncBrowserOffset(offset: number): void {
  if (syncOffsetTimer) clearTimeout(syncOffsetTimer)
  syncOffsetTimer = setTimeout(() => {
    syncBrowserOffset(offset)
    syncOffsetTimer = null
  }, 150)
}

/** 等待窗口动画完成后解锁 ChatView 宽度 */
function unlockAfterAnimate(p: Promise<void>): void {
  const isMac = window.api?.app?.platform === 'darwin'
  const doUnlock = (): void => {
    if (isMac) {
      setTimeout(() => {
        requestAnimationFrame(() => useBrowserStore.setState({ lockedChatWidth: null }))
      }, MACOS_ANIMATE_DURATION)
    } else {
      requestAnimationFrame(() => useBrowserStore.setState({ lockedChatWidth: null }))
    }
  }
  // 无论 adjustWindowWidth 成功或失败都必须解锁，否则 lockedChatWidth 会永远卡住
  p.then(doUnlock, doUnlock)
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  isOpen: false,
  url: 'about:blank',
  width: 480,
  lockedChatWidth: null,
  activeTab: 'browser' as PanelTab,

  toggle: () => {
    const { isOpen, width } = get()
    if (isOpen) {
      const chatWidth = measureChatWidth()
      set({ isOpen: false, lockedChatWidth: chatWidth })
      syncBrowserOffset(0)
      persistPanelLayout({ browserOpen: false })
      unlockAfterAnimate(adjustWindowWidth(-totalOffset(width)))
    } else {
      const chatWidth = measureChatWidth()
      set({ isOpen: true, lockedChatWidth: chatWidth })
      syncBrowserOffset(totalOffset(width))
      persistPanelLayout({ browserOpen: true })
      unlockAfterAnimate(adjustWindowWidth(totalOffset(width)))
    }
  },
  open: (url) => {
    const { isOpen, width } = get()
    if (!isOpen) {
      const chatWidth = measureChatWidth()
      set({ isOpen: true, lockedChatWidth: chatWidth, ...(url ? { url } : {}) })
      syncBrowserOffset(totalOffset(width))
      persistPanelLayout({ browserOpen: true })
      unlockAfterAnimate(adjustWindowWidth(totalOffset(width)))
    } else if (url) {
      set({ url })
    }
  },
  close: () => {
    const { isOpen, width } = get()
    if (!isOpen) return
    const chatWidth = measureChatWidth()
    set({ isOpen: false, lockedChatWidth: chatWidth })
    syncBrowserOffset(0)
    persistPanelLayout({ browserOpen: false })
    unlockAfterAnimate(adjustWindowWidth(-totalOffset(width)))
  },
  setUrl: (url) => set({ url }),
  setWidth: (width) => {
    const clamped = Math.max(BROWSER_MIN, Math.min(BROWSER_MAX, width))
    // 拖拽期间强制解锁 chatWidth：lockedChatWidth 会让 chat 容器固定宽度、
    // flexShrink: 0，导致向左拖时 chat 无法收缩、浏览器面板溢出窗口。
    // 用户主动拖拽意味着窗口动画已不重要，立即解锁让 flex 布局生效。
    set(
      get().lockedChatWidth != null ? { width: clamped, lockedChatWidth: null } : { width: clamped }
    )
    persistPanelLayout({ browserWidth: clamped })
    // 同步更新窗口最小宽度，防止用户拖拽面板变窄后窗口仍被锁定在旧的最小宽度
    if (get().isOpen) {
      debouncedSyncBrowserOffset(totalOffset(clamped))
    }
  },

  setActiveTab: (tab) => set({ activeTab: tab })
}))
