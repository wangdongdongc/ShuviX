import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'framer-motion'
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
import { API_PROTOCOL_OPTIONS } from '../../../../shared/types/provider'
import { useSettingsStore } from '../../stores/settingsStore'
import { AddProviderDialog } from './AddProviderDialog'
import { ModelCapabilitiesDialog } from './ModelCapabilitiesDialog'
import { ProviderIcon } from './ProviderIcons'
import { ConfirmDialog } from '../common/ConfirmDialog'

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
        customHeaders?: string // 存入 metadata.customHeaders
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
  const [deletingProviderId, setDeletingProviderId] = useState<string | null>(null)
  const [editingModel, setEditingModel] = useState<{
    id: string
    providerId: string
    modelId: string
    caps: Record<string, unknown>
  } | null>(null)

  /** 初始加载已开启提供商的模型列表（用于警告图标判断） */
  useEffect(() => {
    const enabledIds = providers.filter((p) => p.isEnabled).map((p) => p.id)
    const missing = enabledIds.filter((id) => !providerModels[id])
    if (missing.length === 0) return
    Promise.all(
      missing.map((id) => window.api.provider.listModels(id).then((m) => [id, m] as const))
    )
      .then((results) => {
        setProviderModels((prev) => {
          const next = { ...prev }
          for (const [id, models] of results) next[id] = models
          return next
        })
      })
      .catch(() => {})
  }, [providers]) // eslint-disable-line react-hooks/exhaustive-deps

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
    field: 'name' | 'apiKey' | 'baseUrl' | 'apiProtocol' | 'customHeaders',
    value: string
  ): void => {
    setLocalEdits((prev) => ({
      ...prev,
      [providerId]: { ...prev[providerId], [field]: value }
    }))
  }

  /** 从 provider.metadata JSON 中提取 customHeaders 字符串 */
  const getCustomHeaders = (provider: ProviderInfo): string => {
    try {
      const meta = JSON.parse(provider.metadata || '{}')
      return meta.customHeaders ? JSON.stringify(meta.customHeaders, null, 2) : '{}'
    } catch {
      return '{}'
    }
  }

  /** 将 customHeaders 字符串合并回 metadata JSON */
  const buildMetadata = (provider: ProviderInfo, customHeadersStr: string): string => {
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(provider.metadata || '{}')
    } catch {
      // ignore
    }
    try {
      meta.customHeaders = JSON.parse(customHeadersStr)
    } catch {
      meta.customHeaders = {}
    }
    return JSON.stringify(meta)
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
    if (edits.customHeaders !== undefined && edits.customHeaders !== getCustomHeaders(provider))
      return true
    return false
  }

  /** 保存单个提供商配置，可选同时开启 */
  const handleSaveProvider = async (providerId: string, alsoEnable?: boolean): Promise<void> => {
    const edits = localEdits[providerId]
    const provider = providers.find((p) => p.id === providerId)
    if (!edits || !provider) return
    const updates: {
      name?: string
      apiKey?: string
      baseUrl?: string
      apiProtocol?: ProviderInfo['apiProtocol']
      metadata?: string
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
    if (edits.customHeaders !== undefined && edits.customHeaders !== getCustomHeaders(provider)) {
      updates.metadata = buildMetadata(provider, edits.customHeaders)
    }
    if (Object.keys(updates).length > 0) {
      await window.api.provider.updateConfig({ id: providerId, ...updates })
    }
    if (alsoEnable) {
      await window.api.provider.toggleEnabled({ id: providerId, isEnabled: true })
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
    metadata?: string
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
      <div className="flex-1 px-5 py-5 space-y-1.5 overflow-y-auto">
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

        {[...providers]
          .sort((a, b) => {
            // 自定义在前，内置在后
            if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? 1 : -1
            // 同组内已启用排前面
            if (a.isEnabled !== b.isEnabled) return a.isEnabled ? -1 : 1
            return 0
          })
          .map((p) => {
            const isExpanded = expandedProvider === p.id
            const edits = localEdits[p.id] || {}
            const models = providerModels[p.id] || []
            const query = (modelSearch[p.id] || '').trim().toLowerCase()
            const sortedModels = [...models].sort((a, b) => b.isEnabled - a.isEnabled)
            const filteredModels = query
              ? sortedModels.filter((m) => m.modelId.toLowerCase().includes(query))
              : sortedModels

            return (
              <motion.div
                key={p.id}
                layout="position"
                transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                className="border border-border-secondary rounded-lg overflow-hidden"
              >
                {/* 提供商头部 */}
                <div
                  onClick={() => handleToggleExpand(p.id)}
                  className="flex items-center gap-3 px-3 py-2 bg-bg-primary/30 cursor-pointer hover:bg-bg-hover/50 transition-colors"
                >
                  <span className="text-text-tertiary">
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </span>
                  <span className="flex-1 min-w-0 flex items-center gap-1.5">
                    <ProviderIcon name={p.name} />
                    <span className="text-xs font-medium text-text-primary shrink-0">
                      {p.displayName || p.name}
                    </span>
                    {p.baseUrl && (
                      <span className="text-[10px] text-text-tertiary font-normal truncate">
                        {p.baseUrl.replace(/^https?:\/\//, '')}
                      </span>
                    )}
                  </span>
                  {/* 删除自定义提供商 */}
                  {!p.isBuiltin && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeletingProviderId(p.id)
                      }}
                      className="p-1 rounded text-text-tertiary hover:text-error hover:bg-error/10 transition-colors mr-1"
                      title={t('settings.deleteProvider')}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                  {/* 无启用模型警告 */}
                  {!!p.isEnabled &&
                    providerModels[p.id] &&
                    !providerModels[p.id].some((m) => m.isEnabled) && (
                      <span className="text-[10px] text-amber-500 shrink-0 mr-1">
                        {t('settings.noEnabledModels')}
                      </span>
                    )}
                  {/* 启用/禁用开关 */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleToggleProvider(p.id, !p.isEnabled)
                    }}
                    className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${
                      p.isEnabled ? 'bg-accent' : 'bg-bg-tertiary'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
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
                          className="zen-input"
                        />
                      </div>
                    )}
                    {/* API Key */}
                    <div>
                      <label className="block text-[11px] text-text-tertiary mb-1">API Key</label>
                      <div className="zen-input-group">
                        <input
                          type={showKeys[p.id] ? 'text' : 'password'}
                          value={edits.apiKey ?? p.apiKey}
                          onChange={(e) => updateLocalEdit(p.id, 'apiKey', e.target.value)}
                          placeholder={t('settings.apiKeyPlaceholder', {
                            name: p.displayName || p.name
                          })}
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
                        className="zen-input"
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
                          className="zen-select"
                        >
                          {API_PROTOCOL_OPTIONS.map((p) => (
                            <option key={p.value} value={p.value}>
                              {t(p.labelKey)}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* 自定义提供商：自定义请求头 */}
                    {!p.isBuiltin && (
                      <div>
                        <label className="block text-[11px] text-text-tertiary mb-1">
                          {t('settings.customHeaders')}
                        </label>
                        <textarea
                          value={edits.customHeaders ?? getCustomHeaders(p)}
                          onChange={(e) => updateLocalEdit(p.id, 'customHeaders', e.target.value)}
                          placeholder={t('settings.customHeadersPlaceholder')}
                          rows={3}
                          className="zen-input font-mono text-[11px] resize-y"
                        />
                      </div>
                    )}

                    {/* 保存按钮 */}
                    {(hasEdits(p.id) || savedIds.has(p.id)) && (
                      <button
                        onClick={() => handleSaveProvider(p.id, !p.isEnabled || undefined)}
                        disabled={savedIds.has(p.id) || !hasEdits(p.id)}
                        className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                          savedIds.has(p.id)
                            ? 'bg-success/20 text-success'
                            : !p.isEnabled
                              ? 'bg-green-600 text-white hover:bg-green-500'
                              : 'bg-accent text-white hover:bg-accent-hover'
                        }`}
                      >
                        <Save size={14} />
                        {savedIds.has(p.id)
                          ? t('settings.saved')
                          : !p.isEnabled
                            ? t('settings.saveConfigAndEnable')
                            : t('settings.saveConfig')}
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
                      <div className="flex items-center gap-2 mb-2">
                        <input
                          type="text"
                          value={newModelId[p.id] || ''}
                          onChange={(e) =>
                            setNewModelId((prev) => ({ ...prev, [p.id]: e.target.value }))
                          }
                          onKeyDown={(e) => e.key === 'Enter' && handleAddModel(p.id)}
                          placeholder={t('settings.addModelPlaceholder')}
                          className="zen-input flex-1 font-mono text-[11px]"
                        />
                        <button
                          onClick={() => handleAddModel(p.id)}
                          disabled={!newModelId[p.id]?.trim()}
                          className="px-2 py-1.5 text-[10px] rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          {t('common.add')}
                        </button>
                      </div>

                      <input
                        type="text"
                        value={modelSearch[p.id] || ''}
                        onChange={(e) =>
                          setModelSearch((prev) => ({ ...prev, [p.id]: e.target.value }))
                        }
                        placeholder={t('settings.searchModel')}
                        className="zen-input mb-2 text-[11px]"
                      />

                      <div className="space-y-1 max-h-60 overflow-y-auto">
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
                                  className="p-0.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
                                  title={t('settings.editCapabilities')}
                                >
                                  <SlidersHorizontal size={12} />
                                </button>
                                {/* 删除模型 */}
                                <button
                                  onClick={() => handleDeleteModel(m.id, p.id)}
                                  className="p-0.5 rounded text-text-tertiary hover:text-error hover:bg-error/10 transition-colors"
                                  title={t('settings.deleteModel')}
                                >
                                  <X size={12} />
                                </button>
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
              </motion.div>
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

      {/* 删除提供商确认弹窗 */}
      {deletingProviderId && (
        <ConfirmDialog
          title={t('settings.deleteProviderConfirm', {
            name:
              providers.find((p) => p.id === deletingProviderId)?.displayName ||
              providers.find((p) => p.id === deletingProviderId)?.name ||
              ''
          })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={async () => {
            await handleDeleteProvider(deletingProviderId)
            setDeletingProviderId(null)
          }}
          onCancel={() => setDeletingProviderId(null)}
        />
      )}
    </div>
  )
}
