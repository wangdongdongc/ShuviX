import { create } from 'zustand'

interface UpdateState {
  updateEvent: UpdateEvent | null
  setUpdateEvent: (event: UpdateEvent | null) => void
}

/**
 * 自动更新状态 — 在主窗口和设置窗口之间共享最新更新事件
 */
export const useUpdateStore = create<UpdateState>((set) => ({
  updateEvent: null,
  setUpdateEvent: (event) => set({ updateEvent: event })
}))
