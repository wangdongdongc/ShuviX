import { useSyncExternalStore } from 'react'

/**
 * 当前主题 id（根元素上的 `data-theme`），变了就重渲。
 *
 * 需要它的是那些**颜色在渲染时就定死**的图：mermaid 要具体颜色值、交互图的 token 写进了
 * srcdoc —— CSS 变量切主题自己会变，它们不会，只能按主题 id 重来一遍。一页上所有订阅方
 * 共用一个 MutationObserver，最后一个退订时断开。
 */

const readThemeId = (): string => document.documentElement.getAttribute('data-theme') ?? ''
const readThemeIdOnServer = (): string => ''

const themeListeners = new Set<() => void>()
let themeObserver: MutationObserver | null = null

function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener)
  if (!themeObserver && typeof MutationObserver !== 'undefined') {
    themeObserver = new MutationObserver(() => themeListeners.forEach((l) => l()))
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
  }
  return () => {
    themeListeners.delete(listener)
    if (themeListeners.size === 0) {
      themeObserver?.disconnect()
      themeObserver = null
    }
  }
}

export const useThemeId = (): string =>
  useSyncExternalStore(subscribeTheme, readThemeId, readThemeIdOnServer)
