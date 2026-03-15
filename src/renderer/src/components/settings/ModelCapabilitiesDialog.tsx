import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useDialogClose } from '../../hooks/useDialogClose'

interface ModelCapabilitiesDialogProps {
  modelId: string
  capabilities: Record<string, unknown>
  onSave: (caps: Record<string, unknown>) => Promise<void>
  onClose: () => void
}

/** 布尔能力定义 */
const BOOL_CAPS = [
  { key: 'vision', labelKey: 'settings.capVision', descKey: 'settings.capVisionDesc' },
  {
    key: 'imageOutput',
    labelKey: 'settings.capImageOutput',
    descKey: 'settings.capImageOutputDesc'
  },
  {
    key: 'functionCalling',
    labelKey: 'settings.capFunctionCalling',
    descKey: 'settings.capFunctionCallingDesc'
  },
  { key: 'reasoning', labelKey: 'settings.capReasoning', descKey: 'settings.capReasoningDesc' },
  { key: 'audioInput', labelKey: 'settings.capAudioInput', descKey: 'settings.capAudioInputDesc' },
  {
    key: 'audioOutput',
    labelKey: 'settings.capAudioOutput',
    descKey: 'settings.capAudioOutputDesc'
  },
  { key: 'pdfInput', labelKey: 'settings.capPdfInput', descKey: 'settings.capPdfInputDesc' }
] as const

/**
 * 模型能力编辑对话框 — 布尔能力 + Token 限制 + 定价
 */
export function ModelCapabilitiesDialog({
  modelId,
  capabilities,
  onSave,
  onClose
}: ModelCapabilitiesDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const overlayRef = useRef<HTMLDivElement>(null)
  const { closing, handleClose } = useDialogClose(onClose)
  const [saving, setSaving] = useState(false)

  // 编辑副本
  const [caps, setCaps] = useState<Record<string, unknown>>({ ...capabilities })

  // ESC 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  // 点击遮罩关闭
  const handleOverlayClick = (e: React.MouseEvent): void => {
    if (e.target === overlayRef.current) handleClose()
  }

  const toggleBool = (key: string): void => {
    setCaps((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const setNumber = (key: string, value: string): void => {
    const num = value === '' ? undefined : Number(value)
    setCaps((prev) => ({ ...prev, [key]: num }))
  }

  /** 定价：UI 显示 $/M tokens，存储 per-token */
  const getCostDisplay = (key: string): string => {
    const v = caps[key]
    if (v === undefined || v === null || v === '') return ''
    const perToken = Number(v)
    if (isNaN(perToken) || perToken === 0) return ''
    return String(perToken * 1e6)
  }

  const setCostFromDisplay = (key: string, display: string): void => {
    if (display === '') {
      setCaps((prev) => ({ ...prev, [key]: undefined }))
      return
    }
    const perMillion = Number(display)
    if (isNaN(perMillion)) return
    setCaps((prev) => ({ ...prev, [key]: perMillion / 1e6 }))
  }

  const handleSubmit = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave(caps)
      handleClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[480px] max-w-[90vw] dialog-panel">
        {/* 标题 */}
        <div className="px-5 py-4 border-b border-border-secondary">
          <h3 className="text-sm font-semibold text-text-primary">
            {t('settings.editCapabilities')}
          </h3>
          <p className="text-[11px] text-text-tertiary mt-0.5 font-mono">{modelId}</p>
        </div>

        {/* 内容 — 可滚动 */}
        <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {/* 模态能力 */}
          <div>
            <div className="text-[11px] font-medium text-text-secondary mb-2">
              {t('settings.capSectionModality')}
            </div>
            <div className="space-y-2">
              {BOOL_CAPS.map(({ key, labelKey, descKey }) => (
                <div key={key} className="flex items-start gap-3">
                  <button
                    onClick={() => toggleBool(key)}
                    className={`mt-0.5 w-8 h-4.5 rounded-full relative transition-colors flex-shrink-0 ${
                      caps[key] ? 'bg-accent' : 'bg-bg-tertiary'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${
                        caps[key] ? 'left-[18px]' : 'left-0.5'
                      }`}
                    />
                  </button>
                  <div className="min-w-0">
                    <div className="text-xs text-text-primary">{t(labelKey)}</div>
                    <div className="text-[10px] text-text-tertiary">{t(descKey)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Token 限制 */}
          <div>
            <div className="text-[11px] font-medium text-text-secondary mb-2">
              {t('settings.capSectionTokens')}
            </div>
            <div className="space-y-2">
              <NumberField
                label={t('settings.capMaxInputTokens')}
                desc={t('settings.capMaxInputTokensDesc')}
                unit="tokens"
                value={caps.maxInputTokens as number | undefined}
                onChange={(v) => setNumber('maxInputTokens', v)}
              />
              <NumberField
                label={t('settings.capMaxOutputTokens')}
                desc={t('settings.capMaxOutputTokensDesc')}
                unit="tokens"
                value={caps.maxOutputTokens as number | undefined}
                onChange={(v) => setNumber('maxOutputTokens', v)}
              />
            </div>
          </div>

          {/* 定价 */}
          <div>
            <div className="text-[11px] font-medium text-text-secondary mb-2">
              {t('settings.capSectionPricing')}
            </div>
            <div className="space-y-2">
              <NumberField
                label={t('settings.capInputCost')}
                desc={t('settings.capInputCostDesc')}
                unit="$/M tokens"
                value={getCostDisplay('inputCostPerToken')}
                onChange={(v) => setCostFromDisplay('inputCostPerToken', v)}
              />
              <NumberField
                label={t('settings.capOutputCost')}
                desc={t('settings.capOutputCostDesc')}
                unit="$/M tokens"
                value={getCostDisplay('outputCostPerToken')}
                onChange={(v) => setCostFromDisplay('outputCostPerToken', v)}
              />
            </div>
          </div>
        </div>

        {/* 按钮 */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-secondary">
          <button
            onClick={handleClose}
            className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 数值输入字段 */
function NumberField({
  label,
  desc,
  unit,
  value,
  onChange
}: {
  label: string
  desc: string
  unit: string
  value: number | string | undefined
  onChange: (v: string) => void
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-xs text-text-primary">{label}</div>
        <div className="text-[10px] text-text-tertiary">{desc}</div>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <input
          type="number"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="zen-input w-28 text-right font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        <span className="text-[10px] text-text-tertiary w-16">{unit}</span>
      </div>
    </div>
  )
}
