import { useCallback, useEffect, useRef, useState } from 'react'
import {
  X,
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  Globe,
  Square
} from 'lucide-react'
import { usePreviewStore } from '../../stores/previewStore'

/**
 * Preview 侧边面板 — 右侧 iframe 预览区
 * 包含工具栏（导航、URL 栏、操作按钮）和内容区
 */
export function PreviewPanel(): React.JSX.Element {
  const { url, width, setUrl, close } = usePreviewStore()
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // ====== 状态 ======
  const [inputUrl, setInputUrl] = useState(url)
  const [isLoading, setIsLoading] = useState(false)

  // 外部 url 变化时同步到输入框
  useEffect(() => {
    setInputUrl(url)
  }, [url])

  /** 提交 URL 导航 */
  const handleNavigate = useCallback(() => {
    let target = inputUrl.trim()
    if (!target) return
    // 简单补全协议
    if (!/^https?:\/\//i.test(target) && target !== 'about:blank') {
      target = 'https://' + target
    }
    setUrl(target)
    setIsLoading(true)
  }, [inputUrl, setUrl])

  /** iframe 加载完成 */
  const handleIframeLoad = useCallback(() => {
    setIsLoading(false)
  }, [])

  // ====== 导航按钮 ======
  const handleBack = useCallback(() => {
    try {
      iframeRef.current?.contentWindow?.history.back()
    } catch {
      /* cross-origin */
    }
  }, [])
  const handleForward = useCallback(() => {
    try {
      iframeRef.current?.contentWindow?.history.forward()
    } catch {
      /* cross-origin */
    }
  }, [])
  const handleRefresh = useCallback(() => {
    if (!iframeRef.current) return
    setIsLoading(true)
    iframeRef.current.src = url
  }, [url])
  const handleStop = useCallback(() => {
    try {
      iframeRef.current?.contentWindow?.stop()
    } catch {
      /* cross-origin */
    }
    setIsLoading(false)
  }, [])
  const handleOpenExternal = useCallback(() => {
    if (url && url !== 'about:blank') {
      window.open(url, '_blank')
    }
  }, [url])

  const isBlank = url === 'about:blank'

  return (
    <div
      className="flex-shrink-0 flex flex-col h-full bg-bg-primary"
      style={{ width }}
    >

      {/* ====== 工具栏 ====== */}
      <div
        className={`titlebar-drag flex-shrink-0 flex items-center gap-1 px-2 border-b border-border-primary ${window.api?.app?.platform === 'darwin' ? 'min-h-12 pt-7' : 'min-h-10'}`}
      >
        {/* 加载 / 停止 */}
        <div className="titlebar-no-drag flex items-center">
          {isLoading ? (
            <button
              onClick={handleStop}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
              title="Stop"
            >
              <Square size={13} />
            </button>
          ) : (
            <button
              onClick={handleRefresh}
              className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
              title="Refresh"
            >
              <RotateCw size={13} />
            </button>
          )}
        </div>

        {/* 导航 */}
        <div className="titlebar-no-drag flex items-center">
          <button
            onClick={handleBack}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
            title="Back"
          >
            <ArrowLeft size={14} />
          </button>
          <button
            onClick={handleForward}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
            title="Forward"
          >
            <ArrowRight size={14} />
          </button>
        </div>

        {/* URL 栏 */}
        <form
          className="titlebar-no-drag flex-1 min-w-0"
          onSubmit={(e) => {
            e.preventDefault()
            handleNavigate()
          }}
        >
          <div className="flex items-center bg-bg-secondary/60 border border-border-secondary/50 rounded-md px-2 py-1 gap-1.5 transition-colors focus-within:border-accent/40">
            <Globe size={12} className="flex-shrink-0 text-text-tertiary" />
            <input
              type="text"
              value={inputUrl === 'about:blank' ? '' : inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              placeholder="Enter URL..."
              className="flex-1 min-w-0 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-tertiary"
            />
          </div>
        </form>

        {/* 右侧操作按钮 */}
        <div className="titlebar-no-drag flex items-center gap-0.5">
          <button
            onClick={handleOpenExternal}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
            title="Open in browser"
          >
            <ExternalLink size={13} />
          </button>
          <button
            onClick={close}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
            title="Close preview"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* ====== 内容区 ====== */}
      <div className="flex-1 min-h-0 relative">
        {isBlank ? (
          /* 空白占位 */
          <div className="flex flex-col items-center justify-center h-full text-text-tertiary gap-3 select-none">
            <Globe size={40} strokeWidth={1} className="opacity-30" />
            <p className="text-xs opacity-60">Enter a URL to preview</p>
          </div>
        ) : (
          <>
            {/* 加载进度条 */}
            {isLoading && (
              <div className="absolute top-0 left-0 right-0 h-0.5 z-10">
                <div className="h-full bg-accent animate-preview-loading" />
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={url}
              onLoad={handleIframeLoad}
              className="w-full h-full border-0"
              style={{ background: '#fff' }}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              title="Preview"
            />
          </>
        )}
      </div>

      {/* ====== 底部状态栏 ====== */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 h-7 border-t border-border-secondary bg-bg-secondary/40 text-[11px] text-text-tertiary select-none">
        {/* 加载状态指示 */}
        <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${isLoading ? 'bg-accent animate-pulse' : isBlank ? 'bg-text-tertiary/30' : 'bg-success/70'}`} />
        {/* 域名或状态文字 */}
        <span className="truncate">
          {isBlank ? 'No page loaded' : isLoading ? 'Loading...' : (() => { try { return new URL(url).host } catch { return url } })()}
        </span>
        <span className="flex-1" />
        {/* 宽度指示（拖拽时方便查看） */}
        <span className="tabular-nums opacity-60">{width}px</span>
      </div>
    </div>
  )
}
