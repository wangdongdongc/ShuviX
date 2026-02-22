import { useEffect, type RefObject } from 'react'

/**
 * 通用 hook：监听点击元素外部事件
 * @param ref 需要监听的 DOM 元素引用
 * @param onClickOutside 点击外部时的回调
 * @param enabled 是否启用监听（默认 true）
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onClickOutside: () => void,
  enabled = true
): void {
  useEffect(() => {
    if (!enabled) return
    const handler = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) {
        onClickOutside()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ref, onClickOutside, enabled])
}
