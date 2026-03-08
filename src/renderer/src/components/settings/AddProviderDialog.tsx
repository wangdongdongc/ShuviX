import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useDialogClose } from '../../hooks/useDialogClose'

interface AddProviderDialogProps {
  onAdd: (provider: {
    name: string
    baseUrl: string
    apiKey: string
    apiProtocol: ProviderInfo['apiProtocol']
  }) => Promise<void>
  onClose: () => void
}

/**
 * 新增提供商弹窗 — 带淡入淡出动画
 */
export function AddProviderDialog({ onAdd, onClose }: AddProviderDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const overlayRef = useRef<HTMLDivElement>(null)
  const { closing, handleClose } = useDialogClose(onClose)

  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiProtocol, setApiProtocol] = useState<ProviderInfo['apiProtocol']>('openai-completions')
  const [adding, setAdding] = useState(false)

  const canSubmit = name.trim() && baseUrl.trim() && !adding

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

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return
    setAdding(true)
    try {
      await onAdd({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        apiProtocol
      })
      handleClose()
    } finally {
      setAdding(false)
    }
  }

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[400px] max-w-[90vw] dialog-panel">
        {/* 标题 */}
        <div className="px-5 py-4 border-b border-border-secondary">
          <h3 className="text-sm font-semibold text-text-primary">{t('settings.newProvider')}</h3>
        </div>

        {/* 表单 */}
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1">
              {t('settings.providerName')}
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings.providerNamePlaceholder')}
              className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 transition-colors"
            />
          </div>
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1">Base URL</label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 transition-colors font-mono"
            />
          </div>
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1">API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 transition-colors font-mono"
            />
          </div>
          <div>
            <label className="block text-[11px] text-text-tertiary mb-1">
              {t('settings.apiProtocol')}
            </label>
            <select
              value={apiProtocol}
              onChange={(e) => setApiProtocol(e.target.value as ProviderInfo['apiProtocol'])}
              className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none cursor-pointer"
            >
              <option value="openai-completions">{t('settings.protocolOpenAI')}</option>
              <option value="anthropic-messages">Anthropic Messages</option>
              <option value="google-generative-ai">Google Generative AI</option>
            </select>
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
