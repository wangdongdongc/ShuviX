/**
 * 待填进输入框的草稿（2026-10-19，远程访问安全策略的引导）—— 设置页的「让 agent 帮我设置」新建一条会话、把提示词
 * 交给主进程，再让主窗口切到那条会话；主窗口切过去之后来取（`app:take-session-draft`），填进输入框，不自动发送。
 * 取一次就没了。主窗口正关着也不丢：它被重建、切到会话之后照样来取。只在内存里（退出就没了 —— 本来就是一次性的）。
 */

/** 草稿的长度上限（提示词至多几 KB；挡住异常的大包） */
export const MAX_SESSION_DRAFT_CHARS = 20_000

const drafts = new Map<string, string>()

/** 记下一条会话的草稿（同一条会话再记一次 → 换成新的） */
export function setSessionDraft(sessionId: string, draft: string): void {
  drafts.set(sessionId, draft.slice(0, MAX_SESSION_DRAFT_CHARS))
}

/** 取走一条会话的草稿（没有 → null） */
export function takeSessionDraft(sessionId: string): string | null {
  const draft = drafts.get(sessionId)
  if (draft === undefined) return null
  drafts.delete(sessionId)
  return draft
}
