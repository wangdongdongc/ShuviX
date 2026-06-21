/**
 * ModelDefaultsSettings —— 通用设置里的「默认模型 / 标题生成模型」配置（桌面/扩展单一来源）。
 *
 * UI + 编排逻辑（切提供商自动选首个模型、标题模型自愈）全共享；宿主只提供「持久化某个值」
 * 的 set 函数（桌面写 settingsStore + DB，扩展写 chrome.storage）——即只有存储不同。
 * 标题模型一节由 caps.showTitleModel 控制（扩展用启发式标题，关闭即可）。
 */
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { AvailableModel } from '@shuvix/chat-protocol/types/provider'
import { SettingsSection, SettingsRow, InlineSelect } from './SettingsPrimitives'

export interface ModelDefaultsSettingsProps {
  availableModels: AvailableModel[]
  /** 默认模型（新会话使用） */
  defaultProvider: string
  defaultModel: string
  /** 仅持久化（不含编排）——切提供商选首模型等逻辑在组件内 */
  setDefaultProvider: (id: string) => void
  setDefaultModel: (id: string) => void
  caps?: { showTitleModel?: boolean }
  /** 标题生成模型（caps.showTitleModel 时显示） */
  titleProvider?: string
  titleModel?: string
  setTitleProvider?: (id: string) => void
  setTitleModel?: (id: string) => void
}

export function ModelDefaultsSettings({
  availableModels,
  defaultProvider,
  defaultModel,
  setDefaultProvider,
  setDefaultModel,
  caps = {},
  titleProvider = '',
  titleModel = '',
  setTitleProvider,
  setTitleModel
}: ModelDefaultsSettingsProps): React.JSX.Element {
  const { t } = useTranslation()
  const enabledProviderIds = [...new Set(availableModels.map((m) => m.providerId))]
  const showTitleModel = !!caps.showTitleModel && !!setTitleProvider && !!setTitleModel

  // 标题模型自愈：原模型/提供商被禁用后回退（仅 availableModels 已加载时）
  useEffect(() => {
    if (!showTitleModel || !titleProvider || availableModels.length === 0) return
    const providerModels = availableModels.filter((m) => m.providerId === titleProvider)
    if (providerModels.length === 0) {
      setTitleProvider!('')
      setTitleModel!('')
    } else if (!providerModels.some((m) => m.modelId === titleModel)) {
      setTitleModel!(providerModels[0].modelId)
    }
  }, [showTitleModel, titleProvider, titleModel, availableModels, setTitleProvider, setTitleModel])

  const handleDefaultProviderChange = (p: string): void => {
    setDefaultProvider(p)
    if (!p) {
      setDefaultModel('')
      return
    }
    const first = availableModels.find((m) => m.providerId === p)
    if (first) setDefaultModel(first.modelId)
  }

  const handleTitleProviderChange = (p: string): void => {
    setTitleProvider!(p)
    if (!p) {
      setTitleModel!('')
      return
    }
    const first = availableModels.find((m) => m.providerId === p)
    if (first) setTitleModel!(first.modelId)
  }

  const providerOption = (pid: string): React.JSX.Element => {
    const m = availableModels.find((am) => am.providerId === pid)
    return (
      <option key={pid} value={pid}>
        {m?.providerName || pid}
      </option>
    )
  }

  return (
    <div className="px-5 pb-5 space-y-5">
      {/* 默认模型 */}
      <SettingsSection
        title={t('settings.defaultModelGroup')}
        description={t('settings.defaultModelGroupDesc')}
      >
        <SettingsRow
          title={t('settings.defaultProviderRow')}
          control={
            <InlineSelect value={defaultProvider} onChange={handleDefaultProviderChange}>
              <option value="">{t('settings.defaultModelNone')}</option>
              {enabledProviderIds.map(providerOption)}
            </InlineSelect>
          }
        />
        {defaultProvider && (
          <SettingsRow
            title={t('settings.defaultModelRow')}
            control={
              <InlineSelect value={defaultModel} onChange={setDefaultModel}>
                {availableModels
                  .filter((m) => m.providerId === defaultProvider)
                  .map((m) => (
                    <option key={m.id} value={m.modelId}>
                      {m.modelId}
                    </option>
                  ))}
              </InlineSelect>
            }
          />
        )}
      </SettingsSection>

      {/* 标题生成模型 */}
      {showTitleModel && (
        <SettingsSection
          title={t('settings.titleModelSection')}
          footer={t('settings.titleModelHint')}
        >
          <SettingsRow
            title={t('settings.titleModelProvider')}
            control={
              <InlineSelect value={titleProvider} onChange={handleTitleProviderChange}>
                <option value="">{t('settings.titleModelNone')}</option>
                {enabledProviderIds.map(providerOption)}
              </InlineSelect>
            }
          />
          {titleProvider && (
            <SettingsRow
              title={t('settings.titleModelModel')}
              control={
                <InlineSelect value={titleModel} onChange={setTitleModel!}>
                  {availableModels
                    .filter((m) => m.providerId === titleProvider)
                    .map((m) => (
                      <option key={m.id} value={m.modelId}>
                        {m.modelId}
                      </option>
                    ))}
                </InlineSelect>
              }
            />
          )}
        </SettingsSection>
      )}
    </div>
  )
}
