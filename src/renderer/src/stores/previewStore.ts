import { create } from 'zustand'

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

interface PreviewState {
  /** 面板是否展开 */
  isOpen: boolean
  /** 当前预览 URL */
  url: string
  /** 面板宽度（px） */
  width: number
  /** ChatView 锁定宽度（仅在开关瞬间短暂锁定，窗口 resize 完成后自动解锁） */
  lockedChatWidth: number | null

  toggle: () => void
  open: (url?: string) => void
  close: () => void
  setUrl: (url: string) => void
  setWidth: (width: number) => void
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

/** 窗口 resize 完成后解锁 ChatView 回 flex-1 */
function unlockAfterResize(p: Promise<void>): void {
  p.then(() => {
    requestAnimationFrame(() => usePreviewStore.setState({ lockedChatWidth: null }))
  })
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  isOpen: false,
  url: 'about:blank',
  width: 480,
  lockedChatWidth: null,

  toggle: () => {
    const { isOpen, width } = get()
    if (isOpen) {
      set({ isOpen: false })
      syncPreviewOffset(0)
      unlockAfterResize(adjustWindowWidth(-totalOffset(width)))
    } else {
      const chatWidth = measureChatWidth()
      set({ isOpen: true, lockedChatWidth: chatWidth })
      syncPreviewOffset(totalOffset(width))
      unlockAfterResize(adjustWindowWidth(totalOffset(width)))
    }
  },
  open: (url) => {
    const { isOpen, width } = get()
    if (!isOpen) {
      const chatWidth = measureChatWidth()
      set({ isOpen: true, lockedChatWidth: chatWidth, ...(url ? { url } : {}) })
      syncPreviewOffset(totalOffset(width))
      unlockAfterResize(adjustWindowWidth(totalOffset(width)))
    } else if (url) {
      set({ url })
    }
  },
  close: () => {
    const { isOpen, width } = get()
    if (!isOpen) return
    set({ isOpen: false })
    syncPreviewOffset(0)
    unlockAfterResize(adjustWindowWidth(-totalOffset(width)))
  },
  setUrl: (url) => set({ url }),
  setWidth: (width) => set({ width: Math.max(320, Math.min(960, width)) })
}))
