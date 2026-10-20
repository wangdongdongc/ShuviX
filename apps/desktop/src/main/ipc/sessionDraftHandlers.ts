import { defineHandler } from './registry'
import { setSessionDraft, takeSessionDraft } from '../services/sessionDrafts'
import { focusSession } from '../services/notificationService'

/**
 * 带草稿打开会话（2026-10-19，远程访问安全策略的引导）：设置窗口把一条新会话与要填进输入框的提示词交过来 →
 * 记下草稿、把主窗口拉到眼前并切到那条会话（与点通知同一条路，`focusSession`）；主窗口切过去之后
 * `app:take-session-draft` 取走草稿填进输入框。前者只在桌面（它开的是这台电脑上的主窗口）—— web 客户端在本地
 * 实现（renderer/src/web/webApi.ts：本标签页回到聊天并带着草稿）。
 */
export function registerSessionDraftHandlers(): void {
  defineHandler('app:open-session-draft', (_ctx, params: { sessionId: string; draft: string }) => {
    if (typeof params?.sessionId !== 'string' || params.sessionId === '') return { success: false }
    if (typeof params.draft === 'string' && params.draft !== '') {
      setSessionDraft(params.sessionId, params.draft)
    }
    focusSession(params.sessionId)
    return { success: true }
  })

  defineHandler('app:take-session-draft', (_ctx, sessionId: string) =>
    typeof sessionId === 'string' ? takeSessionDraft(sessionId) : null
  )
}
