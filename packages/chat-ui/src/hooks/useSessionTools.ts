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
  /** 这条会话的扩展能力勾选（mcp:/skill:）；没有会话时是欢迎页的草稿 */
  enabledTools: string[]
  /**
   * 只读：会话此刻有 Agent 运行时（或正在关停）。勾选只在创建运行时那一刻读一次，
   * 期间改了也不会生效 —— 后端的写入口同样会拒绝。
   */
  locked: boolean
  /** 整份替换勾选；只读 / 渠道端（无 HostApi）时什么也不做。没有会话时写欢迎页的草稿 */
  setEnabledTools: (next: string[]) => Promise<void>
}

/** 某会话此刻的勾选（null = 欢迎页草稿）—— 现读 store，不经渲染闭包 */
function currentTools(sessionId: string | null): string[] {
  const s = useChatStore.getState()
  return (
    (sessionId
      ? s.sessions.find((x) => x.id === sessionId)?.settings.enabledTools
      : s.welcomeEnabledTools) ?? EMPTY_TOOLS
  )
}

/**
 * 整份替换某会话的扩展能力勾选（null = 欢迎页草稿）。
 *
 * 写入先乐观更新 store 再落库；后端拒绝（运行时抢在这次写入之前创建了）就回拉真实状态，
 * 勾选退回原样、UI 随之变成只读。会话已有运行时 / 渠道端（无 HostApi）时什么也不做。
 * 没有会话时只改 store 里的草稿：直接发送新建会话时由输入框写进新会话（InputArea 的
 * `createSessionForSend`），之后清空。
 */
export async function writeSessionTools(sessionId: string | null, next: string[]): Promise<void> {
  const host = getHostApi()
  if (!host) return
  const store = useChatStore.getState()
  if (!sessionId) {
    store.setWelcomeEnabledTools(next)
    return
  }
  if (store.sessionAgentCreated[sessionId] || store.sessionClosing[sessionId]) return
  store.updateSessionSettings(sessionId, { enabledTools: next })
  const { success } = await host.session.updateEnabledTools({ id: sessionId, enabledTools: next })
  if (!success) await refreshSessionTools(sessionId)
}

/**
 * 在某会话（null = 欢迎页草稿）此刻的勾选上补上缺的那几项 —— 斜杠命令自动勾上依赖的扩展能力用。
 * 目标由调用方点名而不是取渲染时的当前会话：欢迎页直接发送时，命令要到新会话建好之后才展开，
 * 那一刻草稿已经写进新会话并清空了，依赖项该落到新会话上。
 */
export async function addSessionTools(
  sessionId: string | null,
  names: readonly string[]
): Promise<void> {
  const current = currentTools(sessionId)
  const missing = [...new Set(names)].filter((name) => !current.includes(name))
  if (missing.length === 0) return
  await writeSessionTools(sessionId, [...current, ...missing])
}

/**
 * 会话扩展能力勾选的读写 —— 输入框的工具选择器与会话设置里的扩展能力共用这一份
 * （写入语义见 `writeSessionTools`；没有会话时读写欢迎页的草稿 `welcomeEnabledTools`）。
 */
export function useSessionTools(sessionId: string | null): SessionToolsState {
  const enabledTools = useChatStore(
    (s) =>
      (sessionId
        ? s.sessions.find((x) => x.id === sessionId)?.settings.enabledTools
        : s.welcomeEnabledTools) ?? EMPTY_TOOLS
  )
  const locked = useChatStore(
    (s) => !!sessionId && (!!s.sessionAgentCreated[sessionId] || !!s.sessionClosing[sessionId])
  )

  const setEnabledTools = useCallback(
    (next: string[]): Promise<void> => writeSessionTools(sessionId, next),
    [sessionId]
  )

  return { enabledTools, locked, setEnabledTools }
}
