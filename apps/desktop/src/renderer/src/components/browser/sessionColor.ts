import { sessionColorFor, type ChromeGroupColor } from '@shuvix/chat-protocol/chromeBridge'

/**
 * 「这页正被哪个会话使用」圆点的颜色：会话 id → Chrome 标签组的那 9 种颜色之一（与用户 Chrome 里那条会话
 * 的标签组同色），取 Chrome 自己的浅色 / 深色两档色值。light-dark() 跟随主题声明的 color-scheme。
 */
const CSS_COLORS: Record<ChromeGroupColor, string> = {
  grey: 'light-dark(#5f6368, #bdc1c6)',
  blue: 'light-dark(#1a73e8, #8ab4f8)',
  red: 'light-dark(#d93025, #f28b82)',
  yellow: 'light-dark(#f9ab00, #fdd663)',
  green: 'light-dark(#1e8e3e, #81c995)',
  pink: 'light-dark(#d01884, #ff8bcb)',
  purple: 'light-dark(#a142f4, #d7aefb)',
  cyan: 'light-dark(#007b83, #78d9ec)',
  orange: 'light-dark(#fa903e, #fcad70)'
}

export function sessionDotColor(sessionId: string): string {
  return CSS_COLORS[sessionColorFor(sessionId)]
}

/** 开了请求拦截时圆点换成的琥珀色（页面内容可能被 agent 改写） */
export const INTERCEPTING_DOT_COLOR = 'light-dark(#d97706, #fbbf24)'
