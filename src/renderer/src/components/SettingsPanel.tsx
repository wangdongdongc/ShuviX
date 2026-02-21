import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff, Save, Settings, Layers, ChevronDown, ChevronRight, FileText, Trash2, RefreshCw, Plus, X } from 'lucide-react'
import { useSettingsStore, type ProviderModelInfo } from '../stores/settingsStore'
import { PayloadViewer } from './PayloadViewer'

/**
 * 设置面板 — 独立窗口（分组 Tab）
 * 通用设置 + 提供商管理
 */
export function SettingsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { activeSettingsTab, setActiveSettingsTab } = useSettingsStore()

  return (
    <div className="h-full bg-bg-primary flex flex-col">
      {/* 头部（macOS 拖拽区） */}
      <div className="titlebar-drag flex items-center px-6 pt-10 pb-4 border-b border-border-secondary bg-bg-secondary">
        <h2 className="text-base font-semibold text-text-primary">{t('settings.title')}</h2>
      </div>

      {/* Tab + 内容 */}
      <div className="flex flex-1 min-h-0">
        {/* 左侧导航 */}
        <div className="w-[180px] flex-shrink-0 border-r border-border-secondary py-4 px-3 space-y-1 bg-bg-secondary">
          <TabButton
            icon={<Settings size={14} />}
            label={t('settings.tabGeneral')}
            active={activeSettingsTab === 'general'}
            onClick={() => setActiveSettingsTab('general')}
          />
          <TabButton
            icon={<Layers size={14} />}
            label={t('settings.tabProviders')}
            active={activeSettingsTab === 'providers'}
            onClick={() => setActiveSettingsTab('providers')}
          />
          <TabButton
            icon={<FileText size={14} />}
            label={t('settings.tabHttpLogs')}
            active={activeSettingsTab === 'httpLogs'}
            onClick={() => setActiveSettingsTab('httpLogs')}
          />
        </div>

        {/* 右侧内容区 */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {activeSettingsTab === 'general' && <GeneralSettings />}
          {activeSettingsTab === 'providers' && <ProviderSettings />}
          {activeSettingsTab === 'httpLogs' && <HttpLogSettings />}
        </div>
      </div>
    </div>
  )
}

