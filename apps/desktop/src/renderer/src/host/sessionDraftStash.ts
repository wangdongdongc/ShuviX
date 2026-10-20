/**
 * 浏览器里「带草稿打开会话」的暂存（2026-10-19，远程访问安全策略的引导）—— web 的设置页在自己的标签页里：按钮
 * 新建会话后把 {会话, 草稿} 存进本标签页的 sessionStorage，再把这个标签页带回聊天页；聊天页挂上之后取走它
 * （useNotificationBridge），切到那条会话、把草稿填进输入框。存取都包 try/catch：存储被禁用时只是没有草稿。
 */
const KEY = 'shuvix.openSessionDraft'

export interface PendingSessionDraft {
  readonly sessionId: string
  readonly draft: string
}

/** 记下要带回聊天页的会话与草稿 */
export function stashPendingSessionDraft(
  pending: PendingSessionDraft,
  storage: Pick<Storage, 'setItem'> | undefined = globalThis.sessionStorage
): void {
  try {
    storage?.setItem(KEY, JSON.stringify(pending))
  } catch {
    /* 存不了：照样回到聊天页，只是没有草稿 */
  }
}

/** 取走（取一次就没了；没有 / 坏了 → null） */
export function takePendingSessionDraft(
  storage: Pick<Storage, 'getItem' | 'removeItem'> | undefined = globalThis.sessionStorage
): PendingSessionDraft | null {
  try {
    const raw = storage?.getItem(KEY)
    if (!raw) return null
    storage?.removeItem(KEY)
    const parsed = JSON.parse(raw) as Partial<PendingSessionDraft>
    if (typeof parsed.sessionId !== 'string' || parsed.sessionId === '') return null
    return {
      sessionId: parsed.sessionId,
      draft: typeof parsed.draft === 'string' ? parsed.draft : ''
    }
  } catch {
    return null
  }
}
