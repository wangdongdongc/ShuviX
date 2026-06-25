import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, Copy, Download, Loader2, X } from 'lucide-react'
import type { ExportSnapshot, ExportOptions } from '@shuvix/chat-protocol/types/configShare'
import { getChatApi, useDialogClose, copyToClipboard } from '@shuvix/chat-ui'
import { SettingsSection } from '../settings/SettingsPrimitives'

/** 配置导出对话框（桌面/扩展共用）—— 经 getChatApi().config 取后端，宿主无关。 */
export function ConfigExportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)
  const [snapshot, setSnapshot] = useState<ExportSnapshot | null>(null)
  const [selectedProviders, setSelectedProviders] = useState<Set<string>>(new Set())
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())
  const [selectedMcps, setSelectedMcps] = useState<Set<string>>(new Set())
  const [includeApiKey, setIncludeApiKey] = useState<Record<string, boolean>>({})
  const [includeSensitive, setIncludeSensitive] = useState<Record<string, boolean>>({})
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void getChatApi().config.buildExportSnapshot().then(setSnapshot)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleClose])

  const allModelKeys = useMemo(() => {
    if (!snapshot) return [] as string[]
    return snapshot.providers.flatMap((p) => p.models.map((m) => `${p.name}::${m.modelId}`))
  }, [snapshot])

  const toggleSet = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  }

  const toggleProvider = (name: string): void => {
    setSelectedProviders((prev) => {
      const next = toggleSet(prev, name)
      if (!next.has(name)) {
        setSelectedModels((prevM) => {
          const nextM = new Set(prevM)
          for (const k of nextM) if (k.startsWith(`${name}::`)) nextM.delete(k)
          return nextM
        })
      }
      return next
    })
  }

  const toggleModel = (providerName: string, modelId: string): void => {
    const key = `${providerName}::${modelId}`
    setSelectedModels((prev) => toggleSet(prev, key))
    setSelectedProviders((prev) => {
      if (prev.has(providerName)) return prev
      const next = new Set(prev)
      next.add(providerName)
      return next
    })
  }

  const selectAll = (): void => {
    if (!snapshot) return
    setSelectedProviders(new Set(snapshot.providers.map((p) => p.name)))
    setSelectedModels(new Set(allModelKeys))
    setSelectedMcps(new Set(snapshot.mcpServers.map((s) => s.name)))
    // 同时勾选所有敏感信息开关
    setIncludeApiKey(Object.fromEntries(snapshot.providers.map((p) => [p.name, true])))
    setIncludeSensitive(Object.fromEntries(snapshot.mcpServers.map((s) => [s.name, true])))
  }

  const selectNone = (): void => {
    setSelectedProviders(new Set())
    setSelectedModels(new Set())
    setSelectedMcps(new Set())
  }

  const buildOptions = (): ExportOptions => {
    if (!snapshot) return { providers: [], mcpServers: [] }
    const providers = snapshot.providers
      .filter((p) => selectedProviders.has(p.name))
      .map((p) => ({
        name: p.name,
        includeApiKey: Boolean(includeApiKey[p.name]),
        modelIds: p.models
          .filter((m) => selectedModels.has(`${p.name}::${m.modelId}`))
          .map((m) => m.modelId)
      }))
    const mcpServers = snapshot.mcpServers
      .filter((s) => selectedMcps.has(s.name))
      .map((s) => ({ name: s.name, includeSensitive: Boolean(includeSensitive[s.name]) }))
    return { providers, mcpServers }
  }

  const handleCopy = async (): Promise<void> => {
    if (copying) return
    setCopying(true)
    try {
      const encoded = await getChatApi().config.buildExportPayload(buildOptions())
      copyToClipboard(encoded)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } finally {
      setCopying(false)
    }
  }

  const nothingSelected = selectedProviders.size === 0 && selectedMcps.size === 0
  const isEmpty =
    snapshot !== null && snapshot.providers.length === 0 && snapshot.mcpServers.length === 0

  return (
    <div
      onClick={handleClose}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 titlebar-no-drag dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[600px] max-w-[92vw] max-h-[88vh] flex flex-col dialog-panel"
      >
        {/* 头部 */}
        <div className="px-5 py-3 border-b border-border-secondary shrink-0 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary inline-flex items-center gap-2">
            <Download size={14} />
            {t('configShare.exportTitle')}
          </h3>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* 内容 */}
        <div className="px-5 py-5 overflow-y-auto flex-1 min-h-0 space-y-5">
          <p className="text-[11px] text-text-tertiary leading-relaxed px-1">
            {t('configShare.exportDesc')}
          </p>

          {snapshot === null ? (
            <div className="flex items-center justify-center gap-2 py-10 text-text-tertiary">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-[11px]">{t('common.loading') || 'Loading...'}</span>
            </div>
          ) : isEmpty ? (
            <div className="text-[11px] text-text-tertiary py-10 text-center">
              {t('configShare.emptyExportHint')}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1 px-1">
                <button
                  onClick={selectAll}
                  className="px-2 py-1 rounded text-[11px] text-accent hover:bg-accent/10 transition-colors"
                >
                  {t('configShare.selectAll')}
                </button>
                <button
                  onClick={selectNone}
                  className="px-2 py-1 rounded text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
                >
                  {t('configShare.selectNone')}
                </button>
              </div>

              {snapshot.providers.length > 0 && (
                <SettingsSection title={t('configShare.sectionProviders')}>
                  {snapshot.providers.map((p) => {
                    const checked = selectedProviders.has(p.name)
                    return (
                      <div key={p.name} className="px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <label className="flex items-center gap-2 cursor-pointer select-none min-w-0">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleProvider(p.name)}
                              className="rounded border-border-primary accent-accent w-3.5 h-3.5 shrink-0"
                            />
                            <span className="text-[13px] font-medium text-text-primary truncate">
                              {p.displayName}
                            </span>
                            {p.isBuiltin && (
                              <span className="text-[9px] font-normal text-text-tertiary bg-bg-tertiary/60 px-1.5 py-0.5 rounded-md shrink-0">
                                {t('configShare.badgeBuiltin')}
                              </span>
                            )}
                          </label>
                          <label
                            className={`flex items-center gap-1.5 select-none shrink-0 ${
                              checked ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'
                            }`}
                          >
                            <input
                              type="checkbox"
                              disabled={!checked}
                              checked={Boolean(includeApiKey[p.name])}
                              onChange={(e) =>
                                setIncludeApiKey((prev) => ({
                                  ...prev,
                                  [p.name]: e.target.checked
                                }))
                              }
                              className="rounded border-border-primary w-3 h-3 accent-red-500"
                            />
                            <AlertTriangle size={10} className="text-error" />
                            <span className="text-[11px] text-error">
                              {t('configShare.includeApiKey')}
                            </span>
                          </label>
                        </div>
                        {p.models.length > 0 && (
                          <div className="mt-2 pl-6 grid grid-cols-2 gap-y-1 gap-x-3">
                            {p.models.map((m) => {
                              const key = `${p.name}::${m.modelId}`
                              return (
                                <label
                                  key={key}
                                  className="flex items-center gap-1.5 cursor-pointer select-none"
                                >
                                  <input
                                    type="checkbox"
                                    checked={selectedModels.has(key)}
                                    onChange={() => toggleModel(p.name, m.modelId)}
                                    className="rounded border-border-primary accent-accent w-3 h-3"
                                  />
                                  <span className="text-[11px] font-mono text-accent truncate">
                                    {m.modelId}
                                  </span>
                                </label>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </SettingsSection>
              )}

              {snapshot.mcpServers.length > 0 && (
                <SettingsSection title={t('configShare.sectionMcp')}>
                  {snapshot.mcpServers.map((s) => {
                    const checked = selectedMcps.has(s.name)
                    return (
                      <div
                        key={s.name}
                        className="flex items-center justify-between gap-3 px-4 py-3"
                      >
                        <label className="flex items-center gap-2 cursor-pointer select-none min-w-0">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => setSelectedMcps((prev) => toggleSet(prev, s.name))}
                            className="rounded border-border-primary accent-accent w-3.5 h-3.5 shrink-0"
                          />
                          <span className="text-[13px] text-text-primary truncate">{s.name}</span>
                          <span className="text-[9px] font-normal text-text-tertiary bg-bg-tertiary/60 px-1.5 py-0.5 rounded-md uppercase shrink-0">
                            {s.type}
                          </span>
                          {s.isBuiltin && (
                            <span className="text-[9px] font-normal text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded-md shrink-0">
                              {t('settings.mcpBuiltin')}
                            </span>
                          )}
                        </label>
                        <label
                          className={`flex items-center gap-1.5 select-none shrink-0 ${
                            checked ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'
                          }`}
                        >
                          <input
                            type="checkbox"
                            disabled={!checked}
                            checked={Boolean(includeSensitive[s.name])}
                            onChange={(e) =>
                              setIncludeSensitive((prev) => ({
                                ...prev,
                                [s.name]: e.target.checked
                              }))
                            }
                            className="rounded border-border-primary w-3 h-3 accent-red-500"
                          />
                          <AlertTriangle size={10} className="text-error" />
                          <span className="text-[11px] text-error">
                            {t('configShare.includeSensitive')}
                          </span>
                        </label>
                      </div>
                    )
                  })}
                </SettingsSection>
              )}
            </>
          )}
        </div>

        {/* 底部 */}
        <div className="px-5 py-3 border-t border-border-secondary shrink-0 flex items-center justify-between">
          {copied ? (
            <span className="text-[11px] text-success inline-flex items-center gap-1">
              <Check size={12} />
              {t('configShare.copiedHint')}
            </span>
          ) : (
            <span className="text-[11px] text-text-tertiary">
              {t('configShare.exportFooterHint')}
            </span>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={handleClose}
              className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
            >
              {t('common.close')}
            </button>
            <button
              onClick={() => void handleCopy()}
              disabled={nothingSelected || copying}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            >
              <Copy size={12} />
              {t('configShare.copyToClipboard')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
