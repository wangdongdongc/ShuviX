/**
 * 一条会话有几台 MCP 可勾、勾着几台（档案声明的缺省勾着）—— 手机上详情首页与空对话页的「扩展能力」那一行共用。
 */
import { useEffect, useState } from 'react'
import { getSessionChannelApi, useSessionTools } from '@shuvix/chat-ui'
import { isToolSelected } from '@shuvix/chat-protocol/toolSelection'

export function useMcpSummary(sessionId: string): { total: number; selected: number } {
  const { enabledTools } = useSessionTools(sessionId)
  const [tools, setTools] = useState<Array<{ name: string; declared: boolean }>>([])
  useEffect(() => {
    let alive = true
    void getSessionChannelApi()
      .tools.list(sessionId)
      .then((list) => {
        if (!alive) return
        setTools(
          list
            .filter((tool) => tool.group?.startsWith('mcp:'))
            .map((tool) => ({ name: tool.name, declared: !!tool.declaredBy }))
        )
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [sessionId])
  return {
    total: tools.length,
    selected: tools.filter((tool) => isToolSelected(enabledTools, tool.name, tool.declared)).length
  }
}
