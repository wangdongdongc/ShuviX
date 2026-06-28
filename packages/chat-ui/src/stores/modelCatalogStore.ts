/**
 * modelCatalogStore —— 聊天「模型目录」共享状态（providers + availableModels）。
 *
 * 数据经共享 ChatApi.provider 拉取，两端一致；由 useModelCatalogSync 在挂载时拉取并订阅
 * AppEvent 'providers.changed' 增量刷新。ChatHost 不再注入目录，只保留「当前选中模型」。
 * 见 docs/internal-events.md。
 */
import { create } from 'zustand'
import type { ProviderInfo, AvailableModel } from '@shuvix/chat-protocol/types/provider'
import { getHostApi } from '../api/chatApi'

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
    const host = getHostApi()
    if (!host) {
      // 渠道端无 provider 管理能力：目录留空，但仍标记 loaded 以放行会话初始化时序
      set({ providers: [], availableModels: [], loaded: true })
      return
    }
    const [providers, availableModels] = await Promise.all([
      host.provider.listAll(),
      host.provider.listAvailableModels()
    ])
    set({ providers, availableModels, loaded: true })
  }
}))
