import { useCallback, useRef, useState } from 'react'
import {
  isForkableSessionShape,
  type SessionForkRefusal,
  type SessionForkResult
} from '@shuvix/chat-protocol/sessionFork'
import { getHostApi } from '../api/chatApi'
import { selectSessionViewOf, useChatStore } from '../stores/chatStore'

type ChatStoreState = ReturnType<typeof useChatStore.getState>

/**
 * 这条会话此刻能不能 fork（界面给不给入口）：形态给（`isForkableSessionShape`）、视图说能回退
 * （新格式存储 —— 旧格式只读）、视图空闲。宿主有没有 `session.fork` 由调用方另看。还没收到视图 → false。
 * 后台还有派生 agent 在跑这一种视图看不出来，交给宿主拒绝（`busy`）。
 */
export function selectSessionForkable(state: ChatStoreState, sessionId: string | null): boolean {
  if (!sessionId) return false
  const session = state.sessions.find((s) => s.id === sessionId)
  if (!session || !isForkableSessionShape(session)) return false
  const view = selectSessionViewOf(sessionId)(state)
  return view?.capabilities.rollback === true && view.run.state === 'idle'
}

/** 拒绝原因 → 说明文案的 i18n key（标题统一是 `chat.forkFailedTitle`） */
export function forkRefusalKey(reason: SessionForkRefusal): string {
  switch (reason) {
    case 'busy':
      return 'chat.forkBusy'
    case 'not_forkable':
      return 'chat.forkNotForkable'
    case 'invalid_target':
      return 'chat.forkInvalidTarget'
    case 'no_session':
      return 'chat.forkNoSession'
    case 'failed':
      return 'chat.forkFailed'
  }
}

export interface UseSessionForkReturn {
  /** 宿主有没有 fork 能力（渠道端、旧宿主没有 → 不给入口） */
  available: boolean
  /** fork 一条会话（整段，或从 `messageId` 那条回复分支）；在途时再点一次什么都不做 */
  forkSession: (sessionId: string, messageId?: string) => Promise<void>
  /** 上一次 fork 被拒的原因（非 null 时调用方画一个说明框） */
  forkError: SessionForkRefusal | null
  clearForkError: () => void
}

/**
 * 会话 fork 的界面一侧（对话里的「从这里分支」与侧栏的「分支会话」共用）：调宿主的 `session.fork`，成功就
 * 刷新会话列表、交给 `open` 切过去（缺省 `setActiveSessionId`）；被拒把原因留在 `forkError`。fork 是新建，
 * 不毁任何东西，所以不先确认。
 */
export function useSessionFork(open?: (sessionId: string) => void): UseSessionForkReturn {
  const [forkError, setForkError] = useState<SessionForkRefusal | null>(null)
  const inFlight = useRef(false)
  const available = !!getHostApi()?.session.fork

  const forkSession = useCallback(
    async (sessionId: string, messageId?: string) => {
      const host = getHostApi()
      const fork = host?.session.fork
      if (!host || !fork || inFlight.current) return
      inFlight.current = true
      try {
        let result: SessionForkResult
        try {
          result = await fork(messageId === undefined ? { sessionId } : { sessionId, messageId })
        } catch {
          setForkError('failed')
          return
        }
        if (!result.success) {
          setForkError(result.reason)
          return
        }
        // fork 已经建好了：刷新列表失败不算 fork 失败（主进程的列表广播随后也会刷新），照样切过去
        try {
          useChatStore.getState().setSessions(await host.session.list())
        } catch {
          /* 列表等广播 */
        }
        if (open) open(result.sessionId)
        else useChatStore.getState().setActiveSessionId(result.sessionId)
      } finally {
        inFlight.current = false
      }
    },
    [open]
  )

  const clearForkError = useCallback(() => setForkError(null), [])

  return { available, forkSession, forkError, clearForkError }
}
