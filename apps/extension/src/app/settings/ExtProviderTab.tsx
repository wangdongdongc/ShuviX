import { useState, useCallback, useEffect } from 'react'
import { getChatApi } from '@shuvix/chat-ui'
import { ProviderTab, type ProviderTabApi } from '@shuvix/app-shell'
import type { ProviderInfo } from '@shuvix/chat-protocol/types/provider'
import { settingsStore } from '../../storage/settingsStore'

const extProviderApi: ProviderTabApi = {
  listModels: (id) => getChatApi().provider.listModels(id),
  toggleEnabled: (p) => getChatApi().provider.toggleEnabled(p),
  toggleModelEnabled: (p) => getChatApi().provider.toggleModelEnabled(p),
  updateConfig: (p) => getChatApi().provider.updateConfig(p),
  add: (p) => getChatApi().provider.add(p),
  addModel: (p) => getChatApi().provider.addModel(p),
  deleteModel: (id) => getChatApi().provider.deleteModel(id),
  syncModels: (p) => getChatApi().provider.syncModels(p),
  updateModelCapabilities: (p) =>
    getChatApi().provider.updateModelCapabilities(
      p as Parameters<ReturnType<typeof getChatApi>['provider']['updateModelCapabilities']>[0]
    )
}

/** 扩展提供商 tab 绑定层 —— 复用共享 ProviderTab（全功能），数据走 chrome.storage provider 存储 */
export function ExtProviderTab(): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const load = useCallback(() => {
    setProviders(settingsStore.listProviders())
  }, [])
  useEffect(() => {
    load()
  }, [load])
  return (
    <ProviderTab
      providers={providers}
      api={extProviderApi}
      onChanged={load}
      caps={{ providerCrud: true }}
      onRequestDeleteProvider={async (p) => {
        if (!window.confirm(`删除提供商 ${p.displayName || p.name}？`)) return
        await getChatApi().provider.delete({ id: p.id })
        load()
      }}
    />
  )
}
