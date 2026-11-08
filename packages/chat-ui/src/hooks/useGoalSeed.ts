/**
 * useGoalSeed —— 目标模式（docs/goal-mode-design.md §9）的补种。
 *
 * 目标的变化是事件（`goal`）：窗口重建、web 客户端连上来之前发的都错过了。所以：
 *  - 打开一条会话时取一份它的目标（`agent.goal`），目标栏据此出现；
 *  - 挂载时取一份有目标的会话（`agent.goalStatuses`），侧栏的 ◎ 据此出现；
 *  - `session.listChanged` 时两份都再取一次 —— web 客户端重连后补发的信号事件里有它，断线期间结束 / 清掉的目标随之消失。
 *
 * 应答与事件走同一条有序的连接（同 useAskCountSeed），算出这份之后发的 `goal` 事件排在应答后面，不会被它盖掉。
 * 渠道端（Chrome 侧边栏）没有宿主 API，也就没有目标：什么都不做。取失败就保持现状，等下一个事件。
 */
import { useCallback, useEffect } from 'react'
import { getHostApi } from '../api/chatApi'
import { useChatStore } from '../stores/chatStore'
import { useAppEvent } from './useAppEvents'

export function useGoalSeed(sessionId: string | null): void {
  const refetchGoal = useCallback(() => {
    if (!sessionId) return
    // 可选链到方法：旧宿主 / 测试替身的 agent 上可能没有它
    const request = getHostApi()?.agent?.goal?.(sessionId)
    if (!request) return
    void request
      .then((goal) => useChatStore.getState().setSessionGoal(sessionId, goal))
      .catch(() => {
        /* 保持现状 */
      })
  }, [sessionId])

  const refetchStatuses = useCallback(() => {
    const request = getHostApi()?.agent?.goalStatuses?.()
    if (!request) return
    void request
      .then((statuses) => useChatStore.getState().setGoalStatuses(statuses))
      .catch(() => {
        /* 保持现状 */
      })
  }, [])

  useEffect(refetchGoal, [refetchGoal])
  useEffect(refetchStatuses, [refetchStatuses])
  useAppEvent('session.listChanged', () => {
    refetchGoal()
    refetchStatuses()
  })
}
