import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppEvent } from '@shuvix/chat-ui'
import { reasonOf, type TabRow } from '../components/browser/tabsManagerPure'

/** 那台电脑上浏览器的标签页：取一次，之后跟着 `browser.tabsChanged` 重新取 */
export interface BrowserTabsState {
  /** null = 还没取到 */
  tabs: TabRow[] | null
  /** 这台设备不能看标签页（策略拒了）时的那句话 */
  listError: string | null
  reload: () => void
}

export function useBrowserTabs(): BrowserTabsState {
  const { t } = useTranslation()
  const [tabs, setTabs] = useState<TabRow[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  /** 每要重新取一次加一 */
  const [round, setRound] = useState(0)
  const refused = t('browser.manager.remoteUrlRefused')
  useEffect(() => {
    // 晚回来的那一次（后面又取过、或已经卸载）不写
    let current = true
    window.api.browserView.listTabs().then(
      (list) => {
        if (!current) return
        setTabs(list)
        setListError(null)
      },
      (error: unknown) => {
        if (current) setListError(reasonOf(error, refused))
      }
    )
    return () => {
      current = false
    }
  }, [round, refused])
  const reload = useCallback((): void => setRound((n) => n + 1), [])
  useAppEvent('browser.tabsChanged', reload)
  return { tabs, listError, reload }
}
