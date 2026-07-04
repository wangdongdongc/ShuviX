/**
 * ModelDefaultsSettings —— 通用设置里的「默认模型 / 标题生成模型」配置（桌面/扩展单一来源）。
 *
 * 复用 @shuvix/chat-ui 的通用 ModelSelect（与会话输入框同一组件，boxed 变体）——单个下拉
 * 同时选提供商 + 模型；宿主只提供「持久化某个值」的 set 函数（桌面写 settingsStore + DB，
 * 扩展写 chrome.storage）。
 * 默认模型与标题生成模型合并为同一组卡片；标题模型行由 caps.showTitleModel 控制
 * （扩展用启发式标题，关闭即可）。
 */
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { AvailableModel } from '@shuvix/chat-protocol/types/provider'
import { ModelSelect } from '@shuvix/chat-ui'
import { SettingsSection, SettingsRow } from './SettingsPrimitives'

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

  return (
    <div className="px-5 pb-5 space-y-5">
      {/* 默认模型 + 标题生成模型（合并为一组）；每行一个下拉同时选提供商与模型 */}
      <SettingsSection title={t('settings.defaultModelGroup')}>
        <SettingsRow
          title={t('settings.sessionModelRow')}
          description={t('settings.defaultModelGroupDesc')}
          control={
            <ModelSelect
              availableModels={availableModels}
              provider={defaultProvider}
              model={defaultModel}
              onChange={(p, m) => {
                setDefaultProvider(p)
                setDefaultModel(m)
              }}
              allowClear
              clearLabel={t('settings.defaultModelNone')}
            />
          }
        />
        {showTitleModel && (
          <SettingsRow
            title={t('settings.titleModelRow')}
            description={t('settings.titleModelHint')}
            control={
              <ModelSelect
                availableModels={availableModels}
                provider={titleProvider}
                model={titleModel}
                onChange={(p, m) => {
                  setTitleProvider!(p)
                  setTitleModel!(m)
                }}
                allowClear
                clearLabel={t('settings.titleModelNone')}
              />
            }
          />
        )}
      </SettingsSection>
    </div>
  )
}
