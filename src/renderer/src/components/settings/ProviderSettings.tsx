import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Eye,
  EyeOff,
  Save,
  Trash2,
  Plus,
  X,
  SlidersHorizontal,
  TriangleAlert,
  Wrench,
  Brain,
  Image as ImageIcon,
  Mic,
  AlertCircle
} from 'lucide-react'
import { API_PROTOCOL_OPTIONS } from '../../../../shared/types/provider'
import { useSettingsStore } from '../../stores/settingsStore'
import { AddProviderDialog } from './AddProviderDialog'
import { ModelCapabilitiesDialog } from './ModelCapabilitiesDialog'
import { ProviderIcon } from './ProviderIcons'
import { ConfirmDialog } from '../common/ConfirmDialog'
import {
  SettingsSection,
  SettingsRow,
  SettingsBlock,
  Toggle,
  InlineInput,
  InlineSelect
} from './SettingsPrimitives'

/** 提供商设置（双层结构：左侧提供商列表 + 右侧详情） */
export function ProviderSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const { providers, setProviders, setAvailableModels } = useSettingsStore()
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})
  const [localEdits, setLocalEdits] = useState<
    Record<
      string,
      {
        name?: string
        apiKey?: string
        baseUrl?: string
        apiProtocol?: ProviderInfo['apiProtocol']
        customHeaders?: string
      }
    >
  >({})
  const [providerModels, setProviderModels] = useState<Record<string, ProviderModelInfo[]>>({})
  const [modelSearch, setModelSearch] = useState<Record<string, string>>({})
  const [syncingProviderId, setSyncingProviderId] = useState<string | null>(null)
  const [syncMessages, setSyncMessages] = useState<
    Record<string, { text: string; isError: boolean }>
  >({})
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

  /** 排序：1) 已启用优先；2) 同组内自定义优先 */
  const sortedProviders = useMemo(
    () =>
      [...providers].sort((a, b) => {
        if (a.isEnabled !== b.isEnabled) return a.isEnabled ? -1 : 1
        if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? 1 : -1
        return 0
      }),
    [providers]
  )

  /** 加载某个 provider 的模型列表 */
  const loadModelsFor = useCallback(async (providerId: string): Promise<void> => {
    const models = await window.api.provider.listModels(providerId)
    setProviderModels((prev) => ({ ...prev, [providerId]: models }))
  }, [])

  /** 初始：预加载已启用 provider 的模型（用于无启用模型警告） */
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

  /** 默认选中第一个 provider */
  useEffect(() => {
    if (selectedProviderId) {
      const exists = providers.some((p) => p.id === selectedProviderId)
      if (exists) return
    }
    if (sortedProviders.length > 0) {
      setSelectedProviderId(sortedProviders[0].id)
    } else {
      setSelectedProviderId(null)
    }
  }, [providers, sortedProviders, selectedProviderId])

  /** 切换选中 provider（懒加载该 provider 模型列表） */
  const handleSelectProvider = (providerId: string): void => {
    setSelectedProviderId(providerId)
    if (!providerModels[providerId]) {
      void loadModelsFor(providerId)
    }
  }

  const handleToggleProvider = async (providerId: string, isEnabled: boolean): Promise<void> => {
    await window.api.provider.toggleEnabled({ id: providerId, isEnabled })
    const updated = await window.api.provider.listAll()
    setProviders(updated)
    const available = await window.api.provider.listAvailableModels()
    setAvailableModels(available)
  }

  const handleToggleModel = async (
    modelId: string,
    providerId: string,
    isEnabled: boolean
  ): Promise<void> => {
    await window.api.provider.toggleModelEnabled({ id: modelId, isEnabled })
    await loadModelsFor(providerId)
    const available = await window.api.provider.listAvailableModels()
    setAvailableModels(available)
  }

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

  const getCustomHeaders = (provider: ProviderInfo): string => {
    try {
      const meta = JSON.parse(provider.metadata || '{}')
      return meta.customHeaders ? JSON.stringify(meta.customHeaders, null, 2) : '{}'
    } catch {
      return '{}'
    }
  }

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

  const handleDeleteProvider = async (providerId: string): Promise<void> => {
    await window.api.provider.delete({ id: providerId })
    const updated = await window.api.provider.listAll()
    setProviders(updated)
    const available = await window.api.provider.listAvailableModels()
    setAvailableModels(available)
    if (selectedProviderId === providerId) {
      setSelectedProviderId(null)
    }
  }

  const handleAddModel = async (providerId: string): Promise<void> => {
    const modelId = newModelId[providerId]?.trim()
    if (!modelId) return
    await window.api.provider.addModel({ providerId, modelId })
    await loadModelsFor(providerId)
    const available = await window.api.provider.listAvailableModels()
    setAvailableModels(available)
    setNewModelId((prev) => ({ ...prev, [providerId]: '' }))
  }

  const handleDeleteModel = async (modelId: string, providerId: string): Promise<void> => {
    await window.api.provider.deleteModel(modelId)
    await loadModelsFor(providerId)
    const available = await window.api.provider.listAvailableModels()
    setAvailableModels(available)
  }

  const handleSyncModels = async (providerId: string): Promise<void> => {
    setSyncingProviderId(providerId)
    setSyncMessages((prev) => {
      const next = { ...prev }
      delete next[providerId]
      return next
    })
    try {
      const result = await window.api.provider.syncModels({ providerId })
      await loadModelsFor(providerId)
      const available = await window.api.provider.listAvailableModels()
      setAvailableModels(available)
      setSyncMessages((prev) => ({
        ...prev,
        [providerId]: {
          text: t('settings.syncSuccess', { total: result.total, added: result.added }),
          isError: false
        }
      }))
    } catch (err: unknown) {
      setSyncMessages((prev) => ({
        ...prev,
        [providerId]: {
          text: err instanceof Error ? err.message : t('settings.syncFailed'),
          isError: true
        }
      }))
    } finally {
      setSyncingProviderId(null)
    }
  }

  const selectedProvider = providers.find((p) => p.id === selectedProviderId) ?? null

  return (
    <div className="flex flex-1 min-h-0 h-full">
      {/* 左侧：提供商列表 */}
      <div className="w-[220px] flex-shrink-0 border-r border-border-secondary flex flex-col">
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {sortedProviders.map((p) => {
            const isSelected = selectedProviderId === p.id
            const hasModels = providerModels[p.id]
            const noEnabledModels =
              !!p.isEnabled && hasModels && !hasModels.some((m) => m.isEnabled)
            return (
              <button
                key={p.id}
                onClick={() => handleSelectProvider(p.id)}
                className={`group w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                  isSelected
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                } ${!p.isEnabled ? 'opacity-60' : ''}`}
              >
                <ProviderIcon name={p.name} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium truncate">{p.displayName || p.name}</div>
                </div>
                {noEnabledModels && (
                  <TriangleAlert
                    size={10}
                    className="text-amber-500 shrink-0"
                    aria-label={t('settings.noEnabledModels')}
                  />
                )}
                <span onClick={(e) => e.stopPropagation()} className="shrink-0">
                  <Toggle
                    on={!!p.isEnabled}
                    onClick={() => handleToggleProvider(p.id, !p.isEnabled)}
                  />
                </span>
              </button>
            )
          })}
        </div>
        {/* 添加自定义提供商 */}
        <div className="border-t border-border-secondary p-2">
          <button
            onClick={() => setShowAddDialog(true)}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg border border-dashed border-border-secondary text-[11px] text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
          >
            <Plus size={12} />
            {t('settings.addProvider')}
          </button>
        </div>
      </div>

      {/* 右侧：详情面板 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {selectedProvider ? (
          <ProviderDetail
            provider={selectedProvider}
            edits={localEdits[selectedProvider.id] || {}}
            models={providerModels[selectedProvider.id] || []}
            modelSearch={modelSearch[selectedProvider.id] || ''}
            newModelId={newModelId[selectedProvider.id] || ''}
            syncing={syncingProviderId === selectedProvider.id}
            syncMessage={syncMessages[selectedProvider.id] ?? null}
            showKey={!!showKeys[selectedProvider.id]}
            saved={savedIds.has(selectedProvider.id)}
            hasEdits={hasEdits(selectedProvider.id)}
            getCustomHeaders={getCustomHeaders}
            onToggleShowKey={() =>
              setShowKeys((prev) => ({
                ...prev,
                [selectedProvider.id]: !prev[selectedProvider.id]
              }))
            }
            onUpdateEdit={(field, value) => updateLocalEdit(selectedProvider.id, field, value)}
            onSave={() =>
              handleSaveProvider(selectedProvider.id, !selectedProvider.isEnabled || undefined)
            }
            onSetModelSearch={(v) =>
              setModelSearch((prev) => ({ ...prev, [selectedProvider.id]: v }))
            }
            onSetNewModelId={(v) =>
              setNewModelId((prev) => ({ ...prev, [selectedProvider.id]: v }))
            }
            onAddModel={() => handleAddModel(selectedProvider.id)}
            onSyncModels={() => handleSyncModels(selectedProvider.id)}
            onToggleModel={(modelId, isEnabled) =>
              handleToggleModel(modelId, selectedProvider.id, isEnabled)
            }
            onDeleteModel={(modelId) => handleDeleteModel(modelId, selectedProvider.id)}
            onEditModel={(model, caps) =>
              setEditingModel({
                id: model.id,
                providerId: selectedProvider.id,
                modelId: model.modelId,
                caps
              })
            }
            onDeleteProvider={() => setDeletingProviderId(selectedProvider.id)}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-text-tertiary text-[11px]">
            {t('settings.providerSectionTitle')}
          </div>
        )}
      </div>

      {/* 添加提供商弹窗 */}
      {showAddDialog && (
        <AddProviderDialog onAdd={handleAddProvider} onClose={() => setShowAddDialog(false)} />
      )}

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
            await loadModelsFor(editingModel.providerId)
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

// ────────────────────────────────────────────────────────────────
// 详情面板
// ────────────────────────────────────────────────────────────────

interface ProviderDetailProps {
  provider: ProviderInfo
  edits: {
    name?: string
    apiKey?: string
    baseUrl?: string
    apiProtocol?: ProviderInfo['apiProtocol']
    customHeaders?: string
  }
  models: ProviderModelInfo[]
  modelSearch: string
  newModelId: string
  syncing: boolean
  syncMessage: { text: string; isError: boolean } | null
  showKey: boolean
  saved: boolean
  hasEdits: boolean
  getCustomHeaders: (p: ProviderInfo) => string
  onToggleShowKey: () => void
  onUpdateEdit: (
    field: 'name' | 'apiKey' | 'baseUrl' | 'apiProtocol' | 'customHeaders',
    value: string
  ) => void
  onSave: () => void
  onSetModelSearch: (v: string) => void
  onSetNewModelId: (v: string) => void
  onAddModel: () => void
  onSyncModels: () => void
  onToggleModel: (modelId: string, isEnabled: boolean) => void
  onDeleteModel: (modelId: string) => void
  onEditModel: (model: ProviderModelInfo, caps: Record<string, unknown>) => void
  onDeleteProvider: () => void
}

function ProviderDetail({
  provider: p,
  edits,
  models,
  modelSearch,
  newModelId,
  syncing,
  syncMessage,
  showKey,
  saved,
  hasEdits,
  getCustomHeaders,
  onToggleShowKey,
  onUpdateEdit,
  onSave,
  onSetModelSearch,
  onSetNewModelId,
  onAddModel,
  onSyncModels,
  onToggleModel,
  onDeleteModel,
  onEditModel,
  onDeleteProvider
}: ProviderDetailProps): React.JSX.Element {
  const { t } = useTranslation()

  const query = modelSearch.trim().toLowerCase()
  const sortedModels = [...models].sort((a, b) => b.isEnabled - a.isEnabled)
  const filteredModels = query
    ? sortedModels.filter((m) => m.modelId.toLowerCase().includes(query))
    : sortedModels

  const noEnabledModels = !!p.isEnabled && models.length > 0 && !models.some((m) => m.isEnabled)

  return (
    <div className="flex flex-col">
      {/* 头部：provider 名称 + 操作 */}
      <div className="px-5 py-3 border-b border-border-secondary flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <ProviderIcon name={p.name} />
          <h3 className="text-sm font-semibold text-text-primary truncate">
            {p.displayName || p.name}
          </h3>
          {p.baseUrl && (
            <span className="text-[11px] font-mono text-text-tertiary truncate">
              {p.baseUrl.replace(/^https?:\/\//, '')}
            </span>
          )}
        </div>
        {!p.isBuiltin && (
          <button
            onClick={onDeleteProvider}
            className="p-1.5 rounded-md text-error hover:bg-error/10 transition-colors shrink-0"
            title={t('settings.deleteProvider')}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      <div className="flex-1 px-5 py-5 space-y-5">
        {/* 警告：无启用模型 */}
        {noEnabledModels && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/5">
            <AlertCircle size={12} className="text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-500 leading-relaxed">
              {t('settings.noEnabledModels')}
            </p>
          </div>
        )}

        {/* 基本信息 */}
        <SettingsSection title={t('settings.providerConfigGroup')}>
          {!p.isBuiltin && (
            <SettingsRow
              title={t('settings.providerName')}
              control={
                <InlineInput
                  value={edits.name ?? p.name}
                  onChange={(v) => onUpdateEdit('name', v)}
                  placeholder={t('settings.providerNamePlaceholder')}
                  width={260}
                />
              }
            />
          )}
          <SettingsRow
            title="API Key"
            control={
              <div className="zen-input-group inline-flex items-center" style={{ width: 260 }}>
                <input
                  type={showKey ? 'text' : 'password'}
                  value={edits.apiKey ?? p.apiKey}
                  onChange={(e) => onUpdateEdit('apiKey', e.target.value)}
                  placeholder={t('settings.apiKeyPlaceholder', {
                    name: p.displayName || p.name
                  })}
                  className="font-mono"
                />
                <button
                  onClick={onToggleShowKey}
                  className="px-2 text-text-tertiary hover:text-text-primary transition-colors"
                  type="button"
                >
                  {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
            }
          />
          <SettingsRow
            title="Base URL"
            control={
              <InlineInput
                value={edits.baseUrl ?? p.baseUrl}
                onChange={(v) => onUpdateEdit('baseUrl', v)}
                placeholder={t('settings.baseUrlPlaceholder')}
                monospace
                width={260}
              />
            }
          />
          {!p.isBuiltin && (
            <SettingsRow
              title={t('settings.apiProtocol')}
              control={
                <InlineSelect
                  value={edits.apiProtocol ?? p.apiProtocol}
                  onChange={(v) => onUpdateEdit('apiProtocol', v)}
                  width={260}
                >
                  {API_PROTOCOL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {t(opt.labelKey)}
                    </option>
                  ))}
                </InlineSelect>
              }
            />
          )}
          {!p.isBuiltin && (
            <SettingsBlock label={t('settings.customHeaders')}>
              <textarea
                value={edits.customHeaders ?? getCustomHeaders(p)}
                onChange={(e) => onUpdateEdit('customHeaders', e.target.value)}
                placeholder={t('settings.customHeadersPlaceholder')}
                rows={3}
                className="zen-textarea font-mono text-[11px]"
              />
            </SettingsBlock>
          )}
          {(hasEdits || saved) && (
            <div className="px-4 py-3">
              <button
                onClick={onSave}
                disabled={saved || !hasEdits}
                className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                  saved
                    ? 'bg-success/20 text-success'
                    : !p.isEnabled
                      ? 'bg-green-600 text-white hover:bg-green-500'
                      : 'bg-accent text-white hover:bg-accent-hover'
                }`}
              >
                <Save size={14} />
                {saved
                  ? t('settings.saved')
                  : !p.isEnabled
                    ? t('settings.saveConfigAndEnable')
                    : t('settings.saveConfig')}
              </button>
            </div>
          )}
        </SettingsSection>

        {/* 模型管理 */}
        <SettingsSection
          title={t('settings.modelManagement')}
          headerAction={
            <button
              onClick={onSyncModels}
              disabled={syncing}
              className="px-2 py-1 text-[11px] rounded text-accent hover:bg-accent/10 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {syncing ? t('settings.syncing') : t('settings.syncModels')}
            </button>
          }
        >
          {/* 同步消息（成功/失败均显示在列表顶部） */}
          {syncMessage && (
            <div
              className={`px-4 py-2 text-[11px] leading-relaxed ${
                syncMessage.isError
                  ? 'bg-red-500/5 text-danger'
                  : 'bg-emerald-500/5 text-emerald-500'
              }`}
            >
              {syncMessage.text}
            </div>
          )}

          {/* 添加 + 搜索 */}
          <div className="px-4 py-3 space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newModelId}
                onChange={(e) => onSetNewModelId(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onAddModel()}
                placeholder={t('settings.addModelPlaceholder')}
                className="zen-input flex-1 font-mono text-[11px]"
              />
              <button
                onClick={onAddModel}
                disabled={!newModelId.trim()}
                className="px-2.5 py-1 text-[11px] rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
              >
                {t('common.add')}
              </button>
            </div>
            <input
              type="text"
              value={modelSearch}
              onChange={(e) => onSetModelSearch(e.target.value)}
              placeholder={t('settings.searchModel')}
              className="zen-input text-[11px]"
            />
          </div>

          {/* 模型列表 */}
          {filteredModels.length === 0 ? (
            <div className="px-4 py-6 text-center text-[11px] text-text-tertiary">
              {t('settings.noMatchingModels')}
            </div>
          ) : (
            filteredModels.map((m) => {
              const caps = (() => {
                try {
                  return JSON.parse(m.capabilities || '{}')
                } catch {
                  return {}
                }
              })()
              return (
                <SettingsRow
                  key={m.id}
                  title={
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-[12px] truncate">{m.modelId}</span>
                      <div className="flex items-center gap-1 shrink-0 text-text-tertiary">
                        {caps.vision && <Eye size={10} />}
                        {caps.functionCalling && <Wrench size={10} />}
                        {caps.reasoning && <Brain size={10} />}
                        {caps.imageOutput && <ImageIcon size={10} />}
                        {caps.audioInput && <Mic size={10} />}
                      </div>
                    </div>
                  }
                  control={
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => onEditModel(m, caps)}
                        className="p-1 rounded text-text-tertiary hover:text-text-primary transition-colors"
                        title={t('settings.editCapabilities')}
                      >
                        <SlidersHorizontal size={12} />
                      </button>
                      <button
                        onClick={() => onDeleteModel(m.id)}
                        className="p-1 rounded text-text-tertiary hover:text-danger transition-colors"
                        title={t('settings.deleteModel')}
                      >
                        <X size={12} />
                      </button>
                      <Toggle
                        on={!!m.isEnabled}
                        onClick={() => onToggleModel(m.id, !m.isEnabled)}
                      />
                    </div>
                  }
                />
              )
            })
          )}
        </SettingsSection>
      </div>
    </div>
  )
}
