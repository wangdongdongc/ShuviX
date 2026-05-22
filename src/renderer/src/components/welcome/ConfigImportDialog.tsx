import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Upload, X } from 'lucide-react'
import type {
  ConfigSharePayload,
  ImportPlan,
  ImportResult,
  ImportSelection
} from '../../../../shared/types/configShare'
import { useDialogClose } from '../../hooks/useDialogClose'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { SettingsSection } from '../settings/SettingsPrimitives'

const PARSE_DEBOUNCE_MS = 300

type ParseState =
  | { status: 'idle' }
  | { status: 'parsing' }
  | { status: 'ok'; payload: ConfigSharePayload; plan: ImportPlan }
  | { status: 'error'; errorKey: string }

function mapParseError(err: unknown): string {
  const code = err instanceof Error ? err.message : String(err)
  switch (code) {
    case 'MAGIC_MISMATCH':
      return 'configShare.parseErrorMagic'
    case 'BASE64_INVALID':
      return 'configShare.parseErrorBase64'
    case 'JSON_INVALID':
      return 'configShare.parseErrorJson'
    case 'VERSION_UNSUPPORTED':
      return 'configShare.parseErrorVersion'
    case 'SCHEMA_INVALID':
      return 'configShare.parseErrorSchema'
    default:
      return 'configShare.parseErrorUnknown'
  }
}

