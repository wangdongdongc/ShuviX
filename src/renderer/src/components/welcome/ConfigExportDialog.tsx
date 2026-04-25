import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Download, X } from 'lucide-react'
import type { ExportSnapshot, ExportOptions } from '../../../../shared/types/configShare'
import { useDialogClose } from '../../hooks/useDialogClose'
import { copyToClipboard } from '../../utils/clipboard'

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
    void window.api.config.buildExportSnapshot().then(setSnapshot)
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
      // 取消勾选 provider 时，同步移除其 models
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
    // 勾选 model 时自动勾选其 provider
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
      const encoded = await window.api.config.buildExportPayload(buildOptions())
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
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
      onClick={handleClose}
    >
      <div
        className="w-[560px] max-w-[90vw] bg-bg-primary border border-border-secondary rounded-xl shadow-xl max-h-[85vh] flex flex-col dialog-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-secondary/50 bg-bg-secondary/50">
          <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
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

        <div className="px-4 py-3 overflow-y-auto flex-1 min-h-0 space-y-4">
          <p className="text-[11px] text-text-tertiary leading-relaxed">
            {t('configShare.exportDesc')}
          </p>

          {snapshot === null ? (
            <div className="text-xs text-text-tertiary py-8 text-center">
              {t('common.refresh')}…
            </div>
          ) : isEmpty ? (
            <div className="text-xs text-text-tertiary py-8 text-center">
              {t('configShare.emptyExportHint')}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <button
                  onClick={selectAll}
                  className="px-2.5 py-1 rounded-md text-[11px] bg-bg-secondary border border-border-primary text-text-secondary hover:bg-bg-hover transition-colors"
                >
                  {t('configShare.selectAll')}
                </button>
                <button
                  onClick={selectNone}
                  className="px-2.5 py-1 rounded-md text-[11px] bg-bg-secondary border border-border-primary text-text-secondary hover:bg-bg-hover transition-colors"
                >
                  {t('configShare.selectNone')}
                </button>
              </div>

              {snapshot.providers.length > 0 && (
                <div className="zen-section">
                  <div className="text-[11px] font-medium text-text-secondary mb-2">
                    {t('configShare.sectionProviders')}
                  </div>
                  <div className="space-y-2">
                    {snapshot.providers.map((p) => {
                      const checked = selectedProviders.has(p.name)
                      return (
                        <div key={p.name} className="zen-card p-0 overflow-hidden">
                          <div className="flex items-center justify-between px-3 py-2 border-b border-border-primary/40">
                            <label className="flex items-center gap-2 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleProvider(p.name)}
                                className="rounded border-border-primary accent-accent w-3.5 h-3.5"
                              />
                              <span className="text-xs font-medium text-text-primary">
                                {p.displayName}
                              </span>
                              {p.isBuiltin && (
                                <span className="text-[10px] text-text-tertiary">
                                  {t('configShare.badgeBuiltin')}
                                </span>
                              )}
                            </label>
                            <label
                              className={`flex items-center gap-1.5 select-none ${checked ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'}`}
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
                                className="rounded border-border-primary accent-accent w-3 h-3"
                              />
                              <span className="text-[10px] text-text-secondary">
                                {t('configShare.includeApiKey')}
                              </span>
                            </label>
                          </div>
                          {p.models.length > 0 && (
                            <div className="px-3 py-2 grid grid-cols-2 gap-y-1 gap-x-3">
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
                  </div>
                </div>
              )}

              {snapshot.mcpServers.length > 0 && (
                <div className="zen-section">
                  <div className="text-[11px] font-medium text-text-secondary mb-2">
                    {t('configShare.sectionMcp')}
                  </div>
                  <div className="space-y-1">
                    {snapshot.mcpServers.map((s) => {
                      const checked = selectedMcps.has(s.name)
                      return (
                        <div
                          key={s.name}
                          className="flex items-center justify-between px-3 py-2 rounded-md bg-bg-secondary/40 border border-border-primary/40"
                        >
                          <label className="flex items-center gap-2 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => setSelectedMcps((prev) => toggleSet(prev, s.name))}
                              className="rounded border-border-primary accent-accent w-3.5 h-3.5"
                            />
                            <span className="text-xs text-text-primary">{s.name}</span>
                            <span className="text-[10px] text-text-tertiary uppercase">
                              {s.type}
                            </span>
                            {s.isBuiltin && (
                              <span className="text-[9px] text-amber-500 bg-amber-500/10 px-1 py-0.5 rounded">
                                {t('settings.mcpBuiltin')}
                              </span>
                            )}
                          </label>
                          <label
                            className={`flex items-center gap-1.5 select-none ${checked ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'}`}
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
                              className="rounded border-border-primary accent-accent w-3 h-3"
                            />
                            <span className="text-[10px] text-text-secondary">
                              {t('configShare.includeSensitive')}
                            </span>
                          </label>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-4 py-3 border-t border-border-secondary/50 bg-bg-secondary/30 flex items-center justify-between">
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
