import { create } from 'zustand'

/**
 * 悬浮聊天（Floating Pin Chat）状态 —— 多窗模型
 *
 * 每个 sessionId 对应一个独立的悬浮窗口；多个会话可同时悬浮。
 * 每个窗口的渲染进程都有自己的 store 实例，通过 IPC 与主进程的
 * pinnedChatService 单例保持同步：
 * - 初始挂载：调用 pinChat.getState() 拉初值
 * - 后续变化：订阅 'window:pin-state-changed' 事件更新
 *
 * 内部用 Set 存储以保证 O(1) 查询；setter 接受数组形式从 IPC payload 直接喂入。
 */
interface PinChatStore {
  pinnedSessionIds: Set<string>
  setPinnedSessionIds: (ids: string[]) => void
}

export const usePinChatStore = create<PinChatStore>((set) => ({
  pinnedSessionIds: new Set<string>(),
  setPinnedSessionIds: (ids) => set({ pinnedSessionIds: new Set(ids) })
}))
