import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe } from 'lucide-react'
import { useAppEvent } from '@shuvix/chat-ui'

/**
 * 顶栏右侧窗口控制簇里的「浏览器窗口」按钮：开 / 聚焦独立浏览器窗口，并显示当前 tab 数。
 * 放在顶栏而不是侧栏，侧栏收起时它也还在 —— 计数是用户唯一的提示，不能跟着侧栏一起藏起来。
 *
 * agent 开 tab 不会把浏览器窗口弄出来（不能打扰用户在主窗口里打字和操作），
 * 这个计数就是用户知道「agent 开了页面」的地方：数字变了，想看就点开。
 */
export function BrowserWindowButton(): React.JSX.Element {
  const { t } = useTranslation()
  const [count, setCount] = useState(0)

  // 初值：主进程的 tab 真源（窗口重载后也对得上）；之后跟 browser.tabsChanged 走
  useEffect(() => {
    let cancelled = false
    void window.api.browserView.listTabs().then((list) => {
      if (!cancelled) setCount(list.length)
    })
    return () => {
      cancelled = true
    }
  }, [])
  useAppEvent('browser.tabsChanged', (event) => setCount(event.count))

  const title =
    count > 0 ? t('sidebar.openBrowserWindowWithTabs', { count }) : t('sidebar.openBrowserWindow')

  return (
    <button
      onClick={() => void window.api.browserView.openWindow()}
      className="relative p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
      title={title}
      aria-label={title}
      data-open-browser-window
    >
      <Globe size={14} />
      {count > 0 && (
        <span
          className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-[3px] rounded-full bg-accent text-[9px] leading-[14px] text-white text-center tabular-nums"
          data-browser-tab-count={count}
        >
          {count}
        </span>
      )}
    </button>
  )
}
