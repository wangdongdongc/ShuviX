import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { API_PROTOCOL_OPTIONS } from '@shuvix/chat-protocol/types/provider'
import { useDialogClose } from '@shuvix/chat-ui'
import {
  SettingsSection,
  SettingsRow,
  SettingsBlock,
  InlineInput,
  InlineSelect
} from './SettingsPrimitives'

interface AddProviderDialogProps {
  onAdd: (provider: {
    name: string
    baseUrl: string
    apiKey: string
    apiProtocol: ProviderInfo['apiProtocol']
    metadata?: string
  }) => Promise<void>
  onClose: () => void
}

/** 新增提供商弹窗（卡片式） */
export function AddProviderDialog({ onAdd, onClose }: AddProviderDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)

  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiProtocol, setApiProtocol] = useState<ProviderInfo['apiProtocol']>('openai-completions')
  const [customHeaders, setCustomHeaders] = useState('')
  const [adding, setAdding] = useState(false)

  const canSubmit = name.trim() && baseUrl.trim() && !adding

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handleClose])

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return
    let metadata: string | undefined
    if (customHeaders.trim()) {
      try {
        metadata = JSON.stringify({ customHeaders: JSON.parse(customHeaders.trim()) })
      } catch {
        return // 无效 JSON，不提交
      }
    }
    setAdding(true)
    try {
      await onAdd({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        apiProtocol,
        metadata
      })
      handleClose()
    } finally {
      setAdding(false)
    }
  }

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
        <div className="px-5 py-3 border-b border-border-secondary shrink-0 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">{t('settings.newProvider')}</h3>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* 内容 */}
        <div className="px-5 py-5 overflow-y-auto flex-1 space-y-5">
          <SettingsSection title={t('settings.providerConfigGroup')}>
            <SettingsRow
              title={t('settings.providerName')}
              control={
                <InlineInput
                  value={name}
                  onChange={setName}
                  placeholder={t('settings.providerNamePlaceholder')}
                  autoFocus
                  width={260}
                />
              }
            />
            <SettingsRow
              title="Base URL"
              control={
                <InlineInput
                  value={baseUrl}
                  onChange={setBaseUrl}
                  placeholder="https://api.example.com/v1"
                  monospace
                  width={260}
                />
              }
            />
            <SettingsRow
              title="API Key"
              control={
                <InlineInput
                  type="password"
                  value={apiKey}
                  onChange={setApiKey}
                  placeholder="sk-..."
                  monospace
                  width={260}
                />
              }
            />
            <SettingsRow
              title={t('settings.apiProtocol')}
              control={
                <InlineSelect
                  value={apiProtocol}
                  onChange={(v) => setApiProtocol(v as ProviderInfo['apiProtocol'])}
                  width={260}
                >
                  {API_PROTOCOL_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {t(p.labelKey)}
                    </option>
                  ))}
                </InlineSelect>
              }
            />
          </SettingsSection>

          <SettingsSection title={t('settings.customHeaders')}>
            <SettingsBlock>
              <textarea
                value={customHeaders}
                onChange={(e) => setCustomHeaders(e.target.value)}
                placeholder={t('settings.customHeadersPlaceholder')}
                rows={3}
                className="zen-textarea font-mono text-[11px]"
              />
            </SettingsBlock>
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
            disabled={!canSubmit}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {adding ? t('common.adding') : t('common.add')}
          </button>
        </div>
      </div>
    </div>
  )
}
