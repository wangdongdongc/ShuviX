import { useTranslation } from 'react-i18next'
import { ChevronDown, Plus, X } from 'lucide-react'
import { useBrowserTabsStore, type BrowserTabInfo } from '../../stores/browserTabsStore'
import { TabFavicon } from './TabFavicon'
import { tabLabel } from './tabUtils'
import { showTabMenu, showTabSearchMenu } from './browserMenus'

/** macOS 交通灯占位：主进程 trafficLightPosition.x = 14，三颗灯约 52px 宽，留足余量 */
const MAC_TRAFFIC_LIGHT_PAD = 78

/**
 * 标签条 —— 浏览器窗口的标题栏就是它（Chrome 的样子）：交通灯右侧一排标签，后面一个 +，右端「搜索标签页」。
 *
 * 整条可拖动窗口（titlebar-drag），标签与按钮豁免。点标签选中它、中键关、右键出原生菜单；选中的标签与
 * 下面的工具条同底色、连成一片。标签上的圆点见 TabFavicon（agent 正接着这页）。
 */
export function BrowserTabStrip(): React.JSX.Element {
  const { t } = useTranslation()
  const tabs = useBrowserTabsStore((s) => s.tabs)
  const activeTabId = useBrowserTabsStore((s) => s.activeTabId)
  const createTab = useBrowserTabsStore((s) => s.createTab)
  const isMac = window.api.app.platform === 'darwin'

  return (
    <div
      className="titlebar-drag flex-shrink-0 flex items-end gap-1 h-9 pr-1.5 bg-bg-tertiary select-none"
      style={{ paddingLeft: isMac ? MAC_TRAFFIC_LIGHT_PAD : 8 }}
      data-browser-tab-strip
    >
      <div className="flex items-end min-w-0 flex-1 h-full" role="tablist">
        {tabs.map((tab, i) => (
          <TabItem
            key={tab.id}
            tab={tab}
            selected={tab.id === activeTabId}
            // 两个未选中的标签之间画一道竖线；挨着选中标签的那一侧不画
            divider={i > 0 && tab.id !== activeTabId && tabs[i - 1].id !== activeTabId}
          />
        ))}
        <button
          onClick={() => createTab()}
          className="titlebar-no-drag self-center flex-shrink-0 ml-1 p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/60 transition-colors"
          title={t('browser.newTab')}
          aria-label={t('browser.newTab')}
          data-browser-new-tab
        >
          <Plus size={15} />
        </button>
      </div>
      <button
        onClick={() => void showTabSearchMenu(t)}
        className="titlebar-no-drag self-center flex-shrink-0 p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/60 transition-colors"
        title={t('browser.searchTabs')}
        aria-label={t('browser.searchTabs')}
        data-browser-tab-search
      >
        <ChevronDown size={15} />
      </button>
    </div>
  )
}

function TabItem({
  tab,
  selected,
  divider
}: {
  tab: BrowserTabInfo
  selected: boolean
  divider: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const activateTab = useBrowserTabsStore((s) => s.activateTab)
  const closeTab = useBrowserTabsStore((s) => s.closeTab)
  const label = tabLabel(tab, t('browser.untitledTab'))
  const using =
    tab.cdpAttached && tab.agentSessionTitle
      ? `\n${t('browser.tabUsedBy', { session: tab.agentSessionTitle })}`
      : ''
  const tooltip = `${label}${tab.url && tab.url !== 'about:blank' ? `\n${tab.url}` : ''}${using}`

  return (
    <div
      role="tab"
      aria-selected={selected}
      title={tooltip}
      data-browser-tab={tab.id}
      data-selected={selected ? 'true' : undefined}
      onMouseDown={(e) => {
        // 中键关标签（Chrome）；左键在 mousedown 就选中，拖动手感与 Chrome 一致
        if (e.button === 1) {
          e.preventDefault()
          closeTab(tab.id)
        } else if (e.button === 0 && !selected) {
          activateTab(tab.id)
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        void showTabMenu(tab, t)
      }}
      className={`titlebar-no-drag group relative flex items-center gap-2 h-[30px] min-w-[44px] max-w-[220px] flex-[1_1_220px] pl-3 pr-1.5 rounded-t-lg cursor-default transition-colors ${
        selected ? 'bg-bg-primary text-text-primary' : 'text-text-secondary hover:bg-bg-hover/50'
      }`}
    >
      {divider && (
        <span className="absolute left-0 top-2 bottom-2 w-px bg-border-secondary/60 group-hover:opacity-0" />
      )}
      <TabFavicon tab={tab} />
      <span className="flex-1 min-w-0 truncate text-[12px] leading-none">{label}</span>
      <button
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          closeTab(tab.id)
        }}
        className={`flex-shrink-0 p-0.5 rounded-full text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-opacity ${
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
        title={t('browser.closeTab')}
        aria-label={t('browser.closeTab')}
        data-browser-tab-close
      >
        <X size={12} />
      </button>
    </div>
  )
}
