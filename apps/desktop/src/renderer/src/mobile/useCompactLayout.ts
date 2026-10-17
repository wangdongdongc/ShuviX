/**
 * 要不要用手机布局（MobileShell）：只看浏览器里的 web 客户端 —— 桌面应用的窗口永远是桌面布局，手机布局的
 * 任何东西都碰不到它。窄于 640px（手机竖屏，或缩得很窄的浏览器窗口），或者是触屏且矮于 500px（手机横屏）。
 * 转屏 / 拉宽窗口时跟着切。
 */
import { useSyncExternalStore } from 'react'
import { isWebHost } from '../host/hostMedia'

export const COMPACT_LAYOUT_QUERY =
  '(max-width: 639.98px), (pointer: coarse) and (max-height: 500px)'

function subscribe(onChange: () => void): () => void {
  if (!isWebHost || typeof window.matchMedia !== 'function') return () => undefined
  const query = window.matchMedia(COMPACT_LAYOUT_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function snapshot(): boolean {
  return isWebHost && typeof window.matchMedia === 'function'
    ? window.matchMedia(COMPACT_LAYOUT_QUERY).matches
    : false
}

export function useCompactLayout(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}
