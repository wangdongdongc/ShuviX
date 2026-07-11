/**
 * 扩展外观状态 —— chrome.storage.local 持久化 + 主题应用（document data-theme）。
 * 供共享 AppearanceTab 绑定，并为 ChatHost.appearance 提供值。
 */
import { useSyncExternalStore } from 'react'

export type ThemeMode = 'dark' | 'light' | 'system'

export interface AppearanceState {
  theme: ThemeMode
  darkTheme: string
  lightTheme: string
  fontSize: number
  focusMode: boolean
}

const DEFAULT: AppearanceState = {
  theme: 'system',
  darkTheme: 'github-dark',
  lightTheme: 'github-light',
  fontSize: 14,
  focusMode: false
}

const KEY = 'appearance'
let state: AppearanceState = { ...DEFAULT }
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

/** 根据 theme 模式解析出实际主题 id（system 跟随系统） */
function resolveThemeId(s: AppearanceState): string {
  if (s.theme === 'system') {
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
    return dark ? s.darkTheme : s.lightTheme
  }
  return s.theme === 'dark' ? s.darkTheme : s.lightTheme
}

/** 应用主题 + 字号到 document。
 *  - 字号走 CSS 变量 --app-font-size（与桌面一致，仅消息正文用），
 *    绝不改 root font-size——否则会缩放全部 rem 基准的 Tailwind 工具类。
 *  - 不再施加基础 CSS zoom：桌面已移除 1.1 基础倍率（100% → zoomFactor 1.0），
 *    扩展对齐为无缩放，整体渲染与浏览器标签页默认 1.0 一致。 */
export function applyAppearance(s: AppearanceState = state): void {
  document.documentElement.setAttribute('data-theme', resolveThemeId(s))
  document.documentElement.style.setProperty('--app-font-size', `${s.fontSize}px`)
}

/** 从 chrome.storage 载入并应用；监听 system 主题变化 */
export async function initAppearance(): Promise<void> {
  try {
    const obj = await chrome.storage.local.get(KEY)
    if (obj[KEY]) state = { ...DEFAULT, ...(obj[KEY] as Partial<AppearanceState>) }
  } catch {
    /* 用默认 */
  }
  applyAppearance()
  emit()
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'system') applyAppearance()
  })
}

export function setAppearance(patch: Partial<AppearanceState>): void {
  state = { ...state, ...patch }
  applyAppearance()
  emit()
  void chrome.storage.local.set({ [KEY]: state }).catch(() => {})
}

export function useAppearance(): AppearanceState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state
  )
}
