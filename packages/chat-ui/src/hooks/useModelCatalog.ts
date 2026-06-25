/**
 * useModelCatalogSync —— 聊天模型目录的共享同步（挂载即拉取 + 订阅 providers.changed 刷新）。
 *
 * 由各宿主的运行时容器挂载一次（与 useSessionInit/useAgentEvents 并列）；两端共用同一逻辑，
 * 消费端不再各端重复。ModelPicker 等从 useModelCatalogStore 读目录。见 docs/internal-events.md。
 */
import { useEffect } from 'react'
import { useModelCatalogStore } from '../stores/modelCatalogStore'
import { useAppEvent } from './useAppEvents'

export function useModelCatalogSync(): void {
  useEffect(() => {
    void useModelCatalogStore.getState().refresh()
  }, [])

  useAppEvent('providers.changed', () => {
    void useModelCatalogStore.getState().refresh()
  })
}
