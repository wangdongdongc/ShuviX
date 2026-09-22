import { useTranslation } from 'react-i18next'
import { Loader2, MonitorOff, PlugZap, RefreshCw } from 'lucide-react'
import type { PanelLinkState } from '../shared/panelLink'

/**
 * 侧边栏还不能对话时的整屏说明 —— 为什么不能、用户该做什么。
 * 会话跑在桌面，所以「桌面没开」「本地组件没装」都是用户能自己解决的事，要说清楚。
 */
export function StatusView({
  state,
  error,
  onRetry
}: {
  state: Exclude<PanelLinkState, 'ready'> | 'opening' | 'error'
  error?: string
  onRetry?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const busy = state === 'connecting' || state === 'opening'
  const Icon = busy ? Loader2 : state === 'desktop-offline' ? MonitorOff : PlugZap
  const title = busy
    ? t('chromePanel.connecting')
    : state === 'host-missing'
      ? t('chromePanel.hostMissingTitle')
      : state === 'desktop-offline'
        ? t('chromePanel.offlineTitle')
        : state === 'mismatch'
          ? t('chromePanel.mismatchTitle')
          : t('chromePanel.errorTitle')
  const body =
    state === 'host-missing'
      ? t('chromePanel.hostMissingBody')
      : state === 'desktop-offline'
        ? t('chromePanel.offlineBody')
        : state === 'mismatch'
          ? t('chromePanel.mismatchBody')
          : state === 'error'
            ? error
            : undefined
  return (
    <div
      className="h-full flex flex-col items-center justify-center gap-3 px-8 text-center bg-bg-primary text-text-primary"
      data-panel-state={state}
    >
      <Icon size={28} className={`text-text-tertiary ${busy ? 'animate-spin' : ''}`} />
      <div className="text-[14px] font-medium">{title}</div>
      {body && (
        <div className="text-[12px] leading-relaxed text-text-secondary max-w-72">{body}</div>
      )}
      {onRetry && !busy && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-border-secondary px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        >
          <RefreshCw size={12} />
          {t('chromePanel.retry')}
        </button>
      )}
    </div>
  )
}
