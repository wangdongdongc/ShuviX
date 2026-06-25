/**
 * modelCatalogStore —— 聊天「模型目录」共享状态（providers + availableModels）。
 *
 * 数据经共享 ChatApi.provider 拉取，两端一致；由 useModelCatalogSync 在挂载时拉取并订阅
 * AppEvent 'providers.changed' 增量刷新。ChatHost 不再注入目录，只保留「当前选中模型」。
 * 见 docs/internal-events.md。
 */
import { create } from 'zustand'
import type { ProviderInfo, AvailableModel } from '@shuvix/chat-protocol/types/provider'
import { getChatApi } from '../api/chatApi'

interface ModelCatalogState {
  /** 目录是否已加载（用于 useSessionInit 的初始化时序） */
  loaded: boolean
  providers: ProviderInfo[]
  availableModels: AvailableModel[]
  /** 经 ChatApi.provider 重新拉取目录 */
  refresh: () => Promise<void>
}

export const useModelCatalogStore = create<ModelCatalogState>((set) => ({
  loaded: false,
  providers: [],
  availableModels: [],
  refresh: async () => {
    const [providers, availableModels] = await Promise.all([
      getChatApi().provider.listAll(),
      getChatApi().provider.listAvailableModels()
    ])
    set({ providers, availableModels, loaded: true })
  }
}))
