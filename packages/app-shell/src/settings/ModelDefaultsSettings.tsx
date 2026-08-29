/**
 * ModelDefaultsSettings —— 通用设置里的「默认模型」配置（桌面/扩展单一来源）。
 *
 * 复用 @shuvix/chat-ui 的通用 ModelSelect（与会话输入框同一组件，boxed 变体）——单个下拉
 * 同时选提供商 + 模型；宿主只提供「持久化某个值」的 set 函数（桌面写 settingsStore + DB，
 * 扩展写 chrome.storage）。
 *
 * 注：原「标题生成模型」一行已废弃 —— 自动标题走内置 auto-title 工作流的 titler agent，
 * 模型按 agent md `shuvix-model` 通用链路解析（内置不声明 = 跟随会话当前模型；
 * 要钉模型就覆盖 ~/.shuvix/agents/titler.md），不再有专项设置。
 */
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
}

export function ModelDefaultsSettings({
  availableModels,
  defaultProvider,
  defaultModel,
  setDefaultProvider,
  setDefaultModel
}: ModelDefaultsSettingsProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="px-5 pb-5 space-y-5">
      {/* 默认模型；一个下拉同时选提供商与模型 */}
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
      </SettingsSection>
    </div>
  )
}