export function ConfigImportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)
  const [text, setText] = useState('')
  const [parseState, setParseState] = useState<ParseState>({ status: 'idle' })
  const [selectedProviders, setSelectedProviders] = useState<Set<string>>(new Set())
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())
  const [selectedMcps, setSelectedMcps] = useState<Set<string>>(new Set())
  const [showConfirm, setShowConfirm] = useState(false)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleClose])

  // 防抖解析
  useEffect(() => {
    if (!text.trim()) {
      setParseState({ status: 'idle' })
      return
    }
    setParseState({ status: 'parsing' })
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const payload = await window.api.config.parseImportPayload(text)
          const plan = await window.api.config.planImport(payload)
          setParseState({ status: 'ok', payload, plan })
          setSelectedProviders(new Set(plan.providers.map((p) => p.name)))
          setSelectedModels(
            new Set(plan.providers.flatMap((p) => p.modelIds.map((id) => `${p.name}::${id}`)))
          )
          setSelectedMcps(new Set(plan.mcpServers.map((s) => s.name)))
        } catch (err) {
          setParseState({ status: 'error', errorKey: mapParseError(err) })
        }
      })()
    }, PARSE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text])

  const toggleSet = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  }

  const counts = useMemo(() => {
    if (parseState.status !== 'ok') return { create: 0, overwrite: 0 }
    let create = 0
    let overwrite = 0
    for (const p of parseState.plan.providers) {
      if (!selectedProviders.has(p.name)) continue
      if (p.action === 'create') create++
      else overwrite++
    }
    for (const s of parseState.plan.mcpServers) {
      if (!selectedMcps.has(s.name)) continue
      if (s.action === 'skipMissingBuiltin') continue
      if (s.action === 'create') create++
      else overwrite++
    }
    return { create, overwrite }
  }, [parseState, selectedProviders, selectedMcps])

  const nothingSelected = selectedProviders.size === 0 && selectedMcps.size === 0

  const buildSelection = (): ImportSelection => ({
    providerNames: Array.from(selectedProviders),
    modelKeys: Array.from(selectedModels),
    mcpNames: Array.from(selectedMcps)
  })

  const handleApply = async (): Promise<void> => {
    if (parseState.status !== 'ok' || applying) return
    setApplying(true)
    try {
      const res = await window.api.config.applyImport({
        payload: parseState.payload,
        selection: buildSelection()
      })
      setResult(res)
    } finally {
      setApplying(false)
      setShowConfirm(false)
    }
  }

  const renderActionBadge = (
    action: 'create' | 'overwrite' | 'mergeBuiltin' | 'skipMissingBuiltin'
  ): React.JSX.Element => {
    const labelKey =
      action === 'create'
        ? 'configShare.actionCreate'
        : action === 'overwrite'
          ? 'configShare.actionOverwrite'
          : action === 'skipMissingBuiltin'
            ? 'configShare.actionSkipMissingBuiltin'
            : 'configShare.actionMergeBuiltin'
    const color =
      action === 'create'
        ? 'text-success bg-success/10'
        : action === 'overwrite'
          ? 'text-warning bg-warning/10'
          : action === 'skipMissingBuiltin'
            ? 'text-error bg-error/10'
            : 'text-text-secondary bg-bg-tertiary/60'
    return (
      <span className={`px-1.5 py-0.5 rounded-md text-[9px] font-normal ${color}`}>
        {t(labelKey)}
      </span>
    )
  }

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
            <Upload size={14} />
            {t('configShare.importTitle')}
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
          {result ? (
            <ResultView result={result} />
          ) : (
            <>
              <p className="text-[11px] text-text-tertiary leading-relaxed px-1">
                {t('configShare.importDesc')}
              </p>

              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t('configShare.pastePlaceholder')}
                className="zen-textarea min-h-[120px] font-mono text-[11px] leading-relaxed"
                spellCheck={false}
              />

              {parseState.status === 'error' && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/5">
                  <X size={12} className="text-error shrink-0 mt-0.5" />
                  <p className="text-[11px] text-error leading-relaxed">{t(parseState.errorKey)}</p>
                </div>
              )}

              {parseState.status === 'ok' && (
                <>
                  <p className="text-[11px] text-text-tertiary leading-relaxed px-1">
                    {t('configShare.parseSuccessHint', {
                      providers: parseState.plan.providers.length,
                      mcp: parseState.plan.mcpServers.length
                    })}
                  </p>

                  {parseState.plan.providers.length > 0 && (
                    <SettingsSection title={t('configShare.sectionProviders')}>
                      {parseState.plan.providers.map((p) => {
                        const checked = selectedProviders.has(p.name)
                        return (
                          <div key={p.name} className="px-4 py-3">
                            <label className="flex items-center gap-2 cursor-pointer select-none min-w-0">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() =>
                                  setSelectedProviders((prev) => toggleSet(prev, p.name))
                                }
                                className="rounded border-border-primary accent-accent w-3.5 h-3.5 shrink-0"
                              />
                              <span className="text-[13px] font-medium text-text-primary truncate">
                                {p.name}
                              </span>
                              {renderActionBadge(p.action)}
                            </label>
                            {p.modelIds.length > 0 && (
                              <div className="mt-2 pl-6 grid grid-cols-2 gap-y-1 gap-x-3">
                                {p.modelIds.map((id) => {
                                  const key = `${p.name}::${id}`
                                  return (
                                    <label
                                      key={key}
                                      className="flex items-center gap-1.5 cursor-pointer select-none"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={selectedModels.has(key)}
                                        onChange={() =>
                                          setSelectedModels((prev) => toggleSet(prev, key))
                                        }
                                        className="rounded border-border-primary accent-accent w-3 h-3"
                                      />
                                      <span className="text-[11px] font-mono text-accent truncate">
                                        {id}
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

                  {parseState.plan.mcpServers.length > 0 && (
                    <SettingsSection title={t('configShare.sectionMcp')}>
                      {parseState.plan.mcpServers.map((s) => (
                        <label
                          key={s.name}
                          className="flex items-center gap-2 cursor-pointer select-none px-4 py-3"
                        >
                          <input
                            type="checkbox"
                            checked={selectedMcps.has(s.name)}
                            onChange={() => setSelectedMcps((prev) => toggleSet(prev, s.name))}
                            className="rounded border-border-primary accent-accent w-3.5 h-3.5 shrink-0"
                          />
                          <span className="text-[13px] text-text-primary truncate">{s.name}</span>
                          {renderActionBadge(s.action)}
                        </label>
                      ))}
                    </SettingsSection>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {/* 底部 */}
        <div className="px-5 py-3 border-t border-border-secondary shrink-0 flex items-center justify-end gap-2">
          <button
            onClick={handleClose}
            className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {result ? t('configShare.resultDone') : t('common.cancel')}
          </button>
          {!result && (
            <button
              onClick={() => setShowConfirm(true)}
              disabled={parseState.status !== 'ok' || nothingSelected || applying}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('configShare.applyButton')}
            </button>
          )}
        </div>
      </div>

      {showConfirm && (
        <ConfirmDialog
          title={t('configShare.confirmApplyTitle')}
          description={t('configShare.confirmApplyDesc', {
            create: counts.create,
            overwrite: counts.overwrite
          })}
          confirmText={t('configShare.applyButton')}
          cancelText={t('common.cancel')}
          danger
          onConfirm={() => void handleApply()}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  )
}

function ResultView({ result }: { result: ImportResult }): React.JSX.Element {
  const { t } = useTranslation()
  const totalOk =
    result.providers.filter((r) => r.ok).length + result.mcpServers.filter((r) => r.ok).length
  const totalFail =
    result.providers.filter((r) => !r.ok).length + result.mcpServers.filter((r) => !r.ok).length
  const items = [...result.providers, ...result.mcpServers]
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-text-secondary px-1">
        {t('configShare.resultSummary', { ok: totalOk, fail: totalFail })}
      </p>
      <SettingsSection title={t('configShare.resultDone')}>
        {items.map((r) => (
          <div key={r.name} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="text-[12px] text-text-primary truncate">{r.name}</span>
            {r.ok ? (
              <span className="text-[11px] text-success inline-flex items-center gap-1 shrink-0">
                <Check size={11} />
                {t('configShare.resultSuccess')}
              </span>
            ) : (
              <span
                className="text-[11px] text-error truncate ml-2 shrink-0 max-w-[260px]"
                title={r.error}
              >
                {t('configShare.resultFailure')}
                {r.error ? `: ${r.error}` : ''}
              </span>
            )}
          </div>
        ))}
      </SettingsSection>
    </div>
  )
}
