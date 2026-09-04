/**
 * 提供商设置（桌面绑定层）—— 复用 @shuvix/app-shell 的共享 ProviderTab。
 * 数据绑 settingsStore；后端绑 window.api.provider；删除确认用桌面 ConfirmDialog。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ProviderTab, type ProviderTabApi } from '@shuvix/app-shell'
import type { ProviderInfo } from '@shuvix/chat-protocol/types/provider'
import { useSettingsStore } from '../../stores/settingsStore'
import { ConfirmDialog } from '../common/ConfirmDialog'

const providerApi: ProviderTabApi = {
  listModels: (id) => window.api.provider.listModels(id),
  toggleEnabled: (p) => window.api.provider.toggleEnabled(p),
  toggleModelEnabled: (p) => window.api.provider.toggleModelEnabled(p),
  updateConfig: (p) => window.api.provider.updateConfig(p),
  add: (p) => window.api.provider.add(p),
  addModel: (p) => window.api.provider.addModel(p),
  deleteModel: (id) => window.api.provider.deleteModel(id),
  syncModels: (p) => window.api.provider.syncModels(p),
  updateModelCapabilities: (p) =>
    window.api.provider.updateModelCapabilities(
      p as Parameters<typeof window.api.provider.updateModelCapabilities>[0]
    ),
  oauth: {
    status: (id) => window.api.provider.oauthStatus(id),
    login: (id) => window.api.provider.oauthLogin(id),
    cancel: (id) => window.api.provider.oauthCancel(id),
    logout: (id) => window.api.provider.oauthLogout(id),
    onEvent: (cb) => window.api.provider.onOAuthEvent(cb),
    openExternal: (url) => window.api.app.openExternal(url)
  }
}

export function ProviderSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const { providers, setProviders, setAvailableModels } = useSettingsStore()
  const [deleting, setDeleting] = useState<ProviderInfo | null>(null)

  const refresh = async (): Promise<void> => {
    setProviders(await window.api.provider.listAll())
    setAvailableModels(await window.api.provider.listAvailableModels())
  }

  return (
    <>
      <ProviderTab
        providers={providers}
        api={providerApi}
        onChanged={refresh}
        caps={{ providerCrud: true }}
        onRequestDeleteProvider={(p) => setDeleting(p)}
      />
      {deleting && (
        <ConfirmDialog
          title={t('settings.deleteProviderConfirm', {
            name: deleting.displayName || deleting.name || ''
          })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={async () => {
            await window.api.provider.delete({ id: deleting.id })
            await refresh()
            setDeleting(null)
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  )
}
