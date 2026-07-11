import { useCallback, useEffect, useRef, useState, startTransition } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  Globe,
  TriangleAlert,
  X
} from 'lucide-react'
import { useBrowserStore } from '../../stores/browserStore'
import { BrowserTabBar } from './BrowserTabBar'

/** Chromium net error code 范围：CERT_* 在 -200 ~ -211 */
function isCertError(code: number): boolean {
  return code <= -200 && code >= -211
}

/**
 * Browser 侧边面板 — 右侧浏览器区
 * 内容由主进程的多 tab WebContentsView 渲染（激活 tab 的 view 覆盖在 placeholder 上方），
 * 本组件仅提供 tab 条 + 工具栏 + 状态栏 + bounds 同步。
 * tab 状态（url/title/isLoading/loadError）是主进程真源的镜像（useBrowserTabsBridge）。
 */
export function BrowserPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const width = useBrowserStore((s) => s.width)
  const isOpen = useBrowserStore((s) => s.isOpen)
  const activeTab = useBrowserStore((s) => s.activeTab)
  const tabs = useBrowserStore((s) => s.tabs)
  const activeTabId = useBrowserStore((s) => s.activeTabId)
  const createTab = useBrowserStore((s) => s.createTab)
  const closeTab = useBrowserStore((s) => s.closeTab)
  const navigateTab = useBrowserStore((s) => s.navigateTab)

  const activeTabInfo = tabs.find((tab) => tab.id === activeTabId)
  const url = activeTabInfo?.url ?? 'about:blank'
  const isLoading = activeTabInfo?.isLoading ?? false
  const loadError = activeTabInfo?.loadError ?? null

  /** placeholder div — 激活 tab 的 WebContentsView 叠放在这个区域上方 */
  const placeholderRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // ====== 状态 ======
  const [inputUrl, setInputUrl] = useState(url)
  const [contentHeight, setContentHeight] = useState(0)

  // 检测是否有对话框覆盖层打开（WebContentsView 在原生层渲染，需要手动让位）
  const [hasDialogOverlay, setHasDialogOverlay] = useState(false)
  useEffect(() => {
    const check = (): void => {
      setHasDialogOverlay(document.querySelector('.dialog-overlay') !== null)
    }
    const mo = new MutationObserver(check)
    mo.observe(document.body, { childList: true, subtree: true })
    check()
    return () => mo.disconnect()
  }, [])

  const isBlank = !activeTabInfo || url === 'about:blank'

  // WebContentsView 是否应该可见（错误态时让 WebContentsView 让位给覆盖层）
  const shouldShowView =
    isOpen && activeTab === 'browser' && !isBlank && !hasDialogOverlay && !loadError

  // ====== Bounds 同步 ======

  const rafRef = useRef(0)

  const syncBounds = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      if (!placeholderRef.current || !shouldShowView) {
        window.api.browserView.setVisible(false)
        return
      }
      const rect = placeholderRef.current.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        window.api.browserView.setVisible(false)
        return
      }
      window.api.browserView.updateBounds({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      })
      window.api.browserView.setVisible(true)
    })
  }, [shouldShowView])

  // ResizeObserver 监听 placeholder 尺寸变化
  useEffect(() => {
    const el = placeholderRef.current
    if (!el) return
    const ro = new ResizeObserver(() => syncBounds())
    ro.observe(el)
    return () => ro.disconnect()
  }, [syncBounds])

  // 窗口 resize 时同步 bounds（捕捉 x 位置变化）
  useEffect(() => {
    window.addEventListener('resize', syncBounds)
    return () => window.removeEventListener('resize', syncBounds)
  }, [syncBounds])

  // shouldShowView 变化时立即同步
  useEffect(() => {
    syncBounds()
  }, [shouldShowView, syncBounds])

  // 监测内容区高度变化（状态栏显示尺寸）
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      setContentHeight(Math.round(entry.contentRect.height))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 激活 tab / 其 URL 变化时同步到输入框
  useEffect(() => {
    startTransition(() => setInputUrl(url))
  }, [activeTabId, url])

  // ====== 操作 ======

  /** 提交 URL 导航：有激活 tab 导航之，无则新建 */
  const handleNavigate = useCallback(() => {
    let target = inputUrl.trim()
    if (!target) return
    if (!/^https?:\/\//i.test(target) && target !== 'about:blank') {
      target = 'https://' + target
    }
    if (activeTabId) {
      navigateTab(activeTabId, target)
    } else {
      createTab(target)
    }
  }, [inputUrl, activeTabId, navigateTab, createTab])

  const handleBack = useCallback(() => {
    if (activeTabId) void window.api.browserView.goBack(activeTabId)
  }, [activeTabId])

  const handleForward = useCallback(() => {
    if (activeTabId) void window.api.browserView.goForward(activeTabId)
  }, [activeTabId])

  const handleRefresh = useCallback(() => {
    if (activeTabId) void window.api.browserView.reload(activeTabId)
  }, [activeTabId])

  const handleStop = useCallback(() => {
    if (activeTabId) void window.api.browserView.stop(activeTabId)
  }, [activeTabId])

  const handleRetry = useCallback(() => {
    if (!activeTabId || !loadError) return
    navigateTab(activeTabId, loadError.url || url)
  }, [activeTabId, loadError, url, navigateTab])

  const handleOpenExternal = useCallback(() => {
    if (url && url !== 'about:blank') {
      window.open(url, '_blank')
    }
  }, [url])

  /** 关闭当前 tab */
  const handleClose = useCallback(() => {
    if (activeTabId) closeTab(activeTabId)
  }, [activeTabId, closeTab])

  const btnClass =
    'p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors'

  return (
    <div className="flex flex-col h-full bg-bg-primary overflow-hidden">
      {/* ====== tab 条 ====== */}
      <BrowserTabBar />

      {/* ====== 工具栏 ====== */}
      <div className="titlebar-drag flex-shrink-0 flex items-center gap-0.5 px-1.5 min-h-8 border-b border-border-secondary/30">
        {/* 导航：后退、前进、刷新/停止加载 */}
        <div className="titlebar-no-drag flex items-center flex-shrink-0">
          <button onClick={handleBack} className={btnClass} title="Back">
            <ArrowLeft size={12} />
          </button>
          <button onClick={handleForward} className={btnClass} title="Forward">
            <ArrowRight size={12} />
          </button>
          {isLoading ? (
            <button onClick={handleStop} className={btnClass} title="Stop">
              <Globe size={11} />
            </button>
          ) : (
            <button onClick={handleRefresh} className={btnClass} title="Refresh">
              <RotateCw size={11} />
            </button>
          )}
        </div>

        {/* URL 栏 */}
        <form
          className="titlebar-no-drag flex-1 min-w-0"
          onSubmit={(e) => {
            e.preventDefault()
            handleNavigate()
          }}
        >
          <div className="flex items-center bg-bg-secondary/60 border border-border-secondary/50 rounded-md px-1.5 py-0.5 gap-1 transition-colors focus-within:border-accent/40">
            <Globe size={10} className="flex-shrink-0 text-text-tertiary" />
            <input
              type="text"
              value={inputUrl === 'about:blank' ? '' : inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              placeholder={t('panel.urlPlaceholder')}
              className="flex-1 min-w-0 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
            />
          </div>
        </form>

        {/* 在浏览器中打开 / 关闭当前 tab */}
        <div className="titlebar-no-drag flex items-center flex-shrink-0">
          <button onClick={handleOpenExternal} className={btnClass} title="Open in browser">
            <ExternalLink size={11} />
          </button>
          {activeTabInfo && (
            <button onClick={handleClose} className={btnClass} title={t('browser.close')}>
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* ====== 内容区 ====== */}
      <div ref={contentRef} className="flex-1 min-h-0 relative">
        {isBlank ? (
          <div className="flex items-center justify-center h-full select-none">
            <p className="text-xs text-text-tertiary/40">Enter a URL</p>
          </div>
        ) : (
          <>
            {/* 加载进度条 */}
            {isLoading && (
              <div className="absolute top-0 left-0 right-0 h-0.5 z-10">
                <div className="h-full bg-accent animate-browser-loading" />
              </div>
            )}
            {/* WebContentsView 占位区域 — 激活 tab 的 WebContentsView 叠放在此 div 上方 */}
            <div ref={placeholderRef} className="w-full h-full" />
            {/* 加载错误覆盖层 — WebContentsView 已隐藏，覆盖在 placeholder 上 */}
            {loadError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center px-6 bg-bg-primary">
                <TriangleAlert size={36} className="text-amber-500/80 mb-3" />
                <h2 className="text-sm font-medium text-text-primary mb-2">
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
                <p className="text-[10px] text-text-tertiary mb-4 break-all text-center max-w-md">
                  {loadError.url}
                </p>
                <button
                  onClick={handleRetry}
                  className="px-3 py-1 rounded-md text-[11px] bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
                >
                  {t('browser.error.retry')}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* ====== 底部状态栏 ====== */}
      <div className="flex-shrink-0 flex items-center justify-end gap-1.5 px-2.5 h-6 border-t border-border-secondary/30 bg-bg-secondary/40 text-[10px] text-text-tertiary select-none">
        {isLoading && (
          <span className="h-1 w-1 rounded-full flex-shrink-0 bg-accent animate-pulse" />
        )}
        <span className="tabular-nums opacity-60">
          {contentHeight} x {width}
        </span>
      </div>
    </div>
  )
}
