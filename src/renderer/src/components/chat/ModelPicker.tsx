import { useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useClickOutside } from '../../hooks/useClickOutside'

/**
 * 模型选择器 — 两步式：先选 Provider，再选 Model
 * 选择后自动切换 Agent 模型并持久化到会话
 */
export function ModelPicker(): React.JSX.Element {
  const { t } = useTranslation()
  const { activeSessionId, setSessions, setModelSupportsReasoning, setThinkingLevel, setModelSupportsVision } = useChatStore()
  const { availableModels, providers, activeProvider, activeModel, setActiveProvider, setActiveModel } = useSettingsStore()

  const pickerRef = useRef<HTMLDivElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerStep, setPickerStep] = useState<'provider' | 'model'>('provider')
  const [draftProvider, setDraftProvider] = useState(activeProvider)

  const closePicker = useCallback(() => {
    setPickerOpen(false)
    setPickerStep('provider')
  }, [])

  useClickOutside(pickerRef, closePicker, pickerOpen)

  // 已启用 provider 列表
  const enabledProviders = providers.filter((p) => p.isEnabled)
  // 当前草稿 provider 下可选模型
  const draftProviderModels = availableModels.filter((m) => m.providerId === draftProvider)

  /** 打开/关闭选择器 */
  const togglePicker = (): void => {
    if (pickerOpen) {
      closePicker()
      return
    }
    setDraftProvider(activeProvider)
    setPickerStep('provider')
    setPickerOpen(true)
  }

  /** 选择 provider 后进入模型选择 */
  const handlePickProvider = (providerId: string): void => {
    setDraftProvider(providerId)
    setPickerStep('model')
  }

  /** 确认模型并提交 provider/model 切换 */
  const handlePickModel = async (modelId: string): Promise<void> => {
    setActiveProvider(draftProvider)
    setActiveModel(modelId)

    // 会话级持久化
    if (activeSessionId) {
      await window.api.session.updateModelConfig({
        id: activeSessionId,
        provider: draftProvider,
        model: modelId
      })
      const sessions = await window.api.session.list()
      setSessions(sessions)
    }

    const providerInfo = providers.find((p) => p.id === draftProvider)
    if (activeSessionId) {
      await window.api.agent.setModel({
        sessionId: activeSessionId,
        provider: draftProvider,
        model: modelId,
        baseUrl: providerInfo?.baseUrl || undefined,
        apiProtocol: (providerInfo as any)?.apiProtocol || undefined
      })
    }

    // 根据新模型能力更新状态
    const selectedModel = availableModels.find((m) => m.providerId === draftProvider && m.modelId === modelId)
    const caps = (() => { try { return JSON.parse(selectedModel?.capabilities || '{}') } catch { return {} } })()
    const hasReasoning = !!caps.reasoning
    setModelSupportsReasoning(hasReasoning)
    setModelSupportsVision(!!caps.vision)
    useChatStore.getState().setMaxContextTokens(caps.maxInputTokens || 0)
    useChatStore.getState().setUsedContextTokens(null)
    const newLevel = hasReasoning ? 'medium' : 'off'
    setThinkingLevel(newLevel)
    if (activeSessionId) {
      await window.api.agent.setThinkingLevel({ sessionId: activeSessionId, level: newLevel as any })
      await window.api.session.updateModelMetadata({
        id: activeSessionId,
        modelMetadata: JSON.stringify({ thinkingLevel: newLevel })
      })
    }

    closePicker()
  }

  return (
    <div ref={pickerRef} className="relative flex items-center">
      <button
        onClick={togglePicker}
        className="inline-flex items-center gap-1 text-[11px] text-blue-400/70 hover:text-blue-400 transition-colors"
        title={t('input.switchModel')}
      >
        <span className="max-w-[120px] truncate">{activeModel}</span>
        <ChevronDown size={11} />
      </button>

      {pickerOpen && (
        <div className="absolute left-0 bottom-8 w-[280px] rounded-lg border border-border-primary bg-bg-secondary shadow-2xl overflow-hidden">
          <div className="px-2 py-1.5 border-b border-border-secondary text-[10px] text-text-tertiary flex items-center justify-between">
            <span>{pickerStep === 'provider' ? t('input.selectProvider') : t('input.selectModel')}</span>
            {pickerStep === 'model' && (
              <button
                onClick={() => setPickerStep('provider')}
                className="text-text-secondary hover:text-text-primary"
              >
                {t('common.back')}
              </button>
            )}
          </div>

          <div className="max-h-56 overflow-y-auto py-1">
            {pickerStep === 'provider' && enabledProviders.map((p) => (
              <button
                key={p.id}
                onClick={() => handlePickProvider(p.id)}
                className="w-full text-left px-2 py-1.5 text-[11px] text-text-primary hover:bg-bg-hover transition-colors"
              >
                {p.displayName || p.name}
              </button>
            ))}

            {pickerStep === 'model' && draftProviderModels.map((m) => {
              const caps = (() => { try { return JSON.parse(m.capabilities || '{}') } catch { return {} } })()
              return (
                <button
                  key={m.id}
                  onClick={() => { void handlePickModel(m.modelId) }}
                  className="w-full text-left px-2 py-1.5 hover:bg-bg-hover transition-colors flex items-center gap-1.5"
                >
                  <span className="text-[11px] text-text-primary truncate">{m.modelId}</span>
                  <div className="flex items-center gap-0.5 shrink-0 ml-auto">
                    {caps.vision && <span className="px-1 py-0.5 text-[8px] rounded bg-blue-500/20 text-blue-400">Vision</span>}
                    {caps.functionCalling && <span className="px-1 py-0.5 text-[8px] rounded bg-green-500/20 text-green-400">Tools</span>}
                    {caps.reasoning && <span className="px-1 py-0.5 text-[8px] rounded bg-purple-500/20 text-purple-400">Reasoning</span>}
                    {caps.imageOutput && <span className="px-1 py-0.5 text-[8px] rounded bg-orange-500/20 text-orange-400">ImgOut</span>}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
