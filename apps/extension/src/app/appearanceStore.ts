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

/** 桌面在创建 BrowserWindow 时对 webContents 施加 setZoomFactor(uiZoom% * 1.1)，
 *  uiZoom 默认 100% → 实际渲染基础倍率 1.1（见 desktop main/index.ts）。
 *  浏览器标签页默认 1.0，故整体视觉比桌面小 ~10%。这里用 CSS zoom 对齐这个基础倍率。 */
const BASE_ZOOM = 1.1

/** 应用主题 + 字号 + 基础缩放到 document。
 *  - 字号走 CSS 变量 --app-font-size（与桌面一致，仅消息正文用），
 *    绝不改 root font-size——否则会缩放全部 rem 基准的 Tailwind 工具类。
 *  - 基础缩放走 root CSS zoom（等价桌面的 setZoomFactor 基础倍率 1.1），对齐桌面观感。 */
export function applyAppearance(s: AppearanceState = state): void {
  document.documentElement.setAttribute('data-theme', resolveThemeId(s))
  document.documentElement.style.setProperty('--app-font-size', `${s.fontSize}px`)
  document.documentElement.style.zoom = String(BASE_ZOOM)
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
