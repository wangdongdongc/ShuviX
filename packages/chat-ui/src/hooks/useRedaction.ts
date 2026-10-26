/**
 * 自动脱敏标记的会话归属与取值（docs/auto-redaction-design.md §2.3）。占位符属于哪条会话的对照表：缺省是当前打开的
 * 会话；显示别的会话内容的地方（侧栏的标题、子会话面板）用 RedactionSessionProvider 指明。
 */
import { createContext, createElement, useContext, useEffect, useSyncExternalStore } from 'react'
import {
  placeholdersIn,
  restorePlaceholders,
  type RedactionMarkInfo
} from '@shuvix/chat-protocol/utils/redactionPlaceholders'
import { useChatStore } from '../stores/chatStore'
import {
  redactionInfo,
  redactionVersion,
  requestRedactions,
  restoreForCopy,
  subscribeRedactions
} from '../stores/redactionCache'

const RedactionSessionContext = createContext<string | null | undefined>(undefined)

/** 这棵子树里的占位符属于 sessionId 那条会话 */
export function RedactionSessionProvider({
  sessionId,
  children
}: {
  sessionId: string | null
  children?: React.ReactNode
}): React.JSX.Element {
  return createElement(RedactionSessionContext.Provider, { value: sessionId }, children)
}

export function useRedactionSessionId(): string | null {
  const explicit = useContext(RedactionSessionContext)
  const active = useChatStore((s) => s.activeSessionId)
  return explicit === undefined ? active : explicit
}

/** 一处占位符的类别与真值；还没查到时发起查询，查到后重新渲染 */
export function useRedactionMark(placeholder: string): RedactionMarkInfo | undefined {
  const sessionId = useRedactionSessionId()
  useSyncExternalStore(subscribeRedactions, redactionVersion, redactionVersion)
  const info = sessionId ? redactionInfo(sessionId, placeholder) : undefined
  useEffect(() => {
    if (sessionId && !info) requestRedactions(sessionId, [placeholder])
  })
  return info
}

/**
 * 整段文本换回真值（查到的；没查到的发起查询、先原样留着）—— 给要拿整段真实文本做事的地方（行内代码认路径、
 * 点开那个文件），而不是逐处显示标记的地方。
 */
export function useRestoredText(text: string, opts: { onlyDisclosed?: boolean } = {}): string {
  const sessionId = useRedactionSessionId()
  useSyncExternalStore(subscribeRedactions, redactionVersion, redactionVersion)
  const placeholders = placeholdersIn(text)
  const missing = sessionId === null ? [] : placeholders.filter((p) => !redactionInfo(sessionId, p))
  useEffect(() => {
    if (sessionId && missing.length > 0) requestRedactions(sessionId, missing)
  })
  if (placeholders.length === 0 || sessionId === null) return text
  return restorePlaceholders(text, (p) => {
    const info = redactionInfo(sessionId, p)
    // onlyDisclosed：只换模型收到的就是真值的那些（得到的是模型看到的样子）
    return opts.onlyDisclosed === true && info?.disclosed !== true ? undefined : info?.value
  })
}

/** 复制用：把文本里查到的占位符换回真值（复制出去的是界面上看到的样子） */
export function useRestoreForCopy(): (text: string) => string {
  const sessionId = useRedactionSessionId()
  return (text) => restoreForCopy(sessionId, text)
}
