import { create } from 'zustand'

/** 会话面板宽度边界（px）—— 共享钳制；持久化由各宿主在 store 外接 */
export const SESSION_PANEL_MIN_W = 240
export const SESSION_PANEL_MAX_W = 600

/** 会话面板可装载的工具（会话工具栏按钮与之一一对应；preview 仅注入了 previewContent 的宿主有，
 *  tasks 仅本会话有后台任务时有） */
export type SessionPanelTool = 'files' | 'preview' | 'subagent' | 'tasks'

/**
 * 共享会话面板视图状态（桌面 / 扩展共用）—— 聊天区内部右侧的「会话工具栏」悬浮卡片
 * （装载 Files / Preview / Sub-agent / 后台任务，见 SessionPanel / SessionToolbar）。
 *
 * 与 usePanelStore（app 级右侧面板）的定位区分：本面板挂在对话列内部、与会话绑定 ——
 * 展开态+激活工具按 sessionId 记忆（内存态不持久化，重启默认收起）；宽度全局共享。
 * 刻意零宿主耦合：宽度持久化由各宿主在 store 之外接（桌面 panelLayout；扩展 chrome.storage）。
 */
export interface SessionPanelStoreState {
  /** 每会话展开态（key: sessionId）：值为当前激活工具；null/缺省 = 收起 */
  openBySession: Record<string, SessionPanelTool | null>
  /** 面板宽度（px） */
  width: number

  /** 工具栏点按语义：已开且同工具 → 收起；否则展开并切到该工具 */
  toggle: (sessionId: string, tool: SessionPanelTool) => void
  /** 揭示语义：确保展开并切到该工具（不 toggle）—— 文件预览 / 子代理注册用 */
  show: (sessionId: string, tool: SessionPanelTool) => void
  close: (sessionId: string) => void
  setWidth: (width: number) => void
}

export const useSessionPanelStore = create<SessionPanelStoreState>((set, get) => ({
  openBySession: {},
  // 默认即最窄：这个面板是对话的旁支，需要更宽时用户自己拖；宽度一经调整即持久化
  width: SESSION_PANEL_MIN_W,

  toggle: (sessionId, tool) =>
    set((s) => ({
      openBySession: {
        ...s.openBySession,
        [sessionId]: s.openBySession[sessionId] === tool ? null : tool
      }
    })),
  show: (sessionId, tool) =>
    set((s) =>
      s.openBySession[sessionId] === tool
        ? s
        : { openBySession: { ...s.openBySession, [sessionId]: tool } }
    ),
  close: (sessionId) =>
    set((s) =>
      s.openBySession[sessionId] ? { openBySession: { ...s.openBySession, [sessionId]: null } } : s
    ),
  setWidth: (width) => {
    const clamped = Math.max(SESSION_PANEL_MIN_W, Math.min(SESSION_PANEL_MAX_W, width))
    if (clamped === get().width) return
    set({ width: clamped })
  }
}))
