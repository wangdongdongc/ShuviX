import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, Plus, X } from 'lucide-react'
import { selectedTabIds, toggleTab, useSelectedTabIds, type SelectedTab } from './tabSelection'

/** 标签页的图标：有 favicon 用 favicon，没有（或加载失败）用地球 */
function TabIcon({ tab }: { tab: SelectedTab }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (!tab.favIconUrl || failed)
    return <Globe size={12} className="flex-shrink-0 text-text-tertiary" />
  return (
    <img
      src={tab.favIconUrl}
      alt=""
      className="w-3 h-3 flex-shrink-0 rounded-sm"
      onError={() => setFailed(true)}
    />
  )
}

function toSelected(tab: chrome.tabs.Tab): SelectedTab | null {
  if (tab.id == null || tab.id < 0) return null
  return {
    id: tab.id,
    title: tab.title ?? '',
    url: tab.pendingUrl || tab.url || '',
    favIconUrl: tab.favIconUrl || undefined
  }
}

/** 全部标签页（跟着 chrome.tabs 事件刷新） */
function useAllTabs(): SelectedTab[] {
  const [tabs, setTabs] = useState<SelectedTab[]>([])
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void chrome.tabs.query({}).then((all) => {
        if (alive) setTabs(all.map(toSelected).filter((t): t is SelectedTab => !!t))
      })
    }
    refresh()
    chrome.tabs.onUpdated.addListener(refresh)
    chrome.tabs.onRemoved.addListener(refresh)
    chrome.tabs.onCreated.addListener(refresh)
    return () => {
      alive = false
      chrome.tabs.onUpdated.removeListener(refresh)
      chrome.tabs.onRemoved.removeListener(refresh)
      chrome.tabs.onCreated.removeListener(refresh)
    }
  }, [])
  return tabs
}

/**
 * 输入卡片顶上的一排标签页芯片：这条消息带哪些标签页。缺省只有本标签页（侧边栏挂着的那一页），
 * 点 × 取消，点 + 从全部标签页里加选。
 */
export function TabChips({ attachedTabId }: { attachedTabId: number }): React.JSX.Element {
  const { t } = useTranslation()
  const selected = useSelectedTabIds()
  const tabs = useAllTabs()
  const [picking, setPicking] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!picking) return
    const onDown = (e: MouseEvent): void => {
      if (!pickerRef.current?.contains(e.target as Node)) setPicking(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [picking])

  const byId = new Map(tabs.map((tab) => [tab.id, tab]))
  const chips = selected.map((id) => byId.get(id)).filter((tab): tab is SelectedTab => !!tab)
  const others = tabs.filter((tab) => !selectedTabIds().includes(tab.id))

  return (
    <div
      className="relative flex flex-wrap items-center gap-1 px-2.5 pt-2 pb-1 border-b border-border-secondary/30"
      data-tab-chips
    >
      {chips.map((tab) => (
        <span
          key={tab.id}
          className="inline-flex max-w-[12rem] items-center gap-1 rounded-md bg-bg-tertiary/70 pl-1.5 pr-1 py-0.5 text-[11px] text-text-secondary"
          title={tab.url}
          data-tab-chip={tab.id}
        >
          <TabIcon tab={tab} />
          <span className="truncate">
            {tab.id === attachedTabId ? t('chromePanel.thisTab') : tab.title || tab.url}
          </span>
          <button
            type="button"
            aria-label={t('chromePanel.removeTab')}
            onClick={() => toggleTab(tab.id)}
            className="rounded p-0.5 text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
          >
            <X size={10} />
          </button>
        </span>
      ))}
      <div className="relative" ref={pickerRef}>
        <button
          type="button"
          aria-label={t('chromePanel.addTab')}
          title={t('chromePanel.addTab')}
          onClick={() => setPicking((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
        >
          <Plus size={11} />
          {chips.length === 0 && t('chromePanel.addTab')}
        </button>
        {picking && (
          <div className="absolute bottom-full left-0 z-20 mb-1 w-64 max-h-72 overflow-y-auto rounded-lg border border-border-secondary bg-bg-secondary p-1 shadow-lg">
            {others.length === 0 ? (
              <div className="px-2 py-1.5 text-[11px] text-text-tertiary">
                {t('chromePanel.noOtherTabs')}
              </div>
            ) : (
              others.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    toggleTab(tab.id)
                    setPicking(false)
                  }}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  title={tab.url}
                >
                  <TabIcon tab={tab} />
                  <span className="truncate">
                    {tab.id === attachedTabId ? t('chromePanel.thisTab') : tab.title || tab.url}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
