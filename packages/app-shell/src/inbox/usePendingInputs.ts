/**
 * 各会话此刻挂着的询问本身（审批 / 选择题），收件箱「等你回答」那一节在行内展开卡片用。
 *
 * 主进程不推这份表，只推 `ask_count`（哪条会话挂着几条）—— 计数一变就重取一份：答掉一条、来了一条、会话被中止，
 * 都会动计数。`session.listChanged`（web 客户端重连后补发）时也取一次。乱序回包按序号丢掉。宿主没有这个接口
 * （Chrome 侧栏）→ `null`，收件箱只列会话、点一行打开它。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getChatApi, selectAllPendingCounts, useAppEvent, useChatStore } from '@shuvix/chat-ui'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'

export function usePendingInputs(enabled: boolean): Record<string, InputRequest[]> | null {
  const counts = useChatStore(selectAllPendingCounts)
  const [data, setData] = useState<Record<string, InputRequest[]> | null>(null)
  const seq = useRef(0)

  const refetch = useCallback(() => {
    if (!enabled) return
    const request = getChatApi().agent.pendingInputs?.()
    if (!request) return
    const id = ++seq.current
    void request
      .then((result) => {
        if (id === seq.current) setData(result)
      })
      .catch(() => {
        /* 保持上一份，等下一次计数变化 */
      })
  }, [enabled])

  // counts 只用来触发重取：哪条会话的询问数变了，询问本身就可能变了
  useEffect(refetch, [refetch, counts])
  useAppEvent('session.listChanged', refetch)

  return enabled ? data : null
}
