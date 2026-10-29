import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  ArrowRight,
  EllipsisVertical,
  LayoutGrid,
  RotateCw,
  Square,
  X
} from 'lucide-react'
import {
  selectedTab,
  useBrowserTabsStore,
  type BrowserViewMode
} from '../../stores/browserTabsStore'
import type { SearchEngineId } from './omnibox'
import { showMoreMenu } from './browserMenus'
import { Omnibox } from './OmniboxField'

const iconBtn =
  'flex-shrink-0 p-1.5 rounded-full text-text-secondary hover:bg-bg-hover/70 disabled:opacity-35 disabled:hover:bg-transparent transition-colors'

/**
 * 工具条 —— 标签条下面那一行：后退 / 前进 / 刷新、地址栏、视图切换、⋮ 菜单。
 * 一律作用于**选中的那一页**；单页视图与平铺墙共用（平铺墙里就是选中的那张卡片）。
 */
export function BrowserToolbar({
  engine,
  searchSuggest = true,
  viewMode,
  onViewMode
}: {
  engine: SearchEngineId
  /** 地址栏要不要向搜索引擎要搜索建议（设置页的「显示搜索建议」） */
  searchSuggest?: boolean
  viewMode: BrowserViewMode
  onViewMode: (mode: BrowserViewMode) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const tab = useBrowserTabsStore(selectedTab)
  const view = window.api.browserView

  return (
    <div
      className="flex-shrink-0 flex items-center gap-1 h-10 px-2 bg-bg-primary border-b border-border-secondary/40"
      data-browser-toolbar
    >
      <button
        className={iconBtn}
        disabled={!tab?.canGoBack}
        onClick={() => tab && void view.goBack(tab.id)}
        title={t('browser.back')}
        aria-label={t('browser.back')}
        data-browser-back
      >
        <ArrowLeft size={16} />
      </button>
      <button
        className={iconBtn}
        disabled={!tab?.canGoForward}
        onClick={() => tab && void view.goForward(tab.id)}
        title={t('browser.forward')}
        aria-label={t('browser.forward')}
        data-browser-forward
      >
        <ArrowRight size={16} />
      </button>
      {tab?.isLoading ? (
        <button
          className={iconBtn}
          onClick={() => void view.stop(tab.id)}
          title={t('browser.stop')}
          aria-label={t('browser.stop')}
          data-browser-stop
        >
          <X size={16} />
        </button>
      ) : (
        <button
          className={iconBtn}
          disabled={!tab || tab.url === 'about:blank' || tab.url.startsWith('shuvix://')}
          onClick={() => tab && void view.reload(tab.id)}
          title={t('browser.refresh')}
          aria-label={t('browser.refresh')}
          data-browser-reload
        >
          <RotateCw size={15} />
        </button>
      )}

      <Omnibox tab={tab} engine={engine} searchSuggest={searchSuggest} viewMode={viewMode} />

      <button
        className={iconBtn}
        onClick={() => onViewMode(viewMode === 'single' ? 'wall' : 'single')}
        title={t(viewMode === 'single' ? 'browser.view.wall' : 'browser.view.single')}
        aria-label={t(viewMode === 'single' ? 'browser.view.wall' : 'browser.view.single')}
        data-browser-view-toggle={viewMode}
      >
        {viewMode === 'single' ? <LayoutGrid size={15} /> : <Square size={15} />}
      </button>
      <button
        className={iconBtn}
        onClick={() => void showMoreMenu({ tab, viewMode, onViewMode, t })}
        title={t('browser.menu.more')}
        aria-label={t('browser.menu.more')}
        data-browser-more
      >
        <EllipsisVertical size={16} />
      </button>
    </div>
  )
}
