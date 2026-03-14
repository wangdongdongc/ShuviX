import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Eye,
  EyeOff,
  Save,
  ChevronDown,
  ChevronRight,
  Trash2,
  Plus,
  X,
  SlidersHorizontal,
  TriangleAlert
} from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { AddProviderDialog } from './AddProviderDialog'
import { ModelCapabilitiesDialog } from './ModelCapabilitiesDialog'

/** 提供商设置 */
export function ProviderSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const { providers, setProviders, setAvailableModels } = useSettingsStore()
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})
  const [localEdits, setLocalEdits] = useState<
    Record<
      string,
      {
        name?: string
        apiKey?: string
        baseUrl?: string
        apiProtocol?: ProviderInfo['apiProtocol']
      }
    >
  >({})
  const [providerModels, setProviderModels] = useState<Record<string, ProviderModelInfo[]>>({})
  const [modelSearch, setModelSearch] = useState<Record<string, string>>({})
  const [syncingProviderId, setSyncingProviderId] = useState<string | null>(null)
  const [syncMessages, setSyncMessages] = useState<Record<string, string>>({})
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [newModelId, setNewModelId] = useState<Record<string, string>>({})
  const [editingModel, setEditingModel] = useState<{
    id: string
    providerId: string
    modelId: string
    caps: Record<string, unknown>
  } | null>(null)

  /** 展开提供商时加载其模型列表 */
  const handleToggleExpand = async (providerId: string): Promise<void> => {
    if (expandedProvider === providerId) {
      setExpandedProvider(null)
      return
    }
    setExpandedProvider(providerId)
    if (!providerModels[providerId]) {
      const models = await window.api.provider.listModels(providerId)
      setProviderModels((prev) => ({ ...prev, [providerId]: models }))
    }
  }

  /** 切换提供商启用/禁用 */
  const handleToggleProvider = async (providerId: string, isEnabled: boolean): Promise<void> => {
    await window.api.provider.toggleEnabled({ id: providerId, isEnabled })
    // 刷新列表
    const updated = await window.api.provider.listAll()
    setProviders(updated)
    const available = await window.api.provider.listAvailableModels()
    setAvailableModels(available)
  }

  /** 切换模型启用/禁用 */
  const handleToggleModel = async (
    modelId: string,
    providerId: string,
    isEnabled: boolean
  ): Promise<void> => {
    await window.api.provider.toggleModelEnabled({ id: modelId, isEnabled })
    // 刷新该提供商的模型列表
    const models = await window.api.provider.listModels(providerId)
    setProviderModels((prev) => ({ ...prev, [providerId]: models }))
    const available = await window.api.provider.listAvailableModels()
    setAvailableModels(available)
  }

  /** 更新本地编辑状态 */
  const updateLocalEdit = (
    providerId: string,
    field: 'name' | 'apiKey' | 'baseUrl' | 'apiProtocol',
    value: string
  ): void => {
    setLocalEdits((prev) => ({
      ...prev,
      [providerId]: { ...prev[providerId], [field]: value }
    }))
  }

  /** 判断指定 provider 是否有真正变更 */
  const hasEdits = (providerId: string): boolean => {
    const edits = localEdits[providerId]
    if (!edits) return false
    const provider = providers.find((p) => p.id === providerId)
    if (!provider) return false
    if (edits.name !== undefined && edits.name !== provider.name) return true
    if (edits.apiKey !== undefined && edits.apiKey !== provider.apiKey) return true
    if (edits.baseUrl !== undefined && edits.baseUrl !== provider.baseUrl) return true
    if (edits.apiProtocol !== undefined && edits.apiProtocol !== provider.apiProtocol) return true
    return false
  }

  /** 保存单个提供商配置 */
  const handleSaveProvider = async (providerId: string): Promise<void> => {
    const edits = localEdits[providerId]
    const provider = providers.find((p) => p.id === providerId)
    if (!edits || !provider) return
    const updates: {
      name?: string
      apiKey?: string
      baseUrl?: string
      apiProtocol?: ProviderInfo['apiProtocol']
    } = {}
    if (edits.name !== undefined && edits.name !== provider.name) {
      updates.name = edits.name
    }
    if (edits.apiKey !== undefined && edits.apiKey !== provider.apiKey) {
      updates.apiKey = edits.apiKey
    }
    if (edits.baseUrl !== undefined && edits.baseUrl !== provider.baseUrl) {
      updates.baseUrl = edits.baseUrl
    }
    if (edits.apiProtocol !== undefined && edits.apiProtocol !== provider.apiProtocol) {
      updates.apiProtocol = edits.apiProtocol
    }
    if (Object.keys(updates).length > 0) {
      await window.api.provider.updateConfig({ id: providerId, ...updates })
    }
    // 刷新
    const updated = await window.api.provider.listAll()
    setProviders(updated)
    setLocalEdits((prev) => {
      const next = { ...prev }
      delete next[providerId]
      return next
    })
    setSavedIds((prev) => new Set(prev).add(providerId))
    setTimeout(() => {
      setSavedIds((prev) => {
        const next = new Set(prev)
        next.delete(providerId)
        return next
      })
    }, 2000)
  }

  /** 添加自定义提供商（由 AddProviderDialog 回调） */
  const handleAddProvider = async (provider: {
    name: string
    baseUrl: string
    apiKey: string
    apiProtocol: ProviderInfo['apiProtocol']
  }): Promise<void> => {
    await window.api.provider.add(provider)
    const updated = await window.api.provider.listAll()
    setProviders(updated)
    const available = await window.api.provider.listAvailableModels()
    setAvailableModels(available)
  }

  /** 删除自定义提供商 */
  const handleDeleteProvider = async (providerId: string): Promise<void> => {
    await window.api.provider.delete({ id: providerId })
    const updated = await window.api.provider.listAll()
    setProviders(updated)
    const available = await window.api.provider.listAvailableModels()
    setAvailableModels(available)
    if (expandedProvider === providerId) setExpandedProvider(null)
  }

  /** 手动添加模型 */
  const handleAddModel = async (providerId: string): Promise<void> => {
    const modelId = newModelId[providerId]?.trim()
    if (!modelId) return
    await window.api.provider.addModel({ providerId, modelId })
    const models = await window.api.provider.listModels(providerId)
    setProviderModels((prev) => ({ ...prev, [providerId]: models }))
    const available = await window.api.provider.listAvailableModels()
    setAvailableModels(available)
    setNewModelId((prev) => ({ ...prev, [providerId]: '' }))
  }

  /** 删除模型 */
  const handleDeleteModel = async (modelId: string, providerId: string): Promise<void> => {
    await window.api.provider.deleteModel(modelId)
    const models = await window.api.provider.listModels(providerId)
    setProviderModels((prev) => ({ ...prev, [providerId]: models }))
    const available = await window.api.provider.listAvailableModels()
    setAvailableModels(available)
  }

  /**
   * 从提供商拉取并同步模型列表
   * 支持 OpenAI 兼容协议
   */
  const handleSyncModels = async (providerId: string): Promise<void> => {
    setSyncingProviderId(providerId)
    setSyncMessages((prev) => ({ ...prev, [providerId]: '' }))
    try {
      const result = await window.api.provider.syncModels({ providerId })
      const models = await window.api.provider.listModels(providerId)
      setProviderModels((prev) => ({ ...prev, [providerId]: models }))
      const available = await window.api.provider.listAvailableModels()
      setAvailableModels(available)
      setSyncMessages((prev) => ({
        ...prev,
        [providerId]: t('settings.syncSuccess', { total: result.total, added: result.added })
      }))
    } catch (err: unknown) {
      setSyncMessages((prev) => ({
        ...prev,
        [providerId]: err instanceof Error ? err.message : t('settings.syncFailed')
      }))
    } finally {
      setSyncingProviderId(null)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 px-5 py-5 space-y-2 overflow-y-auto">
        {/* Token 用量提示 */}
        <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
          <TriangleAlert size={14} className="text-amber-500 shrink-0 mt-0.5" />
          <p className="text-[11px] text-text-secondary leading-relaxed">
            {t('settings.tokenUsageWarning')}
          </p>
        </div>

        {/* 添加自定义提供商按钮 */}
        <button
          onClick={() => setShowAddDialog(true)}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-border-secondary text-xs text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
        >
          <Plus size={14} />
          {t('settings.addProvider')}
        </button>

        {/* 添加提供商弹窗 */}
        {showAddDialog && (
          <AddProviderDialog onAdd={handleAddProvider} onClose={() => setShowAddDialog(false)} />
        )}

        {providers.map((p) => {
          const isExpanded = expandedProvider === p.id
          const edits = localEdits[p.id] || {}
          const models = providerModels[p.id] || []
          const query = (modelSearch[p.id] || '').trim().toLowerCase()
          const filteredModels = query
            ? models.filter((m) => m.modelId.toLowerCase().includes(query))
            : models

          return (
            <div key={p.id} className="border border-border-secondary rounded-lg overflow-hidden">
              {/* 提供商头部 */}
              <div className="flex items-center gap-3 px-3 py-2.5 bg-bg-primary/30">
                <button
                  onClick={() => handleToggleExpand(p.id)}
                  className="text-text-tertiary hover:text-text-primary transition-colors"
                >
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <span className="flex-1 text-xs font-medium text-text-primary">
                  {p.isBuiltin ? (
                    <span className="mr-1 text-[10px] text-text-tertiary font-normal">
                      {t('settings.builtin')}
                    </span>
                  ) : null}
                  {p.displayName || p.name}
                </span>
                {/* 删除自定义提供商 */}
                {!p.isBuiltin && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteProvider(p.id)
                    }}
                    className="text-text-tertiary hover:text-danger transition-colors mr-1"
                    title={t('settings.deleteProvider')}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
                {/* 启用/禁用开关 */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleToggleProvider(p.id, !p.isEnabled)
                  }}
                  className={`w-8 h-4.5 rounded-full relative transition-colors ${
                    p.isEnabled ? 'bg-accent' : 'bg-bg-tertiary'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${
                      p.isEnabled ? 'left-[18px]' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>

              {/* 展开内容 */}
              {isExpanded && (
                <div className="px-4 py-3 space-y-3 border-t border-border-secondary">
                  {/* 自定义提供商：名称 */}
                  {!p.isBuiltin && (
                    <div>
                      <label className="block text-[11px] text-text-tertiary mb-1">
                        {t('settings.providerName')}
                      </label>
                      <input
                        type="text"
                        value={edits.name ?? p.name}
                        onChange={(e) => updateLocalEdit(p.id, 'name', e.target.value)}
                        placeholder={t('settings.providerNamePlaceholder')}
                        className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none transition-colors focus:border-accent/50"
                      />
                    </div>
                  )}
                  {/* API Key */}
                  <div>
                    <label className="block text-[11px] text-text-tertiary mb-1">API Key</label>
                    <div className="flex items-center bg-bg-tertiary border border-border-primary rounded-lg overflow-hidden focus-within:border-accent/50 transition-colors">
                      <input
                        type={showKeys[p.id] ? 'text' : 'password'}
                        value={edits.apiKey ?? p.apiKey}
                        onChange={(e) => updateLocalEdit(p.id, 'apiKey', e.target.value)}
                        placeholder={t('settings.apiKeyPlaceholder', {
                          name: p.displayName || p.name
                        })}
                        className="flex-1 bg-transparent px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none"
                      />
                      <button
                        onClick={() => setShowKeys((prev) => ({ ...prev, [p.id]: !prev[p.id] }))}
                        className="px-2 text-text-tertiary hover:text-text-secondary"
                      >
                        {showKeys[p.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>

                  {/* Base URL */}
                  <div>
                    <label className="block text-[11px] text-text-tertiary mb-1">Base URL</label>
                    <input
                      type="text"
                      value={edits.baseUrl ?? p.baseUrl}
                      onChange={(e) => updateLocalEdit(p.id, 'baseUrl', e.target.value)}
                      placeholder={t('settings.baseUrlPlaceholder')}
                      className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none transition-colors focus:border-accent/50"
                    />
                  </div>

                  {/* 自定义提供商：接口类型 */}
                  {!p.isBuiltin && (
                    <div>
                      <label className="block text-[11px] text-text-tertiary mb-1">
                        {t('settings.apiProtocol')}
                      </label>
                      <select
                        value={edits.apiProtocol ?? p.apiProtocol}
                        onChange={(e) => updateLocalEdit(p.id, 'apiProtocol', e.target.value)}
                        className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none cursor-pointer"
                      >
                        <option value="openai-completions">{t('settings.protocolOpenAI')}</option>
                        <option value="anthropic-messages">Anthropic Messages</option>
                        <option value="google-generative-ai">Google Generative AI</option>
                      </select>
                    </div>
                  )}

                  {/* 保存按钮 */}
                  {(hasEdits(p.id) || savedIds.has(p.id)) && (
                    <button
                      onClick={() => handleSaveProvider(p.id)}
                      disabled={savedIds.has(p.id) || !hasEdits(p.id)}
                      className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                        savedIds.has(p.id)
                          ? 'bg-success/20 text-success'
                          : 'bg-accent text-white hover:bg-accent-hover'
                      }`}
                    >
                      <Save size={14} />
                      {savedIds.has(p.id) ? t('settings.saved') : t('settings.saveConfig')}
                    </button>
                  )}

                  {/* 模型列表 */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="block text-[11px] text-text-tertiary">
                        {t('settings.modelManagement')}
                      </label>
                      <button
                        onClick={() => handleSyncModels(p.id)}
                        disabled={syncingProviderId === p.id}
                        className="px-2 py-1 text-[10px] rounded-md border border-border-primary text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                      >
                        {syncingProviderId === p.id
                          ? t('settings.syncing')
                          : t('settings.syncModels')}
                      </button>
                    </div>
                    {syncMessages[p.id] && (
                      <div className="text-[10px] text-text-tertiary mb-2">
                        {syncMessages[p.id]}
                      </div>
                    )}

                    {/* 手动添加模型 */}
                    {!p.isBuiltin && (
                      <div className="flex items-center gap-2 mb-2">
                        <input
                          type="text"
                          value={newModelId[p.id] || ''}
                          onChange={(e) =>
                            setNewModelId((prev) => ({ ...prev, [p.id]: e.target.value }))
                          }
                          onKeyDown={(e) => e.key === 'Enter' && handleAddModel(p.id)}
                          placeholder={t('settings.addModelPlaceholder')}
                          className="flex-1 bg-bg-tertiary border border-border-primary rounded-md px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 transition-colors font-mono"
                        />
                        <button
                          onClick={() => handleAddModel(p.id)}
                          disabled={!newModelId[p.id]?.trim()}
                          className="px-2 py-1.5 text-[10px] rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          {t('common.add')}
                        </button>
                      </div>
                    )}

                    <input
                      type="text"
                      value={modelSearch[p.id] || ''}
                      onChange={(e) =>
                        setModelSearch((prev) => ({ ...prev, [p.id]: e.target.value }))
                      }
                      placeholder={t('settings.searchModel')}
                      className="w-full mb-2 bg-bg-tertiary border border-border-primary rounded-md px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 transition-colors"
                    />

                    <div className="space-y-1">
                      {filteredModels.map((m) => {
                        const caps = (() => {
                          try {
                            return JSON.parse(m.capabilities || '{}')
                          } catch {
                            return {}
                          }
                        })()
                        return (
                          <div
                            key={m.id}
                            className="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-bg-hover transition-colors"
                          >
                            <div className="flex items-center gap-1.5 min-w-0 flex-1">
                              <span className="text-xs text-text-primary font-mono truncate">
                                {m.modelId}
                              </span>
                              {/* 能力标签 */}
                              <div className="flex items-center gap-1 shrink-0">
                                {caps.vision && (
                                  <span className="px-1 py-0.5 text-[9px] rounded bg-blue-500/20 text-blue-400">
                                    Vision
                                  </span>
                                )}
                                {caps.functionCalling && (
                                  <span className="px-1 py-0.5 text-[9px] rounded bg-green-500/20 text-green-400">
                                    Tools
                                  </span>
                                )}
                                {caps.reasoning && (
                                  <span className="px-1 py-0.5 text-[9px] rounded bg-purple-500/20 text-purple-400">
                                    Reasoning
                                  </span>
                                )}
                                {caps.imageOutput && (
                                  <span className="px-1 py-0.5 text-[9px] rounded bg-orange-500/20 text-orange-400">
                                    ImgOut
                                  </span>
                                )}
                                {caps.audioInput && (
                                  <span className="px-1 py-0.5 text-[9px] rounded bg-cyan-500/20 text-cyan-400">
                                    Audio
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5">
                              {/* 编辑能力 */}
                              <button
                                onClick={() =>
                                  setEditingModel({
                                    id: m.id,
                                    providerId: p.id,
                                    modelId: m.modelId,
                                    caps
                                  })
                                }
                                className="text-text-tertiary hover:text-text-secondary transition-colors"
                                title={t('settings.editCapabilities')}
                              >
                                <SlidersHorizontal size={12} />
                              </button>
                              {/* 自定义提供商的模型可删除 */}
                              {!p.isBuiltin && (
                                <button
                                  onClick={() => handleDeleteModel(m.id, p.id)}
                                  className="text-text-tertiary hover:text-danger transition-colors"
                                  title={t('settings.deleteModel')}
                                >
                                  <X size={12} />
                                </button>
                              )}
                              <button
                                onClick={() => handleToggleModel(m.id, p.id, !m.isEnabled)}
                                className={`w-7 h-4 rounded-full relative transition-colors ${
                                  m.isEnabled ? 'bg-accent' : 'bg-bg-tertiary'
                                }`}
                              >
                                <span
                                  className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                                    m.isEnabled ? 'left-[14px]' : 'left-0.5'
                                  }`}
                                />
                              </button>
                            </div>
                          </div>
                        )
                      })}
                      {filteredModels.length === 0 && (
                        <div className="px-2 py-2 text-[11px] text-text-tertiary">
                          {t('settings.noMatchingModels')}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* 模型能力编辑弹窗 */}
      {editingModel && (
        <ModelCapabilitiesDialog
          modelId={editingModel.modelId}
          capabilities={editingModel.caps}
          onSave={async (newCaps) => {
            await window.api.provider.updateModelCapabilities({
              id: editingModel.id,
              capabilities: newCaps
            })
            const models = await window.api.provider.listModels(editingModel.providerId)
            setProviderModels((prev) => ({ ...prev, [editingModel.providerId]: models }))
          }}
          onClose={() => setEditingModel(null)}
        />
      )}
    </div>
  )
}
