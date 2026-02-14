import { useState, useEffect } from 'react'
import { X, Eye, EyeOff, Save } from 'lucide-react'
import { useSettingsStore, PROVIDERS } from '../stores/settingsStore'

/**
 * 设置面板 — 右侧滑出面板
 * 管理 API Key、Provider/Model 选择、系统提示词
 */
export function SettingsPanel(): React.JSX.Element {
  const {
    isSettingsOpen,
    setIsSettingsOpen,
    apiKeys,
    baseUrls,
    provider,
    model,
    systemPrompt,
    setApiKey,
    setBaseUrl,
    setProvider,
    setModel,
    setSystemPrompt
  } = useSettingsStore()

  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})
  const [localApiKeys, setLocalApiKeys] = useState<Record<string, string>>({})
  const [localBaseUrls, setLocalBaseUrls] = useState<Record<string, string>>({})
  const [localSystemPrompt, setLocalSystemPrompt] = useState(systemPrompt)
  const [saved, setSaved] = useState(false)

  /** 同步本地状态 */
  useEffect(() => {
    setLocalApiKeys({ ...apiKeys })
    setLocalBaseUrls({ ...baseUrls })
    setLocalSystemPrompt(systemPrompt)
  }, [apiKeys, baseUrls, systemPrompt, isSettingsOpen])

  /** 获取当前 Provider 的模型列表 */
  const currentProvider = PROVIDERS.find((p) => p.id === provider)
  const models = currentProvider?.models ?? []

  /** 切换密钥可见性 */
  const toggleKeyVisibility = (providerId: string): void => {
    setShowKeys((prev) => ({ ...prev, [providerId]: !prev[providerId] }))
  }

  /** 保存所有设置 */
  const handleSave = async (): Promise<void> => {
    // 保存 API Keys
    for (const [pid, key] of Object.entries(localApiKeys)) {
      if (key !== apiKeys[pid]) {
        setApiKey(pid, key)
        await window.api.settings.set({ key: `apiKey:${pid}`, value: key })
      }
    }

    // 保存 Base URLs
    for (const [pid, url] of Object.entries(localBaseUrls)) {
      if (url !== baseUrls[pid]) {
        setBaseUrl(pid, url)
        await window.api.settings.set({ key: `baseUrl:${pid}`, value: url })
      }
    }

    // 保存 Provider 和 Model
    await window.api.settings.set({ key: 'provider', value: provider })
    await window.api.settings.set({ key: 'model', value: model })

    // 保存 System Prompt
    if (localSystemPrompt !== systemPrompt) {
      setSystemPrompt(localSystemPrompt)
      await window.api.settings.set({ key: 'systemPrompt', value: localSystemPrompt })
    }

    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  /** 切换 Provider 时自动选择第一个模型 */
  const handleProviderChange = (newProvider: string): void => {
    setProvider(newProvider)
    const providerConfig = PROVIDERS.find((p) => p.id === newProvider)
    if (providerConfig && providerConfig.models.length > 0) {
      setModel(providerConfig.models[0])
    }
  }

  if (!isSettingsOpen) return <></>

  return (
    <>
      {/* 遮罩层 */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={() => setIsSettingsOpen(false)}
      />

      {/* 设置面板 */}
      <div className="fixed right-0 top-0 bottom-0 w-[420px] bg-bg-secondary border-l border-border-secondary z-50 flex flex-col shadow-2xl">
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

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Provider 选择 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-2">
              AI 服务商
            </label>
            <div className="flex gap-2">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handleProviderChange(p.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    provider === p.id
                      ? 'bg-accent text-white'
                      : 'bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                  }`}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          {/* 模型选择 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-2">
              模型
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none cursor-pointer"
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          {/* 服务商配置（API Key + Base URL） */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-3">
              服务商配置
            </label>
            <div className="space-y-4">
              {PROVIDERS.map((p) => (
                <div key={p.id} className="p-3 bg-bg-primary/50 rounded-lg border border-border-secondary space-y-2">
                  <div className="text-xs font-medium text-text-primary">{p.name}</div>

                  {/* API Key */}
                  <div>
                    <label className="block text-[11px] text-text-tertiary mb-1">API Key</label>
                    <div className="flex items-center bg-bg-tertiary border border-border-primary rounded-lg overflow-hidden focus-within:border-accent/50 transition-colors">
                      <input
                        type={showKeys[p.id] ? 'text' : 'password'}
                        value={localApiKeys[p.id] || ''}
                        onChange={(e) =>
                          setLocalApiKeys((prev) => ({ ...prev, [p.id]: e.target.value }))
                        }
                        placeholder={`输入 ${p.name} API Key`}
                        className="flex-1 bg-transparent px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none"
                      />
                      <button
                        onClick={() => toggleKeyVisibility(p.id)}
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
                      value={localBaseUrls[p.id] || ''}
                      onChange={(e) =>
                        setLocalBaseUrls((prev) => ({ ...prev, [p.id]: e.target.value }))
                      }
                      placeholder={p.defaultBaseUrl}
                      className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 transition-colors"
                    />
                    <p className="text-[10px] text-text-tertiary mt-1">
                      留空使用默认地址，支持自定义代理或兼容 API
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 系统提示词 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-2">
              系统提示词
            </label>
            <textarea
              value={localSystemPrompt}
              onChange={(e) => setLocalSystemPrompt(e.target.value)}
              rows={4}
              className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none resize-none focus:border-accent/50 transition-colors leading-relaxed"
              placeholder="设定 AI 助手的角色和行为..."
            />
          </div>
        </div>

        {/* 底部保存按钮 */}
        <div className="px-6 py-4 border-t border-border-secondary">
          <button
            onClick={handleSave}
            className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
              saved
                ? 'bg-success/20 text-success'
                : 'bg-accent text-white hover:bg-accent-hover'
            }`}
          >
            <Save size={16} />
            {saved ? '已保存' : '保存设置'}
          </button>
        </div>
      </div>
    </>
  )
}
