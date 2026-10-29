/**
 * ModelDefaultsSettings —— 通用设置里的「默认模型」配置（桌面/扩展单一来源）。
 *
 * 复用 @shuvix/chat-ui 的通用 ModelSelect（与会话输入框同一组件，boxed 变体）——单个下拉
 * 同时选提供商 + 模型；下面一行是默认思考等级（与输入框思考选择器同一份档位清单，档位名原样显示、不翻译）。
 * 宿主只提供「持久化某个值」的 set 函数（桌面写 settingsStore + DB，扩展写 chrome.storage）。
 *
 * 注：原「标题生成模型」一行已废弃 —— 自动标题走内置 auto-title hook 的 titler agent，
 * 模型按 agent md `shuvix-model` 通用链路解析（内置不声明 = 跟随会话当前模型；
 * 要钉模型就覆盖 ~/.shuvix/agents/titler.md），不再有专项设置。
 */
import { useTranslation } from 'react-i18next'
import type { AvailableModel } from '@shuvix/chat-protocol/types/provider'
import {
  SELECTABLE_THINKING_LEVELS,
  type SelectableThinkingLevel
} from '@shuvix/chat-protocol/types/thinking'
import { ModelSelect } from '@shuvix/chat-ui'
import { SettingsSection, SettingsRow, SegmentedControl } from './SettingsPrimitives'

export interface ModelDefaultsSettingsProps {
  availableModels: AvailableModel[]
  /** 默认模型（新会话使用） */
  defaultProvider: string
  defaultModel: string
  /** 默认思考等级（新会话没设过档位、且模型声明了推理能力时使用） */
  defaultThinkingLevel: SelectableThinkingLevel
  /** 仅持久化（不含编排）——切提供商选首模型等逻辑在组件内 */
  setDefaultProvider: (id: string) => void
  setDefaultModel: (id: string) => void
  setDefaultThinkingLevel: (level: SelectableThinkingLevel) => void
  /**
   * 命令分类模型（可选；宿主不给就不显示这一行）：设了之后每条要执行的命令先过一次分类，
   * 结果作为 `object.risk` 交给安全策略。`models` 是「分类」类模型的清单，空串 = 不分类。
   */
  classifier?: {
    models: AvailableModel[]
    provider: string
    model: string
    onChange: (provider: string, model: string) => void
  }
}

export function ModelDefaultsSettings({
  availableModels,
  defaultProvider,
  defaultModel,
  defaultThinkingLevel,
  setDefaultProvider,
  setDefaultModel,
  setDefaultThinkingLevel,
  classifier
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
        <SettingsRow
          title={t('settings.defaultThinkingRow')}
          description={t('settings.defaultThinkingRowDesc')}
          control={
            <div data-default-thinking>
              <SegmentedControl<SelectableThinkingLevel>
                value={defaultThinkingLevel}
                onChange={setDefaultThinkingLevel}
                options={SELECTABLE_THINKING_LEVELS.map((level) => ({
                  value: level,
                  label: level
                }))}
              />
            </div>
          }
        />
        {classifier && (
          <SettingsRow
            title={t('settings.classifierModelRow')}
            description={t('settings.classifierModelRowDesc')}
            control={
              <div data-classifier-model>
                <ModelSelect
                  availableModels={classifier.models}
                  provider={classifier.provider}
                  model={classifier.model}
                  onChange={classifier.onChange}
                  allowClear
                  clearLabel={t('settings.classifierModelNone')}
                />
              </div>
            }
          />
        )}
      </SettingsSection>
    </div>
  )
}
