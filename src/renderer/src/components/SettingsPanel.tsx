import { useState, useEffect } from 'react'
import { Eye, EyeOff, Save, Settings, Layers, ChevronDown, ChevronRight, FileText, Trash2, RefreshCw, Plus, X } from 'lucide-react'
import { useSettingsStore, type ProviderModelInfo } from '../stores/settingsStore'

/**
 * 设置面板 — 独立窗口（分组 Tab）
 * 通用设置 + 提供商管理
 */
export function SettingsPanel(): React.JSX.Element {
  const { activeSettingsTab, setActiveSettingsTab } = useSettingsStore()

  return (
    <div className="h-full bg-bg-primary flex flex-col">
      {/* 头部（macOS 拖拽区） */}
      <div className="titlebar-drag flex items-center px-6 pt-10 pb-4 border-b border-border-secondary bg-bg-secondary">
        <h2 className="text-base font-semibold text-text-primary">设置</h2>
      </div>

      {/* Tab + 内容 */}
      <div className="flex flex-1 min-h-0">
        {/* 左侧导航 */}
        <div className="w-[180px] flex-shrink-0 border-r border-border-secondary py-4 px-3 space-y-1 bg-bg-secondary">
          <TabButton
            icon={<Settings size={14} />}
            label="通用"
            active={activeSettingsTab === 'general'}
            onClick={() => setActiveSettingsTab('general')}
          />
          <TabButton
            icon={<Layers size={14} />}
            label="提供商"
            active={activeSettingsTab === 'providers'}
            onClick={() => setActiveSettingsTab('providers')}
          />
          <TabButton
            icon={<FileText size={14} />}
            label="HTTP 日志"
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
  const [logs, setLogs] = useState<Array<{
    id: string
    sessionId: string
    sessionTitle: string
    provider: string
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
  const [filterSessionId, setFilterSessionId] = useState<string>('')

  /** 加载会话列表（用于筛选下拉） */
  const loadSessions = async (): Promise<void> => {
    const list = await window.api.session.list()
    setSessions(list.map((s) => ({ id: s.id, title: s.title })))
  }

  /** 加载日志列表 */
  const loadLogs = async (sessionId?: string): Promise<void> => {
    setLoadingList(true)
    try {
      const rows = await window.api.httpLog.list({
        limit: 300,
        ...(sessionId ? { sessionId } : {})
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

  useEffect(() => {
    loadSessions()
    loadLogs()
  }, [])

  /** 切换筛选条件时重新加载日志 */
  useEffect(() => {
    loadLogs(filterSessionId || undefined)
  }, [filterSessionId])

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
            <h3 className="text-sm font-semibold text-text-primary">HTTP 请求日志</h3>
            <p className="text-[11px] text-text-tertiary mt-1">每次请求 AI 时会记录请求体，便于审计和排查。</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => loadLogs(filterSessionId || undefined)}
              disabled={loadingList}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-border-primary text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              <RefreshCw size={12} className={loadingList ? 'animate-spin' : ''} />
              刷新
            </button>
            <button
              onClick={handleClear}
              disabled={clearing || logs.length === 0}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border border-danger/30 text-danger hover:bg-danger/10 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              <Trash2 size={12} />
              清空
            </button>
          </div>
        </div>
        {/* 会话筛选 */}
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-text-tertiary flex-shrink-0">按会话筛选</label>
          <select
            value={filterSessionId}
            onChange={(e) => setFilterSessionId(e.target.value)}
            className="flex-1 bg-bg-tertiary border border-border-primary rounded-md px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none cursor-pointer"
          >
            <option value="">全部会话</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>{s.title || s.id.slice(0, 8)}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="w-[320px] border-r border-border-secondary overflow-y-auto">
          {logs.length === 0 ? (
            <div className="px-4 py-6 text-xs text-text-tertiary">暂无日志</div>
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
                      {log.provider} / {log.model}
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
            <div className="text-xs text-text-tertiary">请选择左侧日志查看请求体详情。</div>
          ) : loadingDetail ? (
            <div className="text-xs text-text-tertiary">正在加载日志详情...</div>
          ) : !selectedLog ? (
            <div className="text-xs text-text-tertiary">日志不存在或已被清理。</div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-bg-tertiary rounded-md px-3 py-2">
                  <div className="text-text-tertiary">时间</div>
                  <div className="text-text-primary mt-0.5 break-all">{new Date(selectedLog.createdAt).toLocaleString()}</div>
                </div>
                <div className="bg-bg-tertiary rounded-md px-3 py-2">
                  <div className="text-text-tertiary">会话</div>
                  <div className="text-text-primary mt-0.5">{logs.find((l) => l.id === selectedLogId)?.sessionTitle || '未知会话'}</div>
                  <div className="text-[10px] text-text-tertiary mt-0.5 break-all">{selectedLog.sessionId}</div>
                </div>
              </div>

              <div className="text-xs text-text-secondary">请求体（JSON 文本）</div>
              <pre className="w-full min-h-[260px] rounded-lg border border-border-primary bg-bg-tertiary p-3 text-[11px] leading-relaxed text-text-primary overflow-auto whitespace-pre-wrap break-words">
                {selectedLog.payload}
              </pre>
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
        <label className="block text-xs font-medium text-text-secondary mb-2">主题</label>
        <div className="flex gap-2">
          {(['dark', 'light', 'system'] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTheme(t)
                window.api.settings.set({ key: 'general.theme', value: t })
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                theme === t
                  ? 'bg-accent text-white'
                  : 'bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover'
              }`}
            >
              {t === 'dark' ? '深色' : t === 'light' ? '浅色' : '跟随系统'}
            </button>
          ))}
        </div>
      </div>

      {/* 字体大小 */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">
          字体大小 <span className="text-text-tertiary font-normal ml-1">{fontSize}px</span>
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
        <label className="block text-xs font-medium text-text-secondary mb-2">默认提供商</label>
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
        <label className="block text-xs font-medium text-text-secondary mb-2">默认模型</label>
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
        <label className="block text-xs font-medium text-text-secondary mb-2">系统提示词</label>
        <textarea
          value={localSystemPrompt}
          onChange={(e) => setLocalSystemPrompt(e.target.value)}
          onBlur={handleSystemPromptBlur}
          rows={4}
          className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none resize-none focus:border-accent/50 transition-colors leading-relaxed"
          placeholder="设定 AI 助手的角色和行为..."
        />
      </div>
    </div>
  )
}

/** 提供商设置 */
function ProviderSettings(): React.JSX.Element {
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
        [providerId]: `同步成功：共 ${result.total} 个模型，新增 ${result.added} 个`
      }))
    } catch (err: any) {
      setSyncMessages((prev) => ({
        ...prev,
        [providerId]: err?.message || '同步失败，请检查 API Key 与网络设置'
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
          添加自定义提供商
        </button>

        {/* 添加表单 */}
        {showAddForm && (
          <div className="border border-accent/30 rounded-lg p-4 space-y-3 bg-accent/5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text-primary">新增提供商</span>
              <button onClick={() => setShowAddForm(false)} className="text-text-tertiary hover:text-text-primary">
                <X size={14} />
              </button>
            </div>
            <div>
              <label className="block text-[11px] text-text-tertiary mb-1">名称</label>
              <input
                value={newProvider.name}
                onChange={(e) => setNewProvider((p) => ({ ...p, name: e.target.value }))}
                placeholder="例如：DeepSeek、智谱、Moonshot"
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
              <label className="block text-[11px] text-text-tertiary mb-1">API 协议</label>
              <select
                value={newProvider.apiProtocol}
                onChange={(e) => setNewProvider((p) => ({ ...p, apiProtocol: e.target.value as any }))}
                className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none cursor-pointer"
              >
                <option value="openai-completions">OpenAI 兼容（绝大多数提供商）</option>
                <option value="anthropic-messages">Anthropic Messages</option>
                <option value="google-generative-ai">Google Generative AI</option>
              </select>
            </div>
            <button
              onClick={handleAddProvider}
              disabled={addingProvider || !newProvider.name.trim() || !newProvider.baseUrl.trim()}
              className="w-full px-3 py-2 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {addingProvider ? '添加中…' : '添加'}
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
                    <span className="ml-1.5 text-[10px] text-text-tertiary font-normal">自定义</span>
                  )}
                </span>
                {/* 删除自定义提供商 */}
                {!p.isBuiltin && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteProvider(p.id) }}
                    className="text-text-tertiary hover:text-danger transition-colors mr-1"
                    title="删除提供商"
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
                        placeholder={`输入 ${p.name} API Key`}
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
                      placeholder="留空使用默认地址"
                      className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 transition-colors"
                    />
                  </div>

                  {/* 模型列表 */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="block text-[11px] text-text-tertiary">模型管理</label>
                      <button
                        onClick={() => handleSyncModels(p.id)}
                        disabled={syncingProviderId === p.id}
                        className="px-2 py-1 text-[10px] rounded-md border border-border-primary text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                      >
                        {syncingProviderId === p.id ? '同步中...' : '同步模型'}
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
                          placeholder="输入模型 ID 并回车添加"
                          className="flex-1 bg-bg-tertiary border border-border-primary rounded-md px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 transition-colors font-mono"
                        />
                        <button
                          onClick={() => handleAddModel(p.id)}
                          disabled={!newModelId[p.id]?.trim()}
                          className="px-2 py-1.5 text-[10px] rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          添加
                        </button>
                      </div>
                    )}

                    <input
                      type="text"
                      value={modelSearch[p.id] || ''}
                      onChange={(e) =>
                        setModelSearch((prev) => ({ ...prev, [p.id]: e.target.value }))
                      }
                      placeholder="搜索模型（如 gpt-4o / o3）"
                      className="w-full mb-2 bg-bg-tertiary border border-border-primary rounded-md px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 transition-colors"
                    />

                    <div className="space-y-1">
                      {filteredModels.map((m) => (
                        <div key={m.id} className="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-bg-hover transition-colors">
                          <span className="text-xs text-text-primary font-mono">{m.modelId}</span>
                          <div className="flex items-center gap-1.5">
                            {/* 自定义提供商的模型可删除 */}
                            {!p.isBuiltin && (
                              <button
                                onClick={() => handleDeleteModel(m.id, p.id)}
                                className="text-text-tertiary hover:text-danger transition-colors"
                                title="删除模型"
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
                      ))}
                      {filteredModels.length === 0 && (
                        <div className="px-2 py-2 text-[11px] text-text-tertiary">
                          未找到匹配模型
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
          {saved ? '已保存' : '保存配置'}
        </button>
      </div>
    </div>
  )
}
