import { useRef, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Search } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useClickOutside } from '../../hooks/useClickOutside'
import type { ThinkingLevel } from '../../../../main/types'

/**
 * 模型选择器 — 展开式供应商列表，支持搜索过滤模型名
 * 选择后自动切换 Agent 模型并持久化到会话
 */
export function ModelPicker(): React.JSX.Element {
  const { t } = useTranslation()
  const {
    activeSessionId,
    setSessions,
    setModelSupportsReasoning,
    setThinkingLevel,
    setModelSupportsVision
  } = useChatStore()
  const {
    availableModels,
    providers,
    activeProvider,
    activeModel,
    setActiveProvider,
    setActiveModel
  } = useSettingsStore()

  const pickerRef = useRef<HTMLDivElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // 展开的供应商 ID 集合（默认展开当前选中的供应商）
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(
    () => new Set([activeProvider])
  )

  const closePicker = useCallback(() => {
    setPickerOpen(false)
    setSearchQuery('')
  }, [])

  useClickOutside(pickerRef, closePicker, pickerOpen)

  // 已启用 provider 列表
  const enabledProviders = useMemo(() => providers.filter((p) => p.isEnabled), [providers])

  // 按供应商分组并过滤模型
  const providerModelsMap = useMemo(() => {
    const map = new Map<string, typeof availableModels>()
    enabledProviders.forEach((p) => {
      const models = availableModels.filter(
        (m) => m.providerId === p.id && m.modelId.toLowerCase().includes(searchQuery.toLowerCase())
      )
      map.set(p.id, models)
    })
    return map
  }, [enabledProviders, availableModels, searchQuery])

  /** 打开/关闭选择器 */
  const togglePicker = (): void => {
    if (pickerOpen) {
      closePicker()
      return
    }
    // 打开时重置展开状态：只展开当前选中的供应商
    setExpandedProviders(new Set([activeProvider]))
    setSearchQuery('')
    setPickerOpen(true)
  }

  /** 切换供应商展开/收起 */
  const toggleProviderExpand = (providerId: string): void => {
    setExpandedProviders((prev) => {
      const next = new Set(prev)
      if (next.has(providerId)) {
        next.delete(providerId)
      } else {
        next.add(providerId)
      }
      return next
    })
  }

  /** 确认模型并提交 provider/model 切换 */
  const handlePickModel = async (providerId: string, modelId: string): Promise<void> => {
    setActiveProvider(providerId)
    setActiveModel(modelId)

    // 会话级持久化
    if (activeSessionId) {
      await window.api.session.updateModelConfig({
        id: activeSessionId,
        provider: providerId,
        model: modelId
      })
      const sessions = await window.api.session.list()
      setSessions(sessions)
    }

    const providerInfo = providers.find((p) => p.id === providerId)
    if (activeSessionId) {
      await window.api.agent.setModel({
        sessionId: activeSessionId,
        provider: providerId,
        model: modelId,
        baseUrl: providerInfo?.baseUrl || undefined,
        apiProtocol: providerInfo?.apiProtocol || undefined
      })
    }

    // 根据新模型能力更新状态
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
    const hasReasoning = !!caps.reasoning
    setModelSupportsReasoning(hasReasoning)
    setModelSupportsVision(!!caps.vision)
    useChatStore.getState().setMaxContextTokens(caps.maxInputTokens || 0)
    useChatStore.getState().setUsedContextTokens(null)
    const newLevel = hasReasoning ? 'medium' : 'off'
    setThinkingLevel(newLevel)
    if (activeSessionId) {
      await window.api.agent.setThinkingLevel({
        sessionId: activeSessionId,
        level: newLevel as ThinkingLevel
      })
      await window.api.session.updateModelMetadata({
        id: activeSessionId,
        modelMetadata: JSON.stringify({ thinkingLevel: newLevel })
      })
    }

    closePicker()
  }

  return (
    <div ref={pickerRef} className="relative flex items-center group">
      <button
        onClick={togglePicker}
        className="inline-flex items-center gap-1 text-[11px] text-blue-400/70 hover:text-blue-400 transition-colors"
      >
        <span className="max-w-[120px] truncate">{activeModel}</span>
        <ChevronDown size={11} />
      </button>

      {/* 悬浮 tooltip：完整模型名（展开时不显示） */}
      {!pickerOpen && (
        <div className="pointer-events-none absolute left-0 bottom-6 z-20 hidden rounded-md border border-border-primary bg-bg-secondary px-2 py-1 shadow-xl group-hover:block">
          <div className="text-[11px] text-text-primary whitespace-nowrap">{activeModel}</div>
        </div>
      )}

      {pickerOpen && (
        <div className="absolute left-0 bottom-8 w-[320px] rounded-lg border border-border-primary bg-bg-secondary shadow-2xl overflow-hidden flex flex-col">
          {/* 搜索框 */}
          <div className="px-2 py-2 border-b border-border-secondary">
            <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-bg-primary border border-border-primary">
              <Search size={12} className="text-text-tertiary" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('input.searchModel') || 'Search models...'}
                className="flex-1 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
              />
            </div>
          </div>

          {/* 供应商列表 */}
          <div className="max-h-64 overflow-y-auto">
            {enabledProviders.map((provider) => {
              const models = providerModelsMap.get(provider.id) || []
              // 搜索模式下：如果有匹配模型，自动展开；无匹配则跳过整个供应商
              const hasMatchingModels = models.length > 0
              if (searchQuery && !hasMatchingModels) return null

              const isExpanded = expandedProviders.has(provider.id)
              const isActiveProvider = provider.id === activeProvider

              return (
                <div key={provider.id} className="border-b border-border-secondary last:border-b-0">
                  {/* 供应商标题（可点击展开/收起） */}
                  <button
                    onClick={() => toggleProviderExpand(provider.id)}
                    className={`w-full flex items-center justify-between px-3 py-2 text-[11px] transition-colors ${
                      isActiveProvider
                        ? 'bg-accent/10 text-accent'
                        : 'text-text-primary hover:bg-bg-hover'
                    }`}
                  >
                    <span className="font-medium">{provider.displayName || provider.name}</span>
                    <span className="text-text-tertiary">
                      {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </span>
                  </button>

                  {/* 展开的模型列表 */}
                  {isExpanded && (
                    <div className="py-1">
                      {models.length === 0 ? (
                        <div className="px-3 py-2 text-[10px] text-text-tertiary italic">
                          {searchQuery
                            ? t('input.noModelMatch') || 'No matching models'
                            : t('input.noModels') || 'No models available'}
                        </div>
                      ) : (
                        models.map((m) => {
                          const caps = (() => {
                            try {
                              return JSON.parse(m.capabilities || '{}')
                            } catch {
                              return {}
                            }
                          })()
                          const isSelected =
                            provider.id === activeProvider && m.modelId === activeModel
                          return (
                            <button
                              key={m.id}
                              onClick={() => {
                                void handlePickModel(provider.id, m.modelId)
                              }}
                              className={`w-full text-left px-3 py-1.5 transition-colors flex items-center gap-1.5 ${
                                isSelected
                                  ? 'bg-accent/20 text-accent'
                                  : 'text-text-primary hover:bg-bg-hover'
                              }`}
                            >
                              <span
                                className={`text-[11px] truncate flex-1 ${isSelected ? 'font-medium' : ''}`}
                              >
                                {m.modelId}
                              </span>
                              <div className="flex items-center gap-0.5 shrink-0">
                                {caps.vision && (
                                  <span className="px-1 py-0.5 text-[8px] rounded bg-blue-500/20 text-blue-400">
                                    Vision
                                  </span>
                                )}
                                {caps.functionCalling && (
                                  <span className="px-1 py-0.5 text-[8px] rounded bg-green-500/20 text-green-400">
                                    Tools
                                  </span>
                                )}
                                {caps.reasoning && (
                                  <span className="px-1 py-0.5 text-[8px] rounded bg-purple-500/20 text-purple-400">
                                    Reasoning
                                  </span>
                                )}
                                {caps.imageOutput && (
                                  <span className="px-1 py-0.5 text-[8px] rounded bg-orange-500/20 text-orange-400">
                                    ImgOut
                                  </span>
                                )}
                              </div>
                            </button>
                          )
                        })
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
