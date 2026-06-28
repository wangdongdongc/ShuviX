import { getHostApi, useChatHost } from '@shuvix/chat-ui'
import { useRef, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronUp,
  Search,
  Eye,
  Wrench,
  Brain,
  Image as ImageIcon,
  Mic,
  Settings
} from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useModelCatalogStore } from '../../stores/modelCatalogStore'
import { useClickOutside } from '../../hooks/useClickOutside'
import { ProviderIcon } from '../settings/ProviderIcons'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'

interface ModelPickerProps {
  /** 只读模式：仅显示当前模型名，不可点击选择 */
  readonly?: boolean
}

/**
 * 模型选择器 — 展开式供应商列表，支持搜索过滤模型名
 * 选择后自动切换 Agent 模型并持久化到会话
 */
export function ModelPicker({ readonly: isReadonly }: ModelPickerProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const {
    activeSessionId,
    setSessions,
    modelSupportsReasoning,
    setModelSupportsReasoning,
    thinkingLevel,
    setThinkingLevel,
    setModelSupportsVision
  } = useChatStore()

  const thinkingLevels = [
    { value: 'off', label: t('input.thinkOff') },
    { value: 'low', label: t('input.thinkLow') },
    { value: 'medium', label: t('input.thinkMedium') },
    { value: 'high', label: t('input.thinkHigh') },
    { value: 'xhigh', label: t('input.thinkXHigh') }
  ]

  /** 切换思考深度 */
  const handleSetThinkingLevel = async (level: string): Promise<void> => {
    const host = getHostApi()
    if (!host) return // 渠道端无权改会话配置（ModelPicker 已隐藏，双保险）
    setThinkingLevel(level)
    if (activeSessionId) {
      await host.agent.setThinkingLevel({
        sessionId: activeSessionId,
        level: level as ThinkingLevel
      })
      await host.session.updateThinkingLevel({
        id: activeSessionId,
        thinkingLevel: level
      })
    }
  }
  // 目录(providers/availableModels)来自共享 modelCatalogStore；当前选中来自 ChatHost
  const providers = useModelCatalogStore((s) => s.providers)
  const availableModels = useModelCatalogStore((s) => s.availableModels)
  const { activeProvider, activeModel, setActiveProvider, setActiveModel } = useChatHost().models

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
    const host = getHostApi()
    if (!host) return // 渠道端无权切换模型（ModelPicker 已隐藏，双保险）
    setActiveProvider(providerId)
    setActiveModel(modelId)

    // 会话级持久化
    if (activeSessionId) {
      await host.session.updateModelConfig({
        id: activeSessionId,
        provider: providerId,
        model: modelId
      })
      const sessions = await host.session.list()
      setSessions(sessions)
    }

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
      await host.agent.setThinkingLevel({
        sessionId: activeSessionId,
        level: newLevel as ThinkingLevel
      })
      await host.session.updateThinkingLevel({
        id: activeSessionId,
        thinkingLevel: newLevel
      })
    }

    closePicker()
  }

  // 无任何已启用的提供商：以异常色按钮提示去配置（仅宿主可配置；渠道端只读时不显示，
  // 落到下方 readonly 分支展示当前模型名即可）
  if (enabledProviders.length === 0 && !isReadonly) {
    return (
      <button
        onClick={() => getHostApi()?.app.openSettings('providers')}
        className="inline-flex items-center gap-1 text-[11px] text-error bg-error/10 hover:bg-error/20 rounded px-1.5 py-0.5 transition-colors"
      >
        <Settings size={11} />
        <span>{t('settings.providerSectionTitle')}</span>
      </button>
    )
  }

  const noModelSelected = !activeModel

  return (
    <div ref={pickerRef} className="relative flex items-center group">
      {isReadonly ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-text-tertiary cursor-default">
          {noModelSelected ? (
            <span className="text-amber-500">{t('input.selectModel')}</span>
          ) : (
            <>
              <span className="max-w-[120px] truncate">{activeModel}</span>
              {modelSupportsReasoning && thinkingLevel !== 'off' && <Brain size={10} />}
            </>
          )}
        </span>
      ) : (
        <button
          onClick={togglePicker}
          className={`inline-flex items-center gap-1 text-[11px] rounded px-1.5 py-0.5 transition-colors border border-transparent ${
            noModelSelected
              ? 'text-amber-500 hover:text-amber-400'
              : 'text-text-tertiary hover:text-text-secondary hover:border-border-secondary'
          }`}
        >
          {noModelSelected ? (
            <span>{t('input.selectModel')}</span>
          ) : (
            <>
              <span className="max-w-[120px] truncate">{activeModel}</span>
              {modelSupportsReasoning && thinkingLevel !== 'off' && <Brain size={10} />}
            </>
          )}
          <ChevronDown size={11} />
        </button>
      )}

      {/* 悬浮 tooltip：完整模型名（展开时 / 未选择模型时不显示） */}
      {!pickerOpen && !noModelSelected && (
        <div className="pointer-events-none absolute left-0 bottom-6 z-20 hidden rounded-md border border-border-primary bg-bg-secondary px-2 py-1 shadow-xl group-hover:block">
          <div className="text-[11px] text-text-primary whitespace-nowrap">{activeModel}</div>
        </div>
      )}

      {!isReadonly && pickerOpen && (
        <div className="picker-panel absolute left-0 bottom-8 w-[300px] rounded-md border border-border-primary bg-bg-secondary shadow-lg overflow-hidden flex flex-col">
          {/* 搜索框 */}
          <div className="px-2 py-1.5 border-b border-border-secondary">
            <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-bg-primary border border-border-secondary">
              <Search size={11} className="text-text-tertiary" />
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
          <div className="max-h-64 overflow-y-auto py-1">
            {enabledProviders.map((provider) => {
              const models = providerModelsMap.get(provider.id) || []
              // 搜索模式下：如果有匹配模型，自动展开；无匹配则跳过整个供应商
              const hasMatchingModels = models.length > 0
              if (searchQuery && !hasMatchingModels) return null

              const isExpanded = expandedProviders.has(provider.id)
              const isActiveProvider = provider.id === activeProvider

              return (
                <div key={provider.id}>
                  {/* 供应商标题（可点击展开/收起） */}
                  <button
                    onClick={() => toggleProviderExpand(provider.id)}
                    className={`w-full flex items-center gap-1.5 px-2.5 py-1 text-[11px] transition-colors hover:bg-bg-hover ${
                      isActiveProvider ? 'text-text-primary font-medium' : 'text-text-secondary'
                    }`}
                  >
                    <ProviderIcon name={provider.name} />
                    <span className="truncate flex-1 text-left">
                      {provider.displayName || provider.name}
                    </span>
                    <span className="text-text-tertiary flex-shrink-0">
                      {isExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                    </span>
                  </button>

                  {/* 展开的模型列表 */}
                  {isExpanded && (
                    <div>
                      {models.length === 0 ? (
                        <div className="pl-5 pr-2.5 py-1 text-[10px] text-text-tertiary italic">
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
                              className={`w-full text-left pl-5 pr-2.5 py-1 transition-colors flex items-center gap-1.5 hover:bg-bg-hover ${
                                isSelected
                                  ? 'bg-bg-hover text-text-primary font-medium'
                                  : 'text-text-secondary hover:text-text-primary'
                              }`}
                            >
                              <span className="text-[11px] truncate flex-1">{m.modelId}</span>
                              <div className="flex items-center gap-1 shrink-0 text-text-tertiary">
                                {caps.vision && <Eye size={10} />}
                                {caps.functionCalling && <Wrench size={10} />}
                                {caps.reasoning && <Brain size={10} />}
                                {caps.imageOutput && <ImageIcon size={10} />}
                                {caps.audioInput && <Mic size={10} />}
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

          {/* 思考深度（仅在当前模型支持 reasoning 时显示） */}
          {modelSupportsReasoning && (
            <div className="flex items-center gap-1 border-t border-border-secondary px-2 py-1.5">
              <Brain size={11} className="text-text-tertiary flex-shrink-0" />
              <div className="flex items-center gap-0.5 flex-1">
                {thinkingLevels.map((l) => (
                  <button
                    key={l.value}
                    onClick={() => {
                      void handleSetThinkingLevel(l.value)
                    }}
                    className={`flex-1 text-[10px] px-1 py-0.5 rounded transition-colors ${
                      thinkingLevel === l.value
                        ? 'bg-bg-hover text-text-primary font-medium'
                        : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'
                    }`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
