import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, ShieldAlert, TriangleAlert } from 'lucide-react'
import type { BrowserTabInfo } from '../../stores/browserTabsStore'
import { resolveOmniboxInput, SEARCH_ENGINES, type SearchEngineId } from './omnibox'

/** Chromium net error code 范围：CERT_* 在 -200 ~ -211 */
function isCertError(code: number): boolean {
  return code <= -200 && code >= -211
}

/**
 * 页面区不放原生页面时的两张 DOM 脸：新标签页与错误页。
 *
 * 原生 view 画在 DOM 之上，这两种情况下该 tab **不进布局表**（主进程随即把它的 view 停回停放窗口），
 * 位置让给这里 —— 单页视图与平铺墙的卡片共用；`compact` 是卡片里的小号。
 */

/**
 * 新标签页：一个居中的搜索框（地址栏同一套判断：像网址就打开，否则搜索）。
 * `onFocusOmnibox`：照 Chrome 的新标签页，框一拿到焦点就把光标交给地址栏 —— 在那里打字才有下拉建议。
 */
export function NewTabPage({
  engine,
  onNavigate,
  onFocusOmnibox,
  compact
}: {
  engine: SearchEngineId
  onNavigate: (url: string) => void
  onFocusOmnibox?: () => void
  compact?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const placeholder = t('browser.omniboxPlaceholder', { engine: SEARCH_ENGINES[engine].name })
  if (compact) {
    return (
      <div className="flex items-center justify-center h-full select-none" data-new-tab-page>
        <p className="text-xs text-text-tertiary/60">{t('browser.untitledTab')}</p>
      </div>
    )
  }
  return (
    <div
      className="flex flex-col items-center justify-center h-full px-6 select-none"
      data-new-tab-page
    >
      <form
        className="w-full max-w-[560px]"
        onSubmit={(e) => {
          e.preventDefault()
          const target = resolveOmniboxInput(text, engine)
          if (target) onNavigate(target)
        }}
      >
        <label className="flex items-center gap-3 h-11 px-4 rounded-full bg-bg-secondary border border-border-secondary/50 transition-colors focus-within:border-accent/50 hover:bg-bg-hover/40">
          <Search size={16} className="flex-shrink-0 text-text-tertiary" />
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={(e) => {
              if (!onFocusOmnibox) return
              e.currentTarget.blur()
              onFocusOmnibox()
            }}
            placeholder={placeholder}
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </label>
      </form>
    </div>
  )
}

/**
 * 证书错误的整页警告（Chrome 的「您的连接不是私密连接」）：主进程把这次加载挡下了（不弹框），这里说明情况；
 * 「返回安全的页面」后退（没有可退的就回新标签页）；「高级」展开后才有「继续前往（不安全）」——
 * 点它主进程放行这个站点直到退出，再重新加载。按钮在外壳的 DOM 里，agent 点不到。
 */
function CertInterstitial({
  tab,
  compact
}: {
  tab: BrowserTabInfo
  compact?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [advanced, setAdvanced] = useState(false)
  const failedUrl = tab.loadError?.url || tab.url
  let host = failedUrl
  try {
    host = new URL(failedUrl).host
  } catch {
    // 留原样
  }
  const view = window.api.browserView
  const back = (): void => {
    if (tab.canGoBack) void view.goBack(tab.id)
    else void view.navigate(tab.id, 'about:blank')
  }
  const text = compact ? 'text-[11px]' : 'text-[13px]'
  return (
    <div
      className={`absolute inset-0 overflow-y-auto bg-bg-primary ${compact ? 'px-4 py-4' : 'px-8 py-16'}`}
      data-page-error="cert"
      data-cert-interstitial={host}
    >
      <div className="mx-auto max-w-[560px]">
        <ShieldAlert size={compact ? 24 : 44} className="text-error mb-4" />
        <h2
          className={`${compact ? 'text-[13px]' : 'text-[22px]'} font-medium text-text-primary mb-3`}
        >
          {t('browser.certError.title')}
        </h2>
        <p className={`${text} text-text-secondary leading-relaxed mb-2`}>
          {t('browser.certError.detail', { host })}
        </p>
        <p className="text-[11px] font-mono text-text-tertiary mb-6">
          net::{tab.loadError?.errorDescription || 'ERR_CERT_INVALID'}
        </p>
        <div className="flex items-center justify-between gap-3">
          <button
            onClick={(e) => {
              e.stopPropagation()
              setAdvanced((v) => !v)
            }}
            className={`${text} text-text-secondary hover:text-text-primary underline-offset-2 hover:underline`}
            data-cert-advanced
          >
            {t(advanced ? 'browser.certError.hideAdvanced' : 'browser.certError.advanced')}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              back()
            }}
            className={`rounded-md bg-accent text-white hover:bg-accent-hover transition-colors ${
              compact ? 'px-2.5 py-1 text-[11px]' : 'px-4 py-1.5 text-[13px]'
            }`}
            data-cert-back
          >
            {t('browser.certError.back')}
          </button>
        </div>
        {advanced && (
          <div className={`mt-6 pt-4 border-t border-border-secondary/40 ${text} leading-relaxed`}>
            <p className="text-text-secondary mb-3">
              {t('browser.certError.advancedDetail', { host })}
            </p>
            <button
              onClick={(e) => {
                e.stopPropagation()
                void view.proceedUnsafe(tab.id)
              }}
              className="text-error underline underline-offset-2 hover:opacity-80"
              data-cert-proceed
            >
              {t('browser.certError.proceed', { host })}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** 打不开 / 崩了的页面：说明 + 重试（重试按出错的那个地址导航）；证书错误换成整页警告 */
export function PageErrorView({
  tab,
  onRetry,
  compact
}: {
  tab: BrowserTabInfo
  onRetry: (url: string) => void
  compact?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const { loadError } = tab
  if (!loadError) return null
  if (!loadError.crashed && isCertError(loadError.errorCode)) {
    return <CertInterstitial tab={tab} compact={compact} />
  }
  const text = compact ? 'text-[11px]' : 'text-[13px]'
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center px-4 bg-bg-primary"
      data-page-error={loadError.crashed ? 'crashed' : 'failed'}
    >
      <TriangleAlert size={compact ? 20 : 32} className="text-amber-500/80 mb-2" />
      <h2
        className={`${compact ? 'text-[11px]' : 'text-[16px]'} font-medium text-text-primary mb-1`}
      >
        {t(loadError.crashed ? 'browser.error.crashedTitle' : 'browser.error.title')}
      </h2>
      <p className={`${text} text-text-secondary mb-1 text-center`}>
        {loadError.crashed
          ? t('browser.error.crashedDetail', { reason: loadError.errorDescription })
          : t('browser.error.code', {
              code: loadError.errorCode,
              description: loadError.errorDescription
            })}
      </p>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onRetry(loadError.url || tab.url)
        }}
        className={`mt-2 rounded-md bg-accent/15 text-accent hover:bg-accent/25 transition-colors ${
          compact ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-1 text-[12px]'
        }`}
      >
        {t('browser.error.retry')}
      </button>
    </div>
  )
}