/** HTTP 日志设置 */
function HttpLogSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<Array<{
    id: string
    sessionId: string
    sessionTitle: string
    provider: string
    providerName: string
    model: string
    inputTokens: number
    outputTokens: number
    totalTokens: number
    createdAt: number
  }>>([])
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null)
  const [selectedLog, setSelectedLog] = useState<{
    id: string
    sessionId: string
    provider: string
    model: string
    payload: string
    createdAt: number
  } | null>(null)
  const [loadingList, setLoadingList] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [sessions, setSessions] = useState<Array<{ id: string; title: string }>>([])
  const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([])
  const [filterSessionId, setFilterSessionId] = useState<string>('')
  const [filterProvider, setFilterProvider] = useState<string>('')
  const [filterModel, setFilterModel] = useState<string>('')

  /** 加载会话列表（用于筛选下拉） */
  const loadSessions = async (): Promise<void> => {
    const list = await window.api.session.list()
    setSessions(list.map((s) => ({ id: s.id, title: s.title })))
  }

  /** 加载提供商列表（用于筛选下拉） */
  const loadProviders = async (): Promise<void> => {
    const list = await window.api.provider.listAll()
    setProviders(list.map((p) => ({ id: p.id, name: p.name })))
  }

  /** 加载日志列表 */
  const loadLogs = async (filters?: { sessionId?: string; provider?: string; model?: string }): Promise<void> => {
    setLoadingList(true)
    try {
      const rows = await window.api.httpLog.list({
        limit: 300,
        ...(filters?.sessionId ? { sessionId: filters.sessionId } : {}),
        ...(filters?.provider ? { provider: filters.provider } : {}),
        ...(filters?.model ? { model: filters.model } : {})
      })
      setLogs(rows)
      if (rows.length === 0) {
        setSelectedLogId(null)
        setSelectedLog(null)
      } else if (!selectedLogId || !rows.some((row) => row.id === selectedLogId)) {
        setSelectedLogId(rows[0].id)
      }
    } finally {
      setLoadingList(false)
    }
  }

  /** 加载日志详情 */
  const loadLogDetail = async (id: string): Promise<void> => {
    setLoadingDetail(true)
    try {
      const detail = await window.api.httpLog.get(id)
      setSelectedLog(detail || null)
    } finally {
      setLoadingDetail(false)
    }
  }

  /** 清空日志 */
  const handleClear = async (): Promise<void> => {
    setClearing(true)
    try {
      await window.api.httpLog.clear()
      setLogs([])
      setSelectedLogId(null)
      setSelectedLog(null)
    } finally {
      setClearing(false)
    }
  }

  /** 当前筛选参数 */
  const currentFilters = useMemo(() => ({
    sessionId: filterSessionId || undefined,
    provider: filterProvider || undefined,
    model: filterModel || undefined
  }), [filterSessionId, filterProvider, filterModel])

  /** 从已加载日志中提取去重的模型列表（用于筛选下拉） */
  const modelOptions = useMemo(() => {
    const set = new Set<string>()
    logs.forEach((l) => set.add(l.model))
    return Array.from(set).sort()
  }, [logs])

  useEffect(() => {
    loadSessions()
    loadProviders()
    loadLogs()
  }, [])

  /** 切换筛选条件时重新加载日志 */
  useEffect(() => {
    loadLogs(currentFilters)
  }, [filterSessionId, filterProvider])

  /** 切换模型筛选时在前端过滤（模型列表从日志中提取，无需重新请求） */
  // 注意：model 筛选也走后端，保持一致性
  useEffect(() => {
    loadLogs(currentFilters)
  }, [filterModel])

  useEffect(() => {
    if (selectedLogId) {
      loadLogDetail(selectedLogId)
    }
  }, [selectedLogId])

  return (
    <div className="h-full flex flex-col">
      <div className="px-5 py-4 border-b border-border-secondary space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{t('settings.httpLogTitle')}</h3>
            <p className="text-[11px] text-text-tertiary mt-1">{t('settings.httpLogDesc')}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => loadLogs(currentFilters)}
              disabled={loadingList}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-border-primary text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              <RefreshCw size={12} className={loadingList ? 'animate-spin' : ''} />
              {t('common.refresh')}
            </button>
            <button
              onClick={handleClear}
              disabled={clearing || logs.length === 0}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-danger/30 text-danger hover:bg-danger/10 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              <Trash2 size={12} />
              {t('common.clear')}
            </button>
          </div>
        </div>
        {/* 筛选条件 */}
        <div className="flex items-center gap-2">
          <select
            value={filterSessionId}
            onChange={(e) => setFilterSessionId(e.target.value)}
            className="bg-bg-tertiary border border-border-primary rounded-md px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none cursor-pointer max-w-[160px]"
          >
            <option value="">{t('settings.allSessions')}</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>{s.title || s.id.slice(0, 8)}</option>
            ))}
          </select>
          <select
            value={filterProvider}
            onChange={(e) => { setFilterProvider(e.target.value); setFilterModel('') }}
            className="bg-bg-tertiary border border-border-primary rounded-md px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none cursor-pointer max-w-[140px]"
          >
            <option value="">{t('settings.allProviders')}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select
            value={filterModel}
            onChange={(e) => setFilterModel(e.target.value)}
            className="bg-bg-tertiary border border-border-primary rounded-md px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none cursor-pointer max-w-[180px]"
          >
            <option value="">{t('settings.allModels')}</option>
            {modelOptions.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="w-[320px] border-r border-border-secondary overflow-y-auto">
          {logs.length === 0 ? (
            <div className="px-4 py-6 text-xs text-text-tertiary">{t('settings.noLogs')}</div>
          ) : (
            <div className="p-2 space-y-1">
              {logs.map((log) => {
                const active = selectedLogId === log.id
                return (
                  <button
                    key={log.id}
                    onClick={() => setSelectedLogId(log.id)}
                    className={`w-full text-left rounded-md px-2.5 py-2 border transition-colors ${
                      active
                        ? 'border-accent/40 bg-accent/10'
                        : 'border-transparent hover:border-border-primary hover:bg-bg-hover'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-[11px] text-text-secondary">{new Date(log.createdAt).toLocaleString()}</div>
                      {log.totalTokens > 0 && (
                        <div className="text-[10px] text-text-tertiary">{log.totalTokens} tokens</div>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-text-primary font-medium">
                      {log.providerName || log.provider} / {log.model}
                    </div>
                    {log.totalTokens > 0 && (
                      <div className="mt-0.5 text-[10px] text-text-tertiary">
                        in: {log.inputTokens} / out: {log.outputTokens}
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0 p-4 overflow-y-auto">
          {!selectedLogId ? (
            <div className="text-xs text-text-tertiary">{t('settings.selectLogHint')}</div>
          ) : loadingDetail ? (
            <div className="text-xs text-text-tertiary">{t('settings.loadingLog')}</div>
          ) : !selectedLog ? (
            <div className="text-xs text-text-tertiary">{t('settings.logNotFound')}</div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-bg-tertiary rounded-md px-3 py-2">
                  <div className="text-text-tertiary">{t('settings.time')}</div>
                  <div className="text-text-primary mt-0.5 break-all">{new Date(selectedLog.createdAt).toLocaleString()}</div>
                </div>
                <div className="bg-bg-tertiary rounded-md px-3 py-2">
                  <div className="text-text-tertiary">{t('settings.session')}</div>
                  <div className="text-text-primary mt-0.5">{logs.find((l) => l.id === selectedLogId)?.sessionTitle || t('settings.unknownSession')}</div>
                  <div className="text-[10px] text-text-tertiary mt-0.5 break-all">{selectedLog.sessionId}</div>
                </div>
              </div>

              <div className="text-xs text-text-secondary">{t('settings.requestBody')}</div>
              <PayloadViewer payload={selectedLog.payload} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Tab 按钮 */
function TabButton({ icon, label, active, onClick }: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
        active
          ? 'bg-accent/10 text-accent'
          : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

/** 通用设置（所有修改即时保存） */
function GeneralSettings(): React.JSX.Element {
  const { t, i18n: i18nInstance } = useTranslation()
  const i18nLang = i18nInstance.language
  const { systemPrompt, theme, fontSize, setSystemPrompt, setTheme, setFontSize, availableModels, activeProvider, activeModel, setActiveProvider, setActiveModel } = useSettingsStore()
  const [localSystemPrompt, setLocalSystemPrompt] = useState(systemPrompt)

  useEffect(() => {
    setLocalSystemPrompt(systemPrompt)
  }, [systemPrompt])

  // 从可用模型中提取已启用的 provider 列表（去重）
  const enabledProviderIds = [...new Set(availableModels.map((m) => m.providerId))]

  /** 切换默认 Provider 时自动选第一个可用模型并即时保存 */
  const handleProviderChange = (newProvider: string): void => {
    setActiveProvider(newProvider)
    window.api.settings.set({ key: 'general.defaultProvider', value: newProvider })
    const firstModel = availableModels.find((m) => m.providerId === newProvider)
    if (firstModel) {
      setActiveModel(firstModel.modelId)
      window.api.settings.set({ key: 'general.defaultModel', value: firstModel.modelId })
    }
  }

  /** 切换默认模型并即时保存 */
  const handleModelChange = (modelId: string): void => {
    setActiveModel(modelId)
    window.api.settings.set({ key: 'general.defaultModel', value: modelId })
  }

  /** 系统提示词失焦时保存 */
  const handleSystemPromptBlur = (): void => {
    if (localSystemPrompt !== systemPrompt) {
      setSystemPrompt(localSystemPrompt)
      window.api.settings.set({ key: 'general.systemPrompt', value: localSystemPrompt })
    }
  }

  return (
    <div className="flex-1 px-5 py-5 space-y-6">
      {/* 主题 */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">{t('settings.theme')}</label>
        <div className="flex gap-2">
          {(['dark', 'light', 'system'] as const).map((th) => (
            <button
              key={th}
              onClick={() => {
                setTheme(th)
                window.api.settings.set({ key: 'general.theme', value: th })
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                theme === th
                  ? 'bg-accent text-white'
                  : 'bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover'
              }`}
            >
              {th === 'dark' ? t('settings.themeDark') : th === 'light' ? t('settings.themeLight') : t('settings.themeSystem')}
            </button>
          ))}
        </div>
      </div>

      {/* 语言 */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">{t('settings.language')}</label>
        <div className="flex gap-2">
          {(['zh', 'en', 'ja'] as const).map((lng) => (
            <button
              key={lng}
              onClick={() => {
                i18nInstance.changeLanguage(lng)
                window.api.settings.set({ key: 'general.language', value: lng })
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                (i18nLang || 'zh') === lng
                  ? 'bg-accent text-white'
                  : 'bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover'
              }`}
            >
              {lng === 'zh' ? '中文' : lng === 'en' ? 'English' : '日本語'}
            </button>
          ))}
        </div>
      </div>

      {/* 字体大小 */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">
          {t('settings.fontSize')} <span className="text-text-tertiary font-normal ml-1">{fontSize}px</span>
        </label>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-text-tertiary">12</span>
          <input
            type="range"
            min={12}
            max={20}
            step={1}
            value={fontSize}
            onChange={(e) => {
              const v = Number(e.target.value)
              setFontSize(v)
              window.api.settings.set({ key: 'general.fontSize', value: String(v) })
            }}
            className="flex-1 h-1.5 bg-bg-tertiary rounded-full appearance-none cursor-pointer accent-accent"
          />
          <span className="text-[10px] text-text-tertiary">20</span>
        </div>
      </div>

      {/* 默认 Provider */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">{t('settings.defaultProvider')}</label>
        <select
          value={activeProvider}
          onChange={(e) => handleProviderChange(e.target.value)}
          className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none cursor-pointer"
        >
          {enabledProviderIds.map((pid) => {
            const m = availableModels.find((am) => am.providerId === pid)
            return (
              <option key={pid} value={pid}>{m?.providerName || pid}</option>
            )
          })}
        </select>
      </div>

      {/* 默认模型 */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">{t('settings.defaultModel')}</label>
        <select
          value={activeModel}
          onChange={(e) => handleModelChange(e.target.value)}
          className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none cursor-pointer"
        >
          {availableModels
            .filter((m) => m.providerId === activeProvider)
            .map((m) => (
              <option key={m.id} value={m.modelId}>{m.modelId}</option>
            ))}
        </select>
      </div>

      {/* 系统提示词 */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">{t('settings.systemPrompt')}</label>
        <textarea
          value={localSystemPrompt}
          onChange={(e) => setLocalSystemPrompt(e.target.value)}
          onBlur={handleSystemPromptBlur}
          rows={4}
          className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none resize-none focus:border-accent/50 transition-colors leading-relaxed"
          placeholder={t('settings.systemPromptPlaceholder')}
        />
      </div>
    </div>
  )
}

/** 能力标签 key 列表（desc 通过 i18n 查找） */
const CAPABILITY_KEYS = [
  { key: 'vision', label: 'Vision', descKey: 'settings.capVision' },
  { key: 'imageOutput', label: 'Image Output', descKey: 'settings.capImageOutput' },
  { key: 'functionCalling', label: 'Function Calling', descKey: 'settings.capFunctionCalling' },
  { key: 'reasoning', label: 'Reasoning', descKey: 'settings.capReasoning' },
  { key: 'audioInput', label: 'Audio Input', descKey: 'settings.capAudioInput' },
  { key: 'audioOutput', label: 'Audio Output', descKey: 'settings.capAudioOutput' },
  { key: 'pdfInput', label: 'PDF Input', descKey: 'settings.capPdfInput' }
] as const

/** 模型能力编辑器 */
function ModelCapabilitiesEditor({
  capabilities,
  onUpdate
}: {
  capabilities: Record<string, any>
  onUpdate: (caps: Record<string, any>) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const toggle = (key: string): void => {
    const updated = { ...capabilities, [key]: !capabilities[key] }
    onUpdate(updated)
  }

  return (
    <div className="px-4 pb-2 pt-1">
      <div className="flex flex-wrap gap-1.5">
        {CAPABILITY_KEYS.map(({ key, label, descKey }) => (
          <button
            key={key}
            onClick={() => toggle(key)}
            className={`px-2 py-1 text-[10px] rounded-md border transition-colors ${
              capabilities[key]
                ? 'border-accent/50 bg-accent/10 text-accent'
                : 'border-border-primary bg-bg-tertiary text-text-tertiary hover:text-text-secondary'
            }`}
            title={t(descKey)}
          >
            {label}
          </button>
        ))}
      </div>
      {(capabilities.maxInputTokens || capabilities.maxOutputTokens) && (
        <div className="mt-1.5 text-[10px] text-text-tertiary">
          {capabilities.maxInputTokens && <span>{t('settings.context')}: {(capabilities.maxInputTokens / 1000).toFixed(0)}K</span>}
          {capabilities.maxInputTokens && capabilities.maxOutputTokens && <span className="mx-1">·</span>}
          {capabilities.maxOutputTokens && <span>{t('settings.maxOutput')}: {(capabilities.maxOutputTokens / 1000).toFixed(0)}K</span>}
        </div>
      )}
    </div>
  )
}

/** 提供商设置 */
function ProviderSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const { providers, setProviders, setAvailableModels } = useSettingsStore()
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})
  const [localEdits, setLocalEdits] = useState<Record<string, { apiKey?: string; baseUrl?: string }>>({})
  const [providerModels, setProviderModels] = useState<Record<string, ProviderModelInfo[]>>({})
  const [modelSearch, setModelSearch] = useState<Record<string, string>>({})
  const [syncingProviderId, setSyncingProviderId] = useState<string | null>(null)
  const [syncMessages, setSyncMessages] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newProvider, setNewProvider] = useState({ name: '', baseUrl: '', apiKey: '', apiProtocol: 'openai-completions' as const })
  const [addingProvider, setAddingProvider] = useState(false)
  const [newModelId, setNewModelId] = useState<Record<string, string>>({})
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null)

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
  const handleToggleModel = async (modelId: string, providerId: string, isEnabled: boolean): Promise<void> => {
    await window.api.provider.toggleModelEnabled({ id: modelId, isEnabled })
    // 刷新该提供商的模型列表
    const models = await window.api.provider.listModels(providerId)
    setProviderModels((prev) => ({ ...prev, [providerId]: models }))
    const available = await window.api.provider.listAvailableModels()
    setAvailableModels(available)
  }

  /** 更新本地编辑状态 */
  const updateLocalEdit = (providerId: string, field: 'apiKey' | 'baseUrl', value: string): void => {
    setLocalEdits((prev) => ({
      ...prev,
      [providerId]: { ...prev[providerId], [field]: value }
    }))
  }

  /** 保存提供商配置 */
  const handleSave = async (): Promise<void> => {
    for (const [pid, edits] of Object.entries(localEdits)) {
      const provider = providers.find((p) => p.id === pid)
      if (!provider) continue
      const updates: { apiKey?: string; baseUrl?: string } = {}
      if (edits.apiKey !== undefined && edits.apiKey !== provider.apiKey) {
        updates.apiKey = edits.apiKey
      }
      if (edits.baseUrl !== undefined && edits.baseUrl !== provider.baseUrl) {
        updates.baseUrl = edits.baseUrl
      }
      if (Object.keys(updates).length > 0) {
        await window.api.provider.updateConfig({ id: pid, ...updates })
      }
    }
    // 刷新
    const updated = await window.api.provider.listAll()
    setProviders(updated)
    setLocalEdits({})
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  /** 添加自定义提供商 */
  const handleAddProvider = async (): Promise<void> => {
    if (!newProvider.name.trim() || !newProvider.baseUrl.trim()) return
    setAddingProvider(true)
    try {
      await window.api.provider.add({
        name: newProvider.name.trim(),
        baseUrl: newProvider.baseUrl.trim(),
        apiKey: newProvider.apiKey.trim(),
        apiProtocol: newProvider.apiProtocol
      })
      const updated = await window.api.provider.listAll()
      setProviders(updated)
      const available = await window.api.provider.listAvailableModels()
      setAvailableModels(available)
      setNewProvider({ name: '', baseUrl: '', apiKey: '', apiProtocol: 'openai-completions' })
      setShowAddForm(false)
    } finally {
      setAddingProvider(false)
    }
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
    } catch (err: any) {
      setSyncMessages((prev) => ({
        ...prev,
        [providerId]: err?.message || t('settings.syncFailed')
      }))
    } finally {
      setSyncingProviderId(null)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 px-5 py-5 space-y-2 overflow-y-auto">
        {/* 添加自定义提供商按钮 */}
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-border-secondary text-xs text-text-secondary hover:text-text-primary hover:border-accent/40 hover:bg-accent/5 transition-colors"
        >
          <Plus size={14} />
          {t('settings.addProvider')}
        </button>

        {/* 添加表单 */}
        {showAddForm && (
          <div className="border border-accent/30 rounded-lg p-4 space-y-3 bg-accent/5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text-primary">{t('settings.newProvider')}</span>
              <button onClick={() => setShowAddForm(false)} className="text-text-tertiary hover:text-text-primary">
                <X size={14} />
              </button>
            </div>
            <div>
              <label className="block text-[11px] text-text-tertiary mb-1">{t('settings.providerName')}</label>
              <input
                value={newProvider.name}
                onChange={(e) => setNewProvider((p) => ({ ...p, name: e.target.value }))}
                placeholder={t('settings.providerNamePlaceholder')}
                className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 transition-colors"
              />
            </div>
            <div>
              <label className="block text-[11px] text-text-tertiary mb-1">Base URL</label>
              <input
                value={newProvider.baseUrl}
                onChange={(e) => setNewProvider((p) => ({ ...p, baseUrl: e.target.value }))}
                placeholder="https://api.example.com/v1"
                className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 transition-colors font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] text-text-tertiary mb-1">API Key</label>
              <input
                type="password"
                value={newProvider.apiKey}
                onChange={(e) => setNewProvider((p) => ({ ...p, apiKey: e.target.value }))}
                placeholder="sk-..."
                className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 transition-colors font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] text-text-tertiary mb-1">{t('settings.apiProtocol')}</label>
              <select
                value={newProvider.apiProtocol}
                onChange={(e) => setNewProvider((p) => ({ ...p, apiProtocol: e.target.value as any }))}
                className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none cursor-pointer"
              >
                <option value="openai-completions">{t('settings.protocolOpenAI')}</option>
                <option value="anthropic-messages">Anthropic Messages</option>
                <option value="google-generative-ai">Google Generative AI</option>
              </select>
            </div>
            <button
              onClick={handleAddProvider}
              disabled={addingProvider || !newProvider.name.trim() || !newProvider.baseUrl.trim()}
              className="w-full px-3 py-2 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {addingProvider ? t('common.adding') : t('common.add')}
            </button>
          </div>
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
                  {p.name}
                  {!p.isBuiltin && (
                    <span className="ml-1.5 text-[10px] text-text-tertiary font-normal">{t('settings.custom')}</span>
                  )}
                </span>
                {/* 删除自定义提供商 */}
                {!p.isBuiltin && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteProvider(p.id) }}
                    className="text-text-tertiary hover:text-danger transition-colors mr-1"
                    title={t('settings.deleteProvider')}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
                {/* 启用/禁用开关 */}
                <button
                  onClick={(e) => { e.stopPropagation(); handleToggleProvider(p.id, !p.isEnabled) }}
                  className={`w-8 h-4.5 rounded-full relative transition-colors ${
                    p.isEnabled ? 'bg-accent' : 'bg-bg-tertiary'
                  }`}
                >
                  <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${
                    p.isEnabled ? 'left-[18px]' : 'left-0.5'
                  }`} />
                </button>
              </div>

              {/* 展开内容 */}
              {isExpanded && (
                <div className="px-4 py-3 space-y-3 border-t border-border-secondary">
                  {/* API Key */}
                  <div>
                    <label className="block text-[11px] text-text-tertiary mb-1">API Key</label>
                    <div className="flex items-center bg-bg-tertiary border border-border-primary rounded-lg overflow-hidden focus-within:border-accent/50 transition-colors">
                      <input
                        type={showKeys[p.id] ? 'text' : 'password'}
                        value={edits.apiKey ?? p.apiKey}
                        onChange={(e) => updateLocalEdit(p.id, 'apiKey', e.target.value)}
                        placeholder={t('settings.apiKeyPlaceholder', { name: p.name })}
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
                      className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 transition-colors"
                    />
                  </div>

                  {/* 模型列表 */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="block text-[11px] text-text-tertiary">{t('settings.modelManagement')}</label>
                      <button
                        onClick={() => handleSyncModels(p.id)}
                        disabled={syncingProviderId === p.id}
                        className="px-2 py-1 text-[10px] rounded-md border border-border-primary text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                      >
                        {syncingProviderId === p.id ? t('settings.syncing') : t('settings.syncModels')}
                      </button>
                    </div>
                    {syncMessages[p.id] && (
                      <div className="text-[10px] text-text-tertiary mb-2">{syncMessages[p.id]}</div>
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
                        const caps = (() => { try { return JSON.parse(m.capabilities || '{}') } catch { return {} } })()
                        const isModelExpanded = expandedModelId === m.id
                        return (
                          <div key={m.id} className="rounded-md hover:bg-bg-hover transition-colors">
                            <div className="flex items-center justify-between px-2 py-1.5">
                              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                                <button
                                  onClick={() => setExpandedModelId(isModelExpanded ? null : m.id)}
                                  className="text-text-tertiary hover:text-text-secondary transition-colors shrink-0"
                                  title={t('settings.editCapabilities')}
                                >
                                  {isModelExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                </button>
                                <span className="text-xs text-text-primary font-mono truncate">{m.modelId}</span>
                                {/* 能力标签 */}
                                <div className="flex items-center gap-1 shrink-0">
                                  {caps.vision && <span className="px-1 py-0.5 text-[9px] rounded bg-blue-500/20 text-blue-400">Vision</span>}
                                  {caps.functionCalling && <span className="px-1 py-0.5 text-[9px] rounded bg-green-500/20 text-green-400">Tools</span>}
                                  {caps.reasoning && <span className="px-1 py-0.5 text-[9px] rounded bg-purple-500/20 text-purple-400">Reasoning</span>}
                                  {caps.imageOutput && <span className="px-1 py-0.5 text-[9px] rounded bg-orange-500/20 text-orange-400">ImgOut</span>}
                                  {caps.audioInput && <span className="px-1 py-0.5 text-[9px] rounded bg-cyan-500/20 text-cyan-400">Audio</span>}
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5">
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
                                  <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                                    m.isEnabled ? 'left-[14px]' : 'left-0.5'
                                  }`} />
                                </button>
                              </div>
                            </div>
                            {/* 能力编辑展开面板 */}
                            {isModelExpanded && (
                              <ModelCapabilitiesEditor
                                capabilities={caps}
                                onUpdate={async (newCaps) => {
                                  await window.api.provider.updateModelCapabilities({ id: m.id, capabilities: newCaps })
                                  const models = await window.api.provider.listModels(p.id)
                                  setProviderModels((prev) => ({ ...prev, [p.id]: models }))
                                }}
                              />
                            )}
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

      {/* 保存 */}
      <div className="px-5 py-4 border-t border-border-secondary">
        <button
          onClick={handleSave}
          className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
            saved ? 'bg-success/20 text-success' : 'bg-accent text-white hover:bg-accent-hover'
          }`}
        >
          <Save size={16} />
          {saved ? t('settings.saved') : t('settings.saveConfig')}
        </button>
      </div>
    </div>
  )
}
