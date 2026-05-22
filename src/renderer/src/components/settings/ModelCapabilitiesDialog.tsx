import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { useDialogClose } from '../../hooks/useDialogClose'
import { SettingsSection, SettingsRow, Toggle, InlineInput } from './SettingsPrimitives'

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

/** 模型能力编辑对话框 — 布尔能力 + Token 限制 + 定价（卡片式布局） */
export function ModelCapabilitiesDialog({
  modelId,
  capabilities,
  onSave,
  onClose
}: ModelCapabilitiesDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)
  const [saving, setSaving] = useState(false)

  // 编辑副本
  const [caps, setCaps] = useState<Record<string, unknown>>({ ...capabilities })

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

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

  /** 带单位后缀的数值输入 control */
  const numberWithUnit = (
    value: number | string | undefined,
    onChange: (v: string) => void,
    unit: string
  ): React.JSX.Element => (
    <div className="flex items-center gap-2">
      <InlineInput type="number" value={value ?? ''} onChange={onChange} width={120} />
      <span className="text-[10px] text-text-tertiary tabular-nums whitespace-nowrap">{unit}</span>
    </div>
  )

  return (
    <div
      onClick={handleClose}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 titlebar-no-drag dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[520px] max-w-[92vw] max-h-[88vh] flex flex-col dialog-panel"
      >
        {/* 头部 */}
        <div className="px-5 py-3 border-b border-border-secondary shrink-0 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-primary">
              {t('settings.editCapabilities')}
            </h3>
            <p className="text-[11px] text-text-tertiary mt-0.5 font-mono truncate">{modelId}</p>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors shrink-0"
          >
            <X size={14} />
          </button>
        </div>

        {/* 内容 */}
        <div className="px-5 py-5 overflow-y-auto flex-1 space-y-5">
          {/* 能力 */}
          <SettingsSection title={t('settings.capSectionModality')}>
            {BOOL_CAPS.map(({ key, labelKey, descKey }) => (
              <SettingsRow
                key={key}
                title={t(labelKey)}
                description={t(descKey)}
                control={<Toggle on={!!caps[key]} onClick={() => toggleBool(key)} />}
              />
            ))}
          </SettingsSection>

          {/* Token 限制 */}
          <SettingsSection title={t('settings.capSectionTokens')}>
            <SettingsRow
              title={t('settings.capMaxInputTokens')}
              description={t('settings.capMaxInputTokensDesc')}
              control={numberWithUnit(
                caps.maxInputTokens as number | undefined,
                (v) => setNumber('maxInputTokens', v),
                'tokens'
              )}
            />
            <SettingsRow
              title={t('settings.capMaxOutputTokens')}
              description={t('settings.capMaxOutputTokensDesc')}
              control={numberWithUnit(
                caps.maxOutputTokens as number | undefined,
                (v) => setNumber('maxOutputTokens', v),
                'tokens'
              )}
            />
          </SettingsSection>

          {/* 定价 */}
          <SettingsSection title={t('settings.capSectionPricing')}>
            <SettingsRow
              title={t('settings.capInputCost')}
              description={t('settings.capInputCostDesc')}
              control={numberWithUnit(
                getCostDisplay('inputCostPerToken'),
                (v) => setCostFromDisplay('inputCostPerToken', v),
                '$/M'
              )}
            />
            <SettingsRow
              title={t('settings.capOutputCost')}
              description={t('settings.capOutputCostDesc')}
              control={numberWithUnit(
                getCostDisplay('outputCostPerToken'),
                (v) => setCostFromDisplay('outputCostPerToken', v),
                '$/M'
              )}
            />
          </SettingsSection>
        </div>

        {/* 按钮 */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-secondary shrink-0">
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
