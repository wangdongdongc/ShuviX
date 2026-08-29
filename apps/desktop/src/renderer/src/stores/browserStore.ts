import { create } from 'zustand'
import { usePanelStore } from '@shuvix/app-shell'
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

/** 右侧面板激活的标签页（终端在底部栏，见 bottomPanelStore；Files/Sub-agent 在聊天区内的会话面板，见 sessionPanelStore） */
export type PanelTab = 'browser' | 'preview' | 'widget' | 'calendar'

const BROWSER_MIN = 320
const BROWSER_MAX = 960

/** 浏览器 tab 的镜像信息（真源在主进程 browserViewService，经 useBrowserTabsBridge 事件同步） */
export interface BrowserTabInfo {
  id: string
  url: string
  title: string
  favicon?: string
  isLoading: boolean
  loadError: { errorCode: number; errorDescription: string; url: string } | null
}

/**
 * 桌面右侧面板 store —— 现为共享 usePanelStore（@shuvix/app-shell）之上的「浏览器面板 + 原生窗口」外层。
 *
 * 通用三态 isOpen/activeTab/width 的**真源在 usePanelStore**；这里把它们「镜像」过来（底部单向订阅），
 * 使桌面既有消费点继续用 useBrowserStore 不变。本 store 自有的是浏览器面板专属态（tabs/lockedChatWidth）
 * 与「开/关面板要联动原生窗口宽度 + WebContentsView 偏移」的命令式 actions（这些副作用桌面专属、无法搬进共享 store）。
 *
 * 浏览器 tab 状态同样是镜像：actions 只发 IPC，主进程 `browser-view:tab-*` 事件回填
 * tabs/activeTabId（见 host/useBrowserTabsBridge.ts），单一数据流。
 */
interface BrowserState {
  /** 面板是否展开（镜像自 usePanelStore） */
  isOpen: boolean
  /** 浏览器 tab 列表（镜像自主进程，顺序 = tab 条顺序） */
  tabs: BrowserTabInfo[]
  /** 当前激活的浏览器 tab id（镜像自主进程） */
  activeTabId: string | null
  /** 面板宽度（px，镜像自 usePanelStore） */
  width: number
  /** ChatView 锁定宽度（仅在开关瞬间短暂锁定，窗口 resize 完成后自动解锁；桌面专属） */
  lockedChatWidth: number | null
  /** 右侧面板当前激活的标签页（镜像自 usePanelStore） */
  activeTab: PanelTab

  toggle: () => void
  open: () => void
  close: () => void
  setWidth: (width: number) => void
  /** 切换右侧面板标签页 */
  setActiveTab: (tab: PanelTab) => void

  createTab: (url?: string) => void
  closeTab: (id: string) => void
  activateTab: (id: string) => void
  navigateTab: (id: string, url: string) => void
  /** 统一入口：面板未开则打开；有激活 tab 则导航之，无 tab 则新建 */
  openAndNavigate: (url: string) => void
}

/** 多 tab WebContentsView 仅 Electron 主窗口存在（web 平台无此 API） */
function browserViewApi(): (typeof window.api)['browserView'] | undefined {
  return window.api?.browserView
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

const panel = (): ReturnType<typeof usePanelStore.getState> => usePanelStore.getState()

export const useBrowserStore = create<BrowserState>((set, get) => ({
  // 通用三态初值镜像自共享 store（之后由底部订阅保持同步）
  isOpen: panel().isOpen,
  tabs: [],
  activeTabId: null,
  width: panel().width,
  lockedChatWidth: null,
  activeTab: panel().activeTab as PanelTab,

  toggle: () => {
    const { isOpen, width } = panel()
    if (isOpen) {
      const chatWidth = measureChatWidth() // 改宽前测量（此刻面板尚开、chat 为当前宽度）
      // isOpen + lockedChatWidth 必须原子提交（同一次 set），否则「面板占位」与「锁定 chat 宽度」
      // 会落在两个 render 之间，出现一帧 ChatView 伸缩。panel().setOpen 只为回写共享 store，
      // 其镜像订阅把同值写回本 store → 对已定的 isOpen 无额外 re-render（幂等）。
      set({ isOpen: false, lockedChatWidth: chatWidth })
      panel().setOpen(false)
      syncBrowserOffset(0)
      persistPanelLayout({ browserOpen: false })
      unlockAfterAnimate(adjustWindowWidth(-totalOffset(width)))
    } else {
      const chatWidth = measureChatWidth() // 改宽前测量（此刻面板尚关、chat 为满宽）
      set({ isOpen: true, lockedChatWidth: chatWidth })
      panel().setOpen(true)
      syncBrowserOffset(totalOffset(width))
      persistPanelLayout({ browserOpen: true })
      unlockAfterAnimate(adjustWindowWidth(totalOffset(width)))
    }
  },
  open: () => {
    const { isOpen, width } = panel()
    if (isOpen) return
    const chatWidth = measureChatWidth()
    set({ isOpen: true, lockedChatWidth: chatWidth })
    panel().setOpen(true)
    syncBrowserOffset(totalOffset(width))
    persistPanelLayout({ browserOpen: true })
    unlockAfterAnimate(adjustWindowWidth(totalOffset(width)))
  },
  close: () => {
    const { isOpen, width } = panel()
    if (!isOpen) return
    const chatWidth = measureChatWidth()
    set({ isOpen: false, lockedChatWidth: chatWidth })
    panel().setOpen(false)
    syncBrowserOffset(0)
    persistPanelLayout({ browserOpen: false })
    unlockAfterAnimate(adjustWindowWidth(-totalOffset(width)))
  },
  setWidth: (width) => {
    const clamped = Math.max(BROWSER_MIN, Math.min(BROWSER_MAX, width))
    // 拖拽期间强制解锁 chatWidth：lockedChatWidth 会让 chat 容器固定宽度、
    // flexShrink: 0，导致向左拖时 chat 无法收缩、浏览器面板溢出窗口。
    // 用户主动拖拽意味着窗口动画已不重要，立即解锁让 flex 布局生效。
    if (get().lockedChatWidth != null) set({ lockedChatWidth: null })
    panel().setWidth(clamped)
    persistPanelLayout({ browserWidth: clamped })
    // 同步更新窗口最小宽度，防止用户拖拽面板变窄后窗口仍被锁定在旧的最小宽度
    if (panel().isOpen) {
      debouncedSyncBrowserOffset(totalOffset(clamped))
    }
  },

  setActiveTab: (tab) => panel().setActiveTab(tab),

  // ====== 浏览器 tab actions（薄封装 IPC；状态由主进程事件经 useBrowserTabsBridge 回填） ======

  createTab: (url) => {
    void browserViewApi()?.createTab(url)
  },
  closeTab: (id) => {
    void browserViewApi()?.closeTab(id)
  },
  activateTab: (id) => {
    void browserViewApi()?.activateTab(id)
  },
  navigateTab: (id, url) => {
    void browserViewApi()?.navigate(id, url)
  },
  openAndNavigate: (url) => {
    get().open()
    const api = browserViewApi()
    if (!api) return
    const { activeTabId } = get()
    if (activeTabId) void api.navigate(activeTabId, url)
    else void api.createTab(url)
  }
}))

// 单向镜像：共享 store 的通用三态 → 本 store（使既有 useBrowserStore 消费点零改动）。
// 真源是 usePanelStore；本 store 的 actions 只写 usePanelStore，由此订阅回填，无回环。
usePanelStore.subscribe((s) =>
  useBrowserStore.setState({ isOpen: s.isOpen, width: s.width, activeTab: s.activeTab as PanelTab })
)
