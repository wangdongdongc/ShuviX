/**
 * useAppEvent —— 订阅通用内部事件（AppEvent）的前端 hook，仿 useAgentEvents。
 *
 * 经 getSessionChannelApi().events.subscribe 拿到全局事件流，按 type 过滤后回调。handler 用 ref 持有最新闭包，
 * 订阅只在 type 变化时重建，避免每次渲染重订阅。见 docs/internal-events.md。
 */
import { useEffect, useRef } from 'react'
import type { AppEventType, AppEventOf } from '@shuvix/chat-protocol/appEvents'
import { getSessionChannelApi } from '../api/chatApi'

export function useAppEvent<T extends AppEventType>(
  type: T,
  handler: (event: AppEventOf<T>) => void
): void {
  const handlerRef = useRef(handler)
  // 在 effect 中更新 ref（不在渲染期写 ref），订阅闭包始终调用最新 handler
  useEffect(() => {
    handlerRef.current = handler
  })

  useEffect(() => {
    return getSessionChannelApi().events.subscribe((event) => {
      if (event.type === type) handlerRef.current(event as AppEventOf<T>)
    })
  }, [type])
}
