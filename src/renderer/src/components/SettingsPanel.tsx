import { useState, useEffect } from 'react'
import { X, Eye, EyeOff, Save, Settings, Layers, ChevronDown, ChevronRight } from 'lucide-react'
import { useSettingsStore, type ProviderModelInfo } from '../stores/settingsStore'

/**
 * 设置面板 — 右侧滑出面板（分组 Tab）
 * 通用设置 + 提供商管理
 */
export function SettingsPanel(): React.JSX.Element {
  const {
    isSettingsOpen,
    setIsSettingsOpen,
    activeSettingsTab,
    setActiveSettingsTab
  } = useSettingsStore()

  if (!isSettingsOpen) return <></>

  return (
    <>
      {/* 遮罩层 */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={() => setIsSettingsOpen(false)}
      />

      {/* 设置面板 */}
      <div className="fixed right-0 top-0 bottom-0 w-[520px] bg-bg-secondary border-l border-border-secondary z-50 flex flex-col shadow-2xl">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 pt-10 pb-4 border-b border-border-secondary">
          <h2 className="text-base font-semibold text-text-primary">设置</h2>
          <button
            onClick={() => setIsSettingsOpen(false)}
            className="p-1.5 rounded-lg hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Tab + 内容 */}
        <div className="flex flex-1 min-h-0">
          {/* 左侧导航 */}
          <div className="w-[130px] flex-shrink-0 border-r border-border-secondary py-3 px-2 space-y-1">
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
          </div>

          {/* 右侧内容区 */}
          <div className="flex-1 min-w-0 overflow-y-auto">
            {activeSettingsTab === 'general' && <GeneralSettings />}
            {activeSettingsTab === 'providers' && <ProviderSettings />}
          </div>
        </div>
      </div>
    </>
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

/** 通用设置 */
function GeneralSettings(): React.JSX.Element {
  const { systemPrompt, theme, fontSize, setSystemPrompt, setTheme, setFontSize, availableModels, activeProvider, activeModel, setActiveProvider, setActiveModel } = useSettingsStore()
  const [localSystemPrompt, setLocalSystemPrompt] = useState(systemPrompt)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setLocalSystemPrompt(systemPrompt)
  }, [systemPrompt])

  // 从可用模型中提取已启用的 provider 列表（去重）
  const enabledProviderIds = [...new Set(availableModels.map((m) => m.providerId))]

  const handleSave = async (): Promise<void> => {
    if (localSystemPrompt !== systemPrompt) {
      setSystemPrompt(localSystemPrompt)
      await window.api.settings.set({ key: 'general.systemPrompt', value: localSystemPrompt })
    }
    await window.api.settings.set({ key: 'general.theme', value: theme })
    await window.api.settings.set({ key: 'general.fontSize', value: String(fontSize) })
    await window.api.settings.set({ key: 'general.defaultProvider', value: activeProvider })
    await window.api.settings.set({ key: 'general.defaultModel', value: activeModel })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  /** 切换默认 Provider 时自动选第一个可用模型 */
  const handleProviderChange = (newProvider: string): void => {
    setActiveProvider(newProvider)
    const firstModel = availableModels.find((m) => m.providerId === newProvider)
    if (firstModel) {
      setActiveModel(firstModel.modelId)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 px-5 py-5 space-y-6">
        {/* 主题 */}
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-2">主题</label>
          <div className="flex gap-2">
            {(['dark', 'light', 'system'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
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
              onChange={(e) => setFontSize(Number(e.target.value))}
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
            onChange={(e) => setActiveModel(e.target.value)}
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
            rows={4}
            className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none resize-none focus:border-accent/50 transition-colors leading-relaxed"
            placeholder="设定 AI 助手的角色和行为..."
          />
        </div>
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
          {saved ? '已保存' : '保存设置'}
        </button>
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

  /**
   * 从提供商拉取并同步模型列表
   * 当前先支持 OpenAI
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
      <div className="flex-1 px-5 py-5 space-y-2">
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
                <span className="flex-1 text-xs font-medium text-text-primary">{p.name}</span>
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
                          <span className="text-xs text-text-primary">{m.modelId}</span>
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
