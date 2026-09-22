/**
 * 侧边栏外观 —— 跟着桌面走（主题、字号、专注模式、语言都取自桌面设置，经桥 `panel.appearance`）。
 * 桌面的设置一改（`settings.changed`）就重取。
 */
import type { ChromePanelAppearance } from '@shuvix/chat-protocol/chromeBridge'

export const DEFAULT_APPEARANCE: ChromePanelAppearance = {
  theme: 'system',
  darkTheme: 'github-dark',
  lightTheme: 'github-light',
  fontSize: 14,
  focusMode: true,
  language: navigator.language
}

function resolveThemeId(a: ChromePanelAppearance): string {
  if (a.theme === 'system') {
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
    return dark ? a.darkTheme : a.lightTheme
  }
  return a.theme === 'dark' ? a.darkTheme : a.lightTheme
}

/** 主题 + 字号落到 document（字号走 --app-font-size，只作用于消息正文，与桌面一致） */
export function applyAppearance(a: ChromePanelAppearance): void {
  document.documentElement.setAttribute('data-theme', resolveThemeId(a))
  document.documentElement.style.setProperty('--app-font-size', `${a.fontSize}px`)
}
