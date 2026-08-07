import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/**
 * 输入法（IME）组字守卫。
 *
 * 中文 / 日文 / 韩文等输入法在候选词阶段按 Enter 是「确认选词」，但浏览器仍会派发
 * keydown。若不加区分，这个回车会被当成「发送」，把尚未成形的文本直接发出去；同理
 * 组字期间的方向键（候选翻页）也会被 @ 引用 / 斜杠命令弹层的导航劫持。
 * 组字期间的按键一律交还输入法处理。
 *
 * `isComposing` 是 W3C 标准属性；`keyCode === 229` 是旧内核组字期间的历史约定，
 * 作为兜底一并检测。
 */
export function isImeComposing(e: ReactKeyboardEvent | KeyboardEvent): boolean {
  const native = 'nativeEvent' in e ? e.nativeEvent : e
  return native.isComposing || native.keyCode === 229
}
