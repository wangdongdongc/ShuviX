/**
 * 收件箱里一条会话的图标：这条会话自己的身份图标（与侧栏同一套：定时运行 / bot / 笔记本 / 普通会话）。
 * `pulse` = 在跑（跳动的强调色，同侧栏转圈）；不跳时用灰色，放在卡片头的底色块里
 */

import { Bot, FileText, MessageSquare, Timer } from 'lucide-react'
import { boundBotOf } from '@shuvix/chat-protocol/botSession'
import type { Session } from '@shuvix/chat-ui'

export function SessionKindIcon({
  session,
  size = 16,
  className
}: {
  session: Session
  size?: number
  className: string
}): React.JSX.Element {
  if (session.settings.triggerRun) {
    return <Timer size={size} aria-hidden="true" className={className} />
  }
  if (boundBotOf(session.settings)) {
    return <Bot size={size} aria-hidden="true" className={className} />
  }
  if (session.settings.notebookPath) {
    return <FileText size={size} aria-hidden="true" className={className} />
  }
  return <MessageSquare size={size} fill="currentColor" aria-hidden="true" className={className} />
}
