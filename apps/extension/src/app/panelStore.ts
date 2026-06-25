/**
 * 扩展右侧面板状态 —— chrome.storage.local 持久化（展开 / 宽度 / 当前 tab）。
 *
 * 对应桌面 browserStore 的子集：扩展只搬 files + subagent 两个 tab
 * （terminal 无 pty、browser 无 WebContentsView、widget 暂不搬）。
 */
import { useSyncExternalStore } from 'react'

export type PanelTab = 'files' | 'subagent'

export const PANEL_MIN_WIDTH = 220
export const PANEL_MAX_WIDTH = 520
const DEFAULT_WIDTH = 300

export interface PanelState {
  isOpen: boolean
  width: number
  activeTab: PanelTab
}

const DEFAULT: PanelState = { isOpen: false, width: DEFAULT_WIDTH, activeTab: 'files' }

const KEY = 'rightPanelLayout'
let state: PanelState = { ...DEFAULT }
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}
function persist(): void {
  void chrome.storage.local.set({ [KEY]: state }).catch(() => {})
}

/** 从 chrome.storage 载入（首屏渲染前调用） */
export async function initPanel(): Promise<void> {
  try {
    const obj = await chrome.storage.local.get(KEY)
    if (obj[KEY]) state = { ...DEFAULT, ...(obj[KEY] as Partial<PanelState>) }
  } catch {
    /* 用默认 */
  }
  emit()
}

export function togglePanel(): void {
  state = { ...state, isOpen: !state.isOpen }
  emit()
  persist()
}

/** 打开并切到指定 tab（已开且同 tab 则关闭，对齐桌面点按行为） */
export function openPanelTab(tab: PanelTab): void {
  state =
    state.isOpen && state.activeTab === tab
      ? { ...state, isOpen: false }
      : { ...state, isOpen: true, activeTab: tab }
  emit()
  persist()
}

export function setPanelTab(tab: PanelTab): void {
  state = { ...state, activeTab: tab }
  emit()
  persist()
}

export function setPanelWidth(width: number): void {
  const clamped = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, width))
  state = { ...state, width: clamped }
  emit()
  persist()
}

export function usePanel(): PanelState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state
  )
}
