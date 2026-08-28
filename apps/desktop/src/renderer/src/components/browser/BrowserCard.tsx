import { startTransition, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  RotateCw,
  TriangleAlert,
  X
} from 'lucide-react'
import type { BrowserTabInfo } from '../../stores/browserStore'
import { CARD_LOGICAL_W, normalizeTargetUrl, tabLabel } from './tabUtils'

/** Chromium net error code 范围：CERT_* 在 -200 ~ -211 */
function isCertError(code: number): boolean {
  return code <= -200 && code >= -211
}

/** 卡片标题条上的站点图标；取不到（或加载失败）回落地球 */
function CardFavicon({ tab }: { tab: BrowserTabInfo }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (!tab.favicon || failed) {
    return <Globe size={10} className="flex-shrink-0 text-text-tertiary" />
  }
  return (
    <img
      src={tab.favicon}
      alt=""
      className="w-2.5 h-2.5 flex-shrink-0"
      onError={() => setFailed(true)}
    />
  )
}

export interface BrowserCardProps {
  tab: BrowserTabInfo
  /** 是否为激活 tab —— agent 的 browser 工具默认操作它 */
  isActive: boolean
  /**
   * 该卡片当前是否挂着真页面（WebContentsView）。
   * 滚动到一半的卡片拿不到 —— 原生 view 不能被 DOM 裁剪，只能整张显示或整张不显示，
   * 这时用 snapshot 顶上（DOM <img> 可以被正常裁剪）。
   */
  live: boolean
  /** 页面缩放百分比（卡片越小缩得越多，页面始终按桌面宽度排版） */
  zoomPercent: number
  /** 最近一次抓到的画面（dataURL），非 live 时顶上 */
  snapshot?: string
  onActivate: () => void
  onClose: () => void
  onNavigate: (url: string) => void
  onOpenExternal: () => void
  /** 注册 placeholder —— 只有真要显示页面的卡片才注册，未注册即不进布局表（主进程隐藏它） */
  registerPlaceholder: (el: HTMLDivElement | null) => void
}

/**
 * 一张浏览器卡片 —— 自带迷你工具条（前进/后退/刷新/地址栏/缩放比/外部打开/关闭），
 * 页面本体是主进程的 WebContentsView，叠在 placeholder 矩形上方。
 *
 * 空白页 / 加载失败时**不渲染 placeholder**：该 tab 不进布局表，主进程随即隐藏它的 view，
 * 位置让给这里的 DOM 提示与错误页（原生层盖在 DOM 之上，只能靠「不给矩形」让位）。
 */
