import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, Plus, X } from 'lucide-react'
import { useBrowserStore, type BrowserTabInfo } from '../../stores/browserStore'

/** tab 标题：title → URL host → 空白页文案 */
function tabLabel(tab: BrowserTabInfo, untitled: string): string {
  if (tab.title) return tab.title
  if (tab.url && tab.url !== 'about:blank') {
    try {
      return new URL(tab.url).host || tab.url
    } catch {
      return tab.url
    }
  }
  return untitled
}

function TabFavicon({ tab }: { tab: BrowserTabInfo }): React.JSX.Element {
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

/**
 * 浏览器 tab 条 —— 面板内的网页标签页（与右侧面板的功能页签 PanelTabBar 无关）。
 * tab 状态是主进程真源的镜像（useBrowserTabsBridge），这里只发切换/关闭/新建指令。
 */
export function BrowserTabBar(): React.JSX.Element | null {
  const { t } = useTranslation()
  const tabs = useBrowserStore((s) => s.tabs)
  const activeTabId = useBrowserStore((s) => s.activeTabId)
  const activateTab = useBrowserStore((s) => s.activateTab)
  const closeTab = useBrowserStore((s) => s.closeTab)
  const createTab = useBrowserStore((s) => s.createTab)

  if (tabs.length === 0) return null

  return (
    <div className="titlebar-no-drag flex-shrink-0 flex items-center gap-0.5 px-1.5 pt-1 border-b border-border-secondary/30 overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            onClick={() => activateTab(tab.id)}
            title={tab.url !== 'about:blank' ? tab.url : undefined}
            className={`group flex items-center gap-1 min-w-0 max-w-36 px-1.5 py-1 rounded-t-md cursor-default select-none transition-colors ${
              isActive
                ? 'bg-bg-secondary text-text-primary'
                : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50'
            }`}
          >
            {tab.isLoading ? (
              <span className="h-2 w-2 flex-shrink-0 rounded-full border border-accent border-t-transparent animate-spin" />
            ) : (
              <TabFavicon tab={tab} />
            )}
            <span className="flex-1 min-w-0 truncate text-[10px] leading-none">
              {tabLabel(tab, t('browser.untitledTab'))}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
              title={t('browser.closeTab')}
              className={`flex-shrink-0 p-px rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary ${
                isActive ? '' : 'opacity-0 group-hover:opacity-100'
              }`}
            >
              <X size={10} />
            </button>
          </div>
        )
      })}
      <button
        onClick={() => createTab()}
        title={t('browser.newTab')}
        className="flex-shrink-0 p-1 mb-0.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
      >
        <Plus size={11} />
      </button>
    </div>
  )
}
