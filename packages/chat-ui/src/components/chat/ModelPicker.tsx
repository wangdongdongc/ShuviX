import { getHostApi, getSessionChannelApi, useChatHost } from '@shuvix/chat-ui'
import { useChatDensity } from '../../host/chatHostContext'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../stores/chatStore'
import { useModelCatalogStore } from '../../stores/modelCatalogStore'
import { applySessionToolState } from '../../hooks/useSessionTools'
import { confirmAgentChange } from './CacheBreakConfirm'
import { ModelSelect } from './ModelSelect'
import {
  SELECTABLE_THINKING_LEVELS,
  THINKING_LEVEL_LABEL_KEYS,
  type ThinkingLevel
} from '@shuvix/chat-protocol/types/thinking'

interface ModelPickerProps {
  /** 只读模式：仅显示当前模型名，不可点击选择 */
  readonly?: boolean
}

/**
 * 输入栏模型选择器 —— 通用 ModelSelect（inline 变体）的薄包装。
 * 本层只负责会话副作用：选中模型后写会话配置 / 更新能力状态，以及思考深度切换的持久化；
 * 纯 UI 交互全在 ModelSelect。思考深度与能力点解绑——切模型不再重置。
 *
 * 会话已有 Agent 运行时也能换（2026-10-26）：后端当场重配那个 agent，从下一次请求起用新模型。换模型一定
 * 打穿提供商的提示词缓存 —— 对话里已经有过模型回复时先问一句（`confirmAgentChange`）。没有会话（欢迎页）
 * 时选的模型由输入框在新建会话时写进去。
 */
export function ModelPicker({ readonly: isReadonly }: ModelPickerProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const { activeSessionId, thinkingLevel, setThinkingLevel } = useChatStore()

  const providers = useModelCatalogStore((s) => s.providers)
  const availableModels = useModelCatalogStore((s) => s.availableModels)
  const { activeProvider, activeModel, setActiveProvider, setActiveModel } = useChatHost().models
  const density = useChatDensity()

  const enabledProviders = useMemo(() => providers.filter((p) => p.isEnabled), [providers])

  const thinkingLevels = SELECTABLE_THINKING_LEVELS.map((value) => ({
    value,
    label: t(THINKING_LEVEL_LABEL_KEYS[value])
  }))

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
    if (providerId === activeProvider && modelId === activeModel) return
    const sid = activeSessionId
    // 换过去会不会打穿缓存（有没有 agent 也由它答），先问主进程；保不住就问用户，不答应就什么都不改
    if (sid) {
      const confirmed = await confirmAgentChange(sid, { provider: providerId, model: modelId })
      if (!confirmed || useChatStore.getState().activeSessionId !== sid) return
    }
    const previous = { provider: activeProvider, model: activeModel }
    setActiveProvider(providerId)
    setActiveModel(modelId)

    // 单一写入口：agent.setModel 写会话设置，有 agent 就当场重配它。后端拒绝 = 锁住的 agent 用不了这个模型
    // （provider 刚停用之类）：回拉真实模型
    if (sid) {
      const { success } = await host.agent.setModel({
        sessionId: sid,
        provider: providerId,
        model: modelId
      })
      if (useChatStore.getState().activeSessionId !== sid) return
      if (!success) {
        const result = await getSessionChannelApi().agent.init({ sessionId: sid })
        if (useChatStore.getState().activeSessionId !== sid) return
        if (!result.success) {
          // 连真实状态都读不到：至少别把一个没写进去的模型挂在界面上
          setActiveProvider(previous.provider)
          setActiveModel(previous.model)
          return
        }
        setActiveProvider(result.provider)
        setActiveModel(result.model)
        const store = useChatStore.getState()
        store.setModelSupportsReasoning(!!result.capabilities?.reasoning)
        store.setModelSupportsVision(!!result.capabilities?.vision)
        store.setMaxContextTokens(result.capabilities?.maxInputTokens || 0)
        applySessionToolState(sid, result)
        return
      }
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
    const store = useChatStore.getState()
    store.setModelSupportsVision(!!caps.vision)
    store.setMaxContextTokens(caps.maxInputTokens || 0)
    store.setUsedContextTokens(null)
  }

  return (
    <ModelSelect
      variant="inline"
      density={density}
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
