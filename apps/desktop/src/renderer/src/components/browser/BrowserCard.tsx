import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import type { BrowserTabInfo } from '../../stores/browserTabsStore'
import { tabLabel } from './tabUtils'
import { TabFavicon } from './TabFavicon'
import { NewTabPage, PageErrorView } from './PageFaces'
import { showTabMenu } from './browserMenus'
import { DEFAULT_SEARCH_ENGINE } from './omnibox'

export interface BrowserCardProps {
  tab: BrowserTabInfo
  /** 是否为用户选中的那一页 —— 上面的工具条与地址栏作用于它 */
  isActive: boolean
  /**
   * 该卡片当前是否挂着真页面（WebContentsView）。
   * 滚动到一半的卡片拿不到 —— 原生 view 不能被 DOM 裁剪，只能整张显示或整张不显示，
   * 这时用 snapshot 顶上（DOM <img> 可以被正常裁剪）。
   */
  live: boolean
  /** 最近一次抓到的画面（dataURL），非 live 时顶上 */
  snapshot?: string
  onActivate: () => void
  onClose: () => void
  onNavigate: (url: string) => void
  /** 注册 placeholder —— 只有真要显示页面的卡片才注册，未注册即不进布局表（主进程把它停回停放窗口） */
  registerPlaceholder: (el: HTMLDivElement | null) => void
}

/**
 * 平铺墙上的一张卡片：卡片头（图标、标题、关闭）+ 页面。
 *
 * 不再自带工具条 —— 后退 / 前进 / 刷新 / 地址栏在窗口顶上，作用于选中的那张；点卡片就是选中它。
 * 页面本体是主进程的 WebContentsView，叠在 placeholder 矩形上方。空白页 / 加载失败时**不渲染
 * placeholder**：该 tab 不进布局表，主进程随即把它的 view 停回停放窗口，位置让给这里的 DOM 提示与错误页。
 */
export function BrowserCard({
  tab,
  isActive,
  live,
  snapshot,
  onActivate,
  onClose,
  onNavigate,
  registerPlaceholder
}: BrowserCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const isBlank = !tab.url || tab.url === 'about:blank'
  const label = tabLabel(tab, t('browser.untitledTab'))

  return (
    <div
      onMouseDown={isActive ? undefined : onActivate}
      onContextMenu={(e) => {
        e.preventDefault()
        void showTabMenu(tab, t)
      }}
      data-browser-card={tab.id}
      data-active={isActive ? 'true' : undefined}
      className={`relative flex flex-col h-full min-h-0 rounded-lg overflow-hidden border transition-colors ${
        isActive
          ? 'border-accent/60 ring-1 ring-accent/30'
          : 'border-border-secondary/40 hover:border-border-secondary'
      }`}
    >
      <div
        className={`flex-shrink-0 flex items-center gap-2 h-7 pl-2.5 pr-1 select-none ${
          isActive ? 'bg-bg-secondary' : 'bg-bg-tertiary'
        }`}
        title={tab.url && !isBlank ? `${label}\n${tab.url}` : label}
      >
        <TabFavicon tab={tab} size={12} />
        <span className="flex-1 min-w-0 truncate text-[11px] text-text-secondary">{label}</span>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          title={t('browser.closeTab')}
          aria-label={t('browser.closeTab')}
          className="flex-shrink-0 p-0.5 rounded-full text-text-tertiary hover:text-text-primary hover:bg-bg-hover"
        >
          <X size={11} />
        </button>
      </div>

      <div className="flex-1 min-h-0 relative bg-bg-primary">
        {isBlank ? (
          <NewTabPage engine={DEFAULT_SEARCH_ENGINE} onNavigate={onNavigate} compact />
        ) : tab.loadError ? (
          <PageErrorView tab={tab} onRetry={onNavigate} compact />
        ) : (
          /* WebContentsView 占位区域 —— 该 tab 的 view 叠放在此 div 上方 */
          <div ref={registerPlaceholder} data-page-area className="relative w-full h-full">
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
                  <span className="px-2 text-[10px] text-text-tertiary truncate">{label}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}