export function BrowserCard({
  tab,
  isActive,
  live,
  zoomPercent,
  snapshot,
  onActivate,
  onClose,
  onNavigate,
  onOpenExternal,
  registerPlaceholder
}: BrowserCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const isBlank = !tab.url || tab.url === 'about:blank'
  const { loadError } = tab

  // 卡片自己的地址栏输入（每张卡各管各的）
  const [inputUrl, setInputUrl] = useState('')
  useEffect(() => {
    startTransition(() => setInputUrl(tab.url === 'about:blank' ? '' : tab.url))
  }, [tab.url])

  const view = window.api.browserView
  const btn =
    'flex-shrink-0 p-0.5 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'

  return (
    <div
      onClick={isActive ? undefined : onActivate}
      className={`relative flex flex-col h-full min-h-0 rounded-md overflow-hidden border transition-colors ${
        isActive ? 'border-accent/50' : 'border-border-secondary/40 hover:border-border-secondary'
      }`}
    >
      {/* ====== 卡片自己的迷你工具条 ====== */}
      <div className="flex-shrink-0 flex items-center gap-0.5 h-6 px-1 bg-bg-secondary/70 select-none">
        <button onClick={() => void view.goBack(tab.id)} title={t('browser.back')} className={btn}>
          <ArrowLeft size={11} />
        </button>
        <button
          onClick={() => void view.goForward(tab.id)}
          title={t('browser.forward')}
          className={btn}
        >
          <ArrowRight size={11} />
        </button>
        {tab.isLoading ? (
          <button onClick={() => void view.stop(tab.id)} title={t('browser.stop')} className={btn}>
            <X size={11} />
          </button>
        ) : (
          <button
            onClick={() => void view.reload(tab.id)}
            title={t('browser.refresh')}
            className={btn}
          >
            <RotateCw size={10} />
          </button>
        )}

        <form
          className="flex-1 min-w-0"
          onSubmit={(e) => {
            e.preventDefault()
            const target = normalizeTargetUrl(inputUrl)
            if (target) onNavigate(target)
          }}
        >
          <div className="flex items-center gap-1 bg-bg-primary/70 border border-border-secondary/50 rounded px-1 py-px transition-colors focus-within:border-accent/40">
            {tab.isLoading ? (
              <span className="h-2 w-2 flex-shrink-0 rounded-full border border-accent border-t-transparent animate-spin" />
            ) : (
              <CardFavicon tab={tab} />
            )}
            <input
              type="text"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              placeholder={t('panel.urlPlaceholder')}
              title={tabLabel(tab, t('browser.untitledTab'))}
              className="flex-1 min-w-0 bg-transparent text-[10px] leading-4 text-text-primary outline-none placeholder:text-text-tertiary"
            />
            {/* 当前页面缩放比 —— 位置对齐浏览器地址栏右端的缩放指示 */}
            <span
              className="flex-shrink-0 text-[9px] leading-4 tabular-nums text-text-tertiary/80"
              title={t('browser.zoomHint', { pct: zoomPercent, width: CARD_LOGICAL_W })}
            >
              {zoomPercent}%
            </span>
          </div>
        </form>

        <button
          onClick={(e) => {
            e.stopPropagation()
            onOpenExternal()
          }}
          title={t('browser.openExternal')}
          className={btn}
        >
          <ExternalLink size={10} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          title={t('browser.closeTab')}
          className={btn}
        >
          <X size={11} />
        </button>
      </div>

      <div className="flex-1 min-h-0 relative bg-bg-primary">
        {/* 加载进度条 */}
        {tab.isLoading && !isBlank && (
          <div className="absolute top-0 left-0 right-0 h-0.5 z-10">
            <div className="h-full bg-accent animate-browser-loading" />
          </div>
        )}

        {isBlank ? (
          <div className="flex items-center justify-center h-full select-none">
            <p className="text-xs text-text-tertiary/40">{t('panel.urlPlaceholder')}</p>
          </div>
        ) : loadError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-3 bg-bg-primary">
            <TriangleAlert size={20} className="text-amber-500/80 mb-1" />
            <h2 className="text-[11px] font-medium text-text-primary mb-1">
              {t('browser.error.title')}
            </h2>
            <p className="text-[11px] text-text-secondary mb-1 text-center">
              {t('browser.error.code', {
                code: loadError.errorCode,
                description: loadError.errorDescription
              })}
            </p>
            {isCertError(loadError.errorCode) && (
              <p className="text-[11px] text-amber-500/90 mb-1 text-center max-w-md">
                {t('browser.error.certHint')}
              </p>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation()
                onNavigate(loadError.url || tab.url)
              }}
              className="mt-1 px-2 py-0.5 rounded-md text-[10px] bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
            >
              {t('browser.error.retry')}
            </button>
          </div>
        ) : (
          /* WebContentsView 占位区域 —— 该 tab 的 view 叠放在此 div 上方 */
          <div ref={registerPlaceholder} className="relative w-full h-full">
            {!live &&
              (snapshot ? (
                <img
                  src={snapshot}
                  alt=""
                  draggable={false}
                  className="absolute inset-0 w-full h-full object-cover object-top opacity-90"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center bg-bg-secondary/40">
                  <span className="px-2 text-[10px] text-text-tertiary truncate">
                    {tabLabel(tab, t('browser.untitledTab'))}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}
