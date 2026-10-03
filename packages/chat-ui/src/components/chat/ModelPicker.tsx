import { getHostApi, getSessionChannelApi, useChatHost } from '@shuvix/chat-ui'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../stores/chatStore'
import { useModelCatalogStore } from '../../stores/modelCatalogStore'
import { applySessionToolState } from '../../hooks/useSessionTools'
import { ModelSelect } from './ModelSelect'
import {
  SELECTABLE_THINKING_LEVELS,
  type SelectableThinkingLevel,
  type ThinkingLevel
} from '@shuvix/chat-protocol/types/thinking'

/** 每个可选档位的文案 —— 档位清单本身是共享常量（agent md 的 `shuvix-thinking` 收的就是这几档） */
const THINKING_LABEL_KEYS: Record<SelectableThinkingLevel, string> = {
  off: 'input.thinkOff',
  low: 'input.thinkLow',
  medium: 'input.thinkMedium',
  high: 'input.thinkHigh',
  xhigh: 'input.thinkXHigh'
}

interface ModelPickerProps {
  /** 只读模式：仅显示当前模型名，不可点击选择 */
  readonly?: boolean
}

/**
 * 输入栏模型选择器 —— 通用 ModelSelect（inline 变体）的薄包装。
 * 本层只负责会话副作用：选中模型后写会话配置 / 更新能力状态，以及思考深度切换的持久化；
 * 纯 UI 交互全在 ModelSelect。思考深度与能力点解绑——切模型不再重置。
 *
 * 模型与扩展能力勾选同一条规矩：只在创建 Agent 那一刻读一次，**会话已有运行时（或正在关停）
 * 时锁住**（面板照常能展开调思考深度，模型条目按禁用态画）。要换模型先在会话横幅的 agent
 * 胶囊上销毁运行时。没有会话（欢迎页）时选的模型由输入框在新建会话时写进去。
 */
export function ModelPicker({ readonly: isReadonly }: ModelPickerProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const { activeSessionId, thinkingLevel, setThinkingLevel } = useChatStore()
  const modelLocked = useChatStore(
    (s) =>
      !!s.activeSessionId &&
      (!!s.sessionAgentCreated[s.activeSessionId] || !!s.sessionClosing[s.activeSessionId])
  )

  const providers = useModelCatalogStore((s) => s.providers)
  const availableModels = useModelCatalogStore((s) => s.availableModels)
  const { activeProvider, activeModel, setActiveProvider, setActiveModel } = useChatHost().models

  const enabledProviders = useMemo(() => providers.filter((p) => p.isEnabled), [providers])

  const thinkingLevels = SELECTABLE_THINKING_LEVELS.map((value) => ({
    value,
    label: t(THINKING_LABEL_KEYS[value])
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
    if (!host || modelLocked) return
    const previous = { provider: activeProvider, model: activeModel }
    setActiveProvider(providerId)
    setActiveModel(modelId)

    // 单一写入口：agent.setModel 往会话树追加 model_change entry。不再另外写会话表 ——
    // 那份副本已随 v15 删除。后端拒绝 = 运行时抢在这次写入之前建起来了（发送与选模型几乎
    // 同时）：回拉真实模型，UI 随 agent_created 变成锁定态
    const sid = activeSessionId
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
      readonly={isReadonly}
      modelLocked={modelLocked}
      modelLockedHint={t('input.modelLocked')}
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
