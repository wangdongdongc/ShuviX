/**
 * useSubAgentCount —— 当前主会话下「用户主动触发」的子会话数量（共享）。
 *
 * RightPanel 据此决定是否显示 Sub-agent tab（仅当 > 0）。数据来自共享 subSessionStore，
 * 桌面/扩展共用同一口径，避免各端各写计数逻辑。
 * Agent 经派发工具自行触发的子会话（有 parentToolCallId）内联在对话流中展示，不计入面板。
 */
import { useMemo } from 'react'
import { useSubSessionStore, selectSubSessionList } from '../stores/subSessionStore'

export function useSubAgentCount(parentSessionId: string | null): number {
  const all = useSubSessionStore(selectSubSessionList)
  return useMemo(
    () =>
      parentSessionId
        ? all.filter((s) => s.parentSessionId === parentSessionId && !s.parentToolCallId).length
        : 0,
    [all, parentSessionId]
  )
}
