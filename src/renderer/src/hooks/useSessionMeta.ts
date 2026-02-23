import { useState, useEffect } from 'react'
import { useChatStore } from '../stores/chatStore'

export interface SessionMeta {
  projectPath: string | null
}

/**
 * 会话元信息 Hook — 会话切换时恢复 projectPath 和 enabledTools
 * @param activeSessionId 当前活动会话ID
 */
export function useSessionMeta(activeSessionId: string | null): SessionMeta {
  const [projectPath, setProjectPath] = useState<string | null>(null)

  useEffect(() => {
    if (!activeSessionId) {
      setProjectPath(null)
      return
    }
    // 由后端 service 层统一解析 workingDirectory 和 enabledTools
    window.api.session.getById(activeSessionId).then((s) => {
      setProjectPath(s?.workingDirectory || null)
      if (s?.enabledTools) {
        useChatStore.getState().setEnabledTools(s.enabledTools)
      }
    })
  }, [activeSessionId])

  return { projectPath }
}
