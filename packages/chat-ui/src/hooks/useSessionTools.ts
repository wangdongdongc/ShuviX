import { getHostApi, getSessionChannelApi } from '@shuvix/chat-ui'
import { useCallback } from 'react'
import type { AgentInitResult } from '@shuvix/chat-protocol/chatApi'
import { useChatStore } from '../stores/chatStore'

/** 空勾选常量，避免选择器每次返回新引用 */
const EMPTY_TOOLS: string[] = []

/**
 * 把 `agent.init` 的结果同步进 store：此刻有没有运行时（含创建中 / 关停中）+ 扩展能力勾选原值。
 *
 * 勾选写回会话设置（`sessions[].settings.enabledTools`）—— 输入框的工具选择器与会话设置里的
 * 扩展能力都从那里读，一处改了另一处跟着变。写的是**原值**（含此刻离线的 MCP）：UI 按原值显示、
 * 整份替换写入，过滤过的列表写进来会让离线项显示为未勾，并在下一次勾选时被抹掉。
 * 旧会话的勾选由后端在这次解析里补上，也经此落进 store。
 */
export function applySessionToolState(
  sessionId: string,
  result: Pick<AgentInitResult, 'created' | 'enabledTools'>
): void {
  const store = useChatStore.getState()
  store.setAgentCreated(sessionId, result.created)
  store.updateSessionSettings(sessionId, { enabledTools: result.enabledTools })
}

/**
 * 向后端重拉一次（`agent.init` 只解析、不创建运行时）。给不经当前会话初始化的地方用 ——
 * 会话设置弹窗可能开在一条非当前会话上；写入被拒之后也靠它回到真实状态。
 */
export async function refreshSessionTools(sessionId: string): Promise<void> {
  const result = await getSessionChannelApi().agent.init({ sessionId })
  if (result.success) applySessionToolState(sessionId, result)
}

export interface SessionToolsState {
  /** 这条会话的扩展能力勾选（mcp:/skill:） */
  enabledTools: string[]
  /**
   * 只读：会话此刻有 Agent 运行时（或正在关停）。勾选只在创建运行时那一刻读一次，
   * 期间改了也不会生效 —— 后端的写入口同样会拒绝。
   */
  locked: boolean
  /** 整份替换勾选；只读 / 没有会话 / 渠道端（无 HostApi）时什么也不做 */
  setEnabledTools: (next: string[]) => Promise<void>
}

/**
 * 会话扩展能力勾选的读写 —— 输入框的工具选择器与会话设置里的扩展能力共用这一份。
 *
 * 写入先乐观更新 store 再落库；后端拒绝（运行时抢在这次写入之前创建了）就回拉真实状态，
 * 勾选退回原样、UI 随之变成只读。
 */
export function useSessionTools(sessionId: string | null): SessionToolsState {
  const enabledTools = useChatStore(
    (s) =>
      (sessionId ? s.sessions.find((x) => x.id === sessionId)?.settings.enabledTools : undefined) ??
      EMPTY_TOOLS
  )
  const locked = useChatStore(
    (s) => !!sessionId && (!!s.sessionAgentCreated[sessionId] || !!s.sessionClosing[sessionId])
  )

  const setEnabledTools = useCallback(
    async (next: string[]): Promise<void> => {
      const host = getHostApi()
      if (!host || !sessionId) return
      const store = useChatStore.getState()
      if (store.sessionAgentCreated[sessionId] || store.sessionClosing[sessionId]) return
      store.updateSessionSettings(sessionId, { enabledTools: next })
      const { success } = await host.session.updateEnabledTools({
        id: sessionId,
        enabledTools: next
      })
      if (!success) await refreshSessionTools(sessionId)
    },
    [sessionId]
  )

  return { enabledTools, locked, setEnabledTools }
}
