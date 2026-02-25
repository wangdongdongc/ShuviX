import { useChatStore } from '../stores/chatStore'

export interface SessionMeta {
  projectPath: string | null
  agentMdLoaded: boolean
  claudeMdLoaded: boolean
}

/**
 * 会话元信息 Hook — 从 store 中读取（数据由 useSessionInit 写入）
 * 不再单独发 IPC，避免与 agent.init 的时序竞争
 */
export function useSessionMeta(): SessionMeta {
  const projectPath = useChatStore((s) => s.projectPath)
  const agentMdLoaded = useChatStore((s) => s.agentMdLoaded)
  const claudeMdLoaded = useChatStore((s) => s.claudeMdLoaded)

  return { projectPath, agentMdLoaded, claudeMdLoaded }
}
