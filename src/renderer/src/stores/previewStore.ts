import { create } from 'zustand'
import { persistPanelLayout } from './panelLayout'

/** resize handle 宽度（PreviewResizeHandle 的 w-px = 1px） */
const HANDLE_WIDTH = 1

/** 调整窗口宽度（仅 Electron 环境生效），返回 Promise */
function adjustWindowWidth(delta: number): Promise<void> {
  if (window.api?.app?.platform !== 'web' && window.api?.app?.adjustWindowWidth) {
    return window.api.app.adjustWindowWidth(delta)
  }
  return Promise.resolve()
}

/** 通知主进程预览面板占用的额外宽度（关闭窗口时扣除） */
function syncPreviewOffset(offset: number): void {
  if (window.api?.app?.platform !== 'web' && window.api?.app?.setPreviewOffset) {
    window.api.app.setPreviewOffset(offset)
  }
}

/** ChatView 容器的 data 属性，用于 DOM 测量 */
export const CHAT_CONTAINER_ATTR = 'data-chat-container'

/** 预览模式：url = 外部网页预览，design = 本地设计项目预览 */
export type PreviewMode = 'url' | 'design'

const PREVIEW_MIN = 320
const PREVIEW_MAX = 960

interface PreviewState {
  /** 面板是否展开 */
  isOpen: boolean
  /** 当前预览 URL */
  url: string
  /** 面板宽度（px） */
  width: number
  /** ChatView 锁定宽度（仅在开关瞬间短暂锁定，窗口 resize 完成后自动解锁） */
  lockedChatWidth: number | null
  /** 预览模式 */
  mode: PreviewMode
  /** 设计预览 dev server URL */
  designUrl: string | null
  /** dev server 正在启动中 */
  isStartingServer: boolean
  /** dev server 已运行 */
  isServerRunning: boolean

  toggle: () => void
  open: (url?: string) => void
  close: () => void
  setUrl: (url: string) => void
  setWidth: (width: number) => void
  /** 打开设计预览模式 */
  openDesign: (designUrl: string) => void
  /** 切换回 URL 模式 */
  switchToUrl: () => void
  /** 手动启动 design dev server */
  startDesignServer: (sessionId: string, workingDir: string) => Promise<void>
  /** 手动停止 design dev server */
  stopDesignServer: (sessionId: string) => Promise<void>
  /** 设置 server 运行状态（供外部事件同步） */
  setServerRunning: (running: boolean) => void
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

/** 等待窗口动画完成后解锁 ChatView 宽度 */
function unlockAfterAnimate(p: Promise<void>): void {
  const isMac = window.api?.app?.platform === 'darwin'
  p.then(() => {
    if (isMac) {
      setTimeout(() => {
        requestAnimationFrame(() => usePreviewStore.setState({ lockedChatWidth: null }))
      }, MACOS_ANIMATE_DURATION)
    } else {
      requestAnimationFrame(() => usePreviewStore.setState({ lockedChatWidth: null }))
    }
  })
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  isOpen: false,
  url: 'about:blank',
  width: 480,
  lockedChatWidth: null,
  mode: 'url' as PreviewMode,
  designUrl: null,
  isStartingServer: false,
  isServerRunning: false,

  toggle: () => {
    const { isOpen, width } = get()
    if (isOpen) {
      const chatWidth = measureChatWidth()
      set({ isOpen: false, lockedChatWidth: chatWidth })
      syncPreviewOffset(0)
      persistPanelLayout({ previewOpen: false })
      unlockAfterAnimate(adjustWindowWidth(-totalOffset(width)))
    } else {
      const chatWidth = measureChatWidth()
      set({ isOpen: true, lockedChatWidth: chatWidth })
      syncPreviewOffset(totalOffset(width))
      persistPanelLayout({ previewOpen: true })
      unlockAfterAnimate(adjustWindowWidth(totalOffset(width)))
    }
  },
  open: (url) => {
    const { isOpen, width } = get()
    if (!isOpen) {
      const chatWidth = measureChatWidth()
      set({ isOpen: true, lockedChatWidth: chatWidth, ...(url ? { url } : {}) })
      syncPreviewOffset(totalOffset(width))
      persistPanelLayout({ previewOpen: true })
      unlockAfterAnimate(adjustWindowWidth(totalOffset(width)))
    } else if (url) {
      set({ url })
    }
  },
  close: () => {
    const { isOpen, width } = get()
    if (!isOpen) return
    const chatWidth = measureChatWidth()
    set({ isOpen: false, lockedChatWidth: chatWidth, isServerRunning: false })
    syncPreviewOffset(0)
    persistPanelLayout({ previewOpen: false })
    unlockAfterAnimate(adjustWindowWidth(-totalOffset(width)))
  },
  setUrl: (url) => set({ url }),
  setWidth: (width) => {
    const clamped = Math.max(PREVIEW_MIN, Math.min(PREVIEW_MAX, width))
    set({ width: clamped })
    persistPanelLayout({ previewWidth: clamped })
  },

  openDesign: (designUrl) => {
    const { isOpen, width } = get()
    if (!isOpen) {
      const chatWidth = measureChatWidth()
      set({ isOpen: true, lockedChatWidth: chatWidth, mode: 'design', designUrl })
      syncPreviewOffset(totalOffset(width))
      persistPanelLayout({ previewOpen: true })
      unlockAfterAnimate(adjustWindowWidth(totalOffset(width)))
    } else {
      set({ mode: 'design', designUrl })
    }
  },
  switchToUrl: () => {
    set({ mode: 'url' })
  },

  setServerRunning: (running) => set({ isServerRunning: running }),

  startDesignServer: async (sessionId, workingDir) => {
    set({ isStartingServer: true })
    try {
      // 确保脚手架已初始化
      await window.api.design.init({ sessionId, workingDir })
      // 启动 dev server
      const info = await window.api.design.startDev({ sessionId, workingDir })
      // WebUI 模式下通过反向代理访问
      let designUrl = info.url
      if (window.api?.app?.platform === 'web') {
        designUrl = `${window.location.origin}/shuvix/design/${sessionId}/`
      }
      get().openDesign(designUrl)
      set({ isServerRunning: true, isStartingServer: false })
    } catch {
      set({ isStartingServer: false })
    }
  },

  stopDesignServer: async (sessionId) => {
    try {
      await window.api.design.stopDev({ sessionId })
    } catch {
      /* ignore */
    }
    set({ isServerRunning: false })
    get().switchToUrl()
  }
}))
