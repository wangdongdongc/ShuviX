import { useEffect } from 'react'
import { create } from 'zustand'
import { getHostApi, useAppEvent, useChatStore } from '@shuvix/chat-ui'
import type { SessionArtifact } from '@shuvix/chat-protocol/artifacts'

/**
 * 会话产物清单（会话面板「产物」页 + 工具栏上那枚按钮出不出现）—— 按会话记的 `artifact.list` 结果。
 *
 * 工具栏与面板各挂一个 hook，切会话时会同时要一次：同一会话**同时只有一个请求在途**，在途期间
 * 再要的只记一笔，回来后补拉一次（于是既不重复，也不会漏掉在途期间刚记下的那一版）。
 * 刷新时机：会话切过来、`artifacts.changed` 点到这场会话或它的子会话（子会话的产物也在父会话的
 * 面板里）、或事件不带会话（重连后的重拉信号）。宿主没有 artifact 存储（扩展）就永远是 undefined。
 */

interface SessionArtifactsState {
  /** undefined = 还没取到 */
  bySession: Record<string, SessionArtifact[] | undefined>
}

const useSessionArtifactsStore = create<SessionArtifactsState>(() => ({ bySession: {} }))

/** 在途的会话；值为「回来后要不要再拉一次」 */
const inflight = new Map<string, boolean>()

export function refreshSessionArtifacts(sessionId: string): void {
  const list = getHostApi()?.artifact?.list
  if (!list) return
  if (inflight.has(sessionId)) {
    inflight.set(sessionId, true)
    return
  }
  inflight.set(sessionId, false)
  void list({ sessionId })
    .then((rows) =>
      useSessionArtifactsStore.setState((s) => ({
        bySession: { ...s.bySession, [sessionId]: rows }
      }))
    )
    .catch(() => {
      /* 取不到就保留上一份（首次则仍是 undefined，按钮不出现） */
    })
    .finally(() => {
      const again = inflight.get(sessionId) === true
      inflight.delete(sessionId)
      if (again) refreshSessionArtifacts(sessionId)
    })
}

/** 这次变更点到的会话是不是 `sessionId` 自己或它的直接子会话 */
function concerns(sessionId: string, changed: string): boolean {
  if (changed === sessionId) return true
  const rows = useSessionArtifactsStore.getState().bySession[sessionId]
  if (rows?.some((row) => row.sessionId === changed)) return true
  return useChatStore.getState().sessions.find((s) => s.id === changed)?.parentId === sessionId
}

/** 这场会话的产物（含直接子会话的）；undefined = 还没取到或宿主不支持 */
export function useSessionArtifacts(sessionId: string | null): SessionArtifact[] | undefined {
  const rows = useSessionArtifactsStore((s) => (sessionId ? s.bySession[sessionId] : undefined))

  useEffect(() => {
    if (sessionId) refreshSessionArtifacts(sessionId)
  }, [sessionId])

  useAppEvent('artifacts.changed', (event) => {
    if (!sessionId) return
    if (!event.sessionIds || event.sessionIds.some((id) => concerns(sessionId, id))) {
      refreshSessionArtifacts(sessionId)
    }
  })

  return rows
}

/** 只要件数（工具栏判断按钮出不出现） */
export function useSessionArtifactCount(sessionId: string | null): number {
  return useSessionArtifacts(sessionId)?.length ?? 0
}
