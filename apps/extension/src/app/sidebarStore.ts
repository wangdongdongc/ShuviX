/**
 * 扩展侧栏布局状态 —— chrome.storage.local 持久化（宽度 + 展开）。
 *
 * 与桌面 sidebarStore 对应：宽度供共享 SidebarResizeHandle 拖拽，展开供 ChatHeader 折叠按钮。
 * Side Panel 较窄，折叠会话列表可把对话区让到满宽。
 */
import { useSyncExternalStore } from 'react'

export const SIDEBAR_MIN_WIDTH = 160
export const SIDEBAR_MAX_WIDTH = 360
const DEFAULT_WIDTH = 220

export interface SidebarState {
  isOpen: boolean
  width: number
}

const DEFAULT: SidebarState = { isOpen: true, width: DEFAULT_WIDTH }

const KEY = 'sidebarLayout'
let state: SidebarState = { ...DEFAULT }
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function persist(): void {
  void chrome.storage.local.set({ [KEY]: state }).catch(() => {})
}

/** 从 chrome.storage 载入（在首屏渲染前调用，让同步读取生效） */
export async function initSidebar(): Promise<void> {
  try {
    const obj = await chrome.storage.local.get(KEY)
    if (obj[KEY]) state = { ...DEFAULT, ...(obj[KEY] as Partial<SidebarState>) }
  } catch {
    /* 用默认 */
  }
  emit()
}

export function toggleSidebar(): void {
  state = { ...state, isOpen: !state.isOpen }
  emit()
  persist()
}

export function setSidebarWidth(width: number): void {
  const clamped = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width))
  state = { ...state, width: clamped }
  emit()
  persist()
}

export function useSidebar(): SidebarState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state
  )
}
