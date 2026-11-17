/**
 * 手机布局「浏览器」那一摞页面（browserHistory.ts）：一层一页，全都挂着、只显示最上面那一层 —— 退回来时列表还在
 * 原来的位置，搜索词也还在。标签页的清单在这里取一次，列表页与单个标签页那一页共用。
 */
import { useEffect, useState } from 'react'
import { MobileBrowserTabPage, MobileBrowserTabsPage } from './MobileBrowser'
import {
  MobileBrowserSettingsPage,
  MobileBrowserSitePage,
  MobileBrowserSitesPage
} from './MobileBrowserSettings'
import { browserSiteOf, browserSitePage, browserTabIdOf, browserTabPage } from './browserHistory'
import { useBrowserTabs } from './useBrowserTabs'

export interface MobileBrowserPagesProps {
  /** 从设置页往上数的那一摞（至少有 'tabs'） */
  stack: readonly string[]
  onPush: (page: string) => void
  /** 返回上一层（最下面那一层 → 设置页） */
  onBack: () => void
  onOpenSession: (sessionId: string) => void
}

export function MobileBrowserPages({
  stack,
  onPush,
  onBack,
  onOpenSession
}: MobileBrowserPagesProps): React.JSX.Element {
  const state = useBrowserTabs()
  /** 那台电脑在无头运行（问不到 → 当作不是） */
  const [headless, setHeadless] = useState(false)
  useEffect(() => {
    let alive = true
    void window.api.browserView
      .hostInfo()
      .then((info) => {
        if (alive) setHeadless(info.headless === true)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  return (
    <>
      {stack.map((page, index) => {
        const top = index === stack.length - 1
        const tabId = browserTabIdOf(page)
        const site = browserSiteOf(page)
        return (
          <div
            key={page}
            data-mobile-browser-layer={page}
            className="absolute inset-0"
            style={top ? undefined : { display: 'none' }}
          >
            {page === 'tabs' ? (
              <MobileBrowserTabsPage
                state={state}
                headless={headless}
                active={top}
                onBack={onBack}
                onOpenTab={(id) => onPush(browserTabPage(id))}
                onOpenSettings={() => onPush('settings')}
              />
            ) : page === 'settings' ? (
              <MobileBrowserSettingsPage
                headless={headless}
                active={top}
                onBack={onBack}
                onOpenSites={() => onPush('sites')}
              />
            ) : page === 'sites' ? (
              <MobileBrowserSitesPage
                active={top}
                onBack={onBack}
                onOpenSite={(next) => onPush(browserSitePage(next))}
              />
            ) : tabId !== null ? (
              <MobileBrowserTabPage
                state={state}
                tabId={tabId}
                onBack={onBack}
                onOpenSession={onOpenSession}
              />
            ) : site !== null ? (
              <MobileBrowserSitePage site={site} onBack={onBack} />
            ) : null}
          </div>
        )
      })}
    </>
  )
}
