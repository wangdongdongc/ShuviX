import { getHostApi, useChatHost } from '@shuvix/chat-ui'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../stores/chatStore'
import { useModelCatalogStore } from '../../stores/modelCatalogStore'
import { ModelSelect } from './ModelSelect'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'

interface ModelPickerProps {
  /** 只读模式：仅显示当前模型名，不可点击选择 */
  readonly?: boolean
}

/**
 * 输入栏模型选择器 —— 通用 ModelSelect（inline 变体）的薄包装。
 * 本层只负责会话副作用：选中模型后写会话配置 / 切 Agent 模型 / 更新能力状态，以及思考深度
 * 切换的持久化；纯 UI 交互全在 ModelSelect。思考深度与能力点解绑——切模型不再重置。
 */
export function ModelPicker({ readonly: isReadonly }: ModelPickerProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const { activeSessionId, thinkingLevel, setThinkingLevel, setModelSupportsVision } =
    useChatStore()

  const providers = useModelCatalogStore((s) => s.providers)
  const availableModels = useModelCatalogStore((s) => s.availableModels)
  const { activeProvider, activeModel, setActiveProvider, setActiveModel } = useChatHost().models

  const enabledProviders = useMemo(() => providers.filter((p) => p.isEnabled), [providers])

  const thinkingLevels = [
    { value: 'off', label: t('input.thinkOff') },
    { value: 'low', label: t('input.thinkLow') },
    { value: 'medium', label: t('input.thinkMedium') },
    { value: 'high', label: t('input.thinkHigh') },
    { value: 'xhigh', label: t('input.thinkXHigh') }
  ]

  /** 切换思考深度并持久化到会话 */
  const handleSetThinkingLevel = async (level: string): Promise<void> => {
    const host = getHostApi()
    if (!host) return // 渠道端无权改会话配置（ModelPicker 只读，双保险）
    setThinkingLevel(level)
    if (activeSessionId) {
      await host.agent.setThinkingLevel({
        sessionId: activeSessionId,
        level: level as ThinkingLevel
      })
    }
  }

  /** 确认模型：切 provider/model + 会话级持久化 + 按新模型能力更新状态 */
  const handlePickModel = async (providerId: string, modelId: string): Promise<void> => {
    const host = getHostApi()
    if (!host) return
    setActiveProvider(providerId)
    setActiveModel(modelId)

    // 单一写入口：agent.setModel 会往会话树追加 model_change entry（Agent 未创建时
    // 后端直接写树）。不再另外写会话表 —— 那份副本已随 v15 删除。
    const providerInfo = providers.find((p) => p.id === providerId)
    if (activeSessionId) {
      await host.agent.setModel({
        sessionId: activeSessionId,
        provider: providerId,
        model: modelId,
        baseUrl: providerInfo?.baseUrl || undefined,
        apiProtocol: providerInfo?.apiProtocol || undefined
      })
    }

    // 按新模型能力更新状态；思考深度与能力点解绑：切换模型不再重置，保留用户当前所选
    const selectedModel = availableModels.find(
      (m) => m.providerId === providerId && m.modelId === modelId
    )
    const caps = (() => {
      try {
        return JSON.parse(selectedModel?.capabilities || '{}')
      } catch {
        return {}
      }
    })()
    setModelSupportsVision(!!caps.vision)
    useChatStore.getState().setMaxContextTokens(caps.maxInputTokens || 0)
    useChatStore.getState().setUsedContextTokens(null)
  }

  return (
    <ModelSelect
      variant="inline"
      readonly={isReadonly}
      availableModels={availableModels}
      providers={enabledProviders.map((p) => ({
        id: p.id,
        name: p.name,
        displayName: p.displayName
      }))}
      provider={activeProvider}
      model={activeModel}
      onChange={(providerId, modelId) => {
        void handlePickModel(providerId, modelId)
      }}
      thinking={{
        level: thinkingLevel,
        levels: thinkingLevels,
        onChange: (level) => {
          void handleSetThinkingLevel(level)
        }
      }}
      onConfigureProviders={() => getHostApi()?.app.openSettings('providers')}
    />
  )
}
