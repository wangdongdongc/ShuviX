import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  Globe,
  Square,
  Palette,
  Play,
  Loader2
} from 'lucide-react'
import { usePreviewStore } from '../../stores/previewStore'
import { useChatStore } from '../../stores/chatStore'

/**
 * Preview 侧边面板 — 右侧 iframe 预览区
 * 支持两种模式：
 * - url: 外部网页预览（输入 URL）
 * - design: 本地设计项目预览（esbuild-wasm 打包）
 */
export function PreviewPanel(): React.JSX.Element {
  const {
    url,
    width,
    mode,
    designUrl,
    setUrl,
    switchToUrl,
    isStartingServer,
    isServerRunning,
    startPreviewServer,
    stopPreviewServer
  } = usePreviewStore()
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const projectPath = useChatStore((s) => s.projectPath)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // ====== 状态 ======
  const [inputUrl, setInputUrl] = useState(url)
  const [isLoading, setIsLoading] = useState(false)
  const [contentHeight, setContentHeight] = useState(0)

  // 监测内容区高度变化
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      setContentHeight(Math.round(entry.contentRect.height))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 实际显示的 URL：design 模式用 designUrl，url 模式用 url
  const activeUrl = mode === 'preview' && designUrl ? designUrl : url
  const isDesignMode = mode === 'preview'

  // 外部 url 变化时同步到输入框（仅 url 模式）
  useEffect(() => {
    if (!isDesignMode) {
      setInputUrl(url)
    }
  }, [url, isDesignMode])

  /** 提交 URL 导航 */
  const handleNavigate = useCallback(() => {
    let target = inputUrl.trim()
    if (!target) return
    // 简单补全协议
    if (!/^https?:\/\//i.test(target) && target !== 'about:blank') {
      target = 'https://' + target
    }
    // 如果在 design 模式下手动输入 URL，切换到 url 模式
    if (isDesignMode) {
      switchToUrl()
    }
    setUrl(target)
    setIsLoading(true)
  }, [inputUrl, setUrl, isDesignMode, switchToUrl])

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
    iframeRef.current.src = activeUrl
  }, [activeUrl])
  const handleStop = useCallback(() => {
    try {
      iframeRef.current?.contentWindow?.stop()
    } catch {
      /* cross-origin */
    }
    setIsLoading(false)
  }, [])
  const handleOpenExternal = useCallback(() => {
    if (activeUrl && activeUrl !== 'about:blank') {
      window.open(activeUrl, '_blank')
    }
  }, [activeUrl])

  // ====== Server 生命周期 ======
  const handleStartServer = useCallback(() => {
    if (!activeSessionId || !projectPath) return
    startPreviewServer(activeSessionId, projectPath)
  }, [activeSessionId, projectPath, startPreviewServer])

  const handleStopServer = useCallback(() => {
    if (!activeSessionId) return
    stopPreviewServer(activeSessionId)
  }, [activeSessionId, stopPreviewServer])

  const isBlank = !isDesignMode && url === 'about:blank'
  const btnClass =
    'p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors'

  return (
    <div
      className="flex flex-col h-full bg-bg-primary overflow-hidden"
      style={{ width, minWidth: 200 }}
    >
      {/* ====== 工具栏 ====== */}
      <div className="titlebar-drag flex-shrink-0 flex items-center gap-0.5 px-1.5 min-h-8 border-b border-border-primary">
        {/* Start / Stop 按钮 */}
        <div className="titlebar-no-drag flex items-center flex-shrink-0">
          {isStartingServer ? (
            <button
              disabled
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-text-tertiary cursor-not-allowed"
              title="Starting..."
            >
              <Loader2 size={10} className="animate-spin" />
              <span>Starting...</span>
            </button>
          ) : isServerRunning ? (
            <button
              onClick={handleStopServer}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-error hover:text-error hover:bg-error/10 transition-colors"
              title="Stop preview server"
            >
              <Square size={10} fill="currentColor" />
              <span>Stop</span>
            </button>
          ) : (
            <button
              onClick={handleStartServer}
              disabled={!activeSessionId || !projectPath}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-hover/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Start preview server"
            >
              <Play size={10} fill="currentColor" />
              <span>Start</span>
            </button>
          )}
        </div>

        {/* 分隔线 */}
        <div className="w-px h-3.5 bg-border-secondary/60 mx-1 flex-shrink-0" />

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
              <Square size={11} />
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
            {isDesignMode ? (
              <Palette size={10} className="flex-shrink-0 text-accent" />
            ) : (
              <Globe size={10} className="flex-shrink-0 text-text-tertiary" />
            )}
            <input
              type="text"
              value={isDesignMode ? designUrl || '' : inputUrl === 'about:blank' ? '' : inputUrl}
              onChange={(e) => {
                if (!isDesignMode) setInputUrl(e.target.value)
              }}
              readOnly={isDesignMode}
              placeholder="Enter URL or start a preview server..."
              className="flex-1 min-w-0 bg-transparent text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
            />
          </div>
        </form>

        {/* 在浏览器中打开 */}
        <div className="titlebar-no-drag flex items-center flex-shrink-0">
          <button onClick={handleOpenExternal} className={btnClass} title="Open in browser">
            <ExternalLink size={11} />
          </button>
        </div>
      </div>

      {/* ====== 内容区 ====== */}
      <div ref={contentRef} className="flex-1 min-h-0 relative">
        {isBlank ? (
          <div className="flex items-center justify-center h-full select-none">
            <p className="text-xs text-text-tertiary/40">Start a preview server or enter a URL</p>
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
              src={activeUrl}
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
      <div className="flex-shrink-0 flex items-center justify-end gap-1.5 px-2.5 h-6 border-t border-border-secondary bg-bg-secondary/40 text-[10px] text-text-tertiary select-none">
        {/* 加载状态指示 */}
        {isLoading && (
          <span className="h-1 w-1 rounded-full flex-shrink-0 bg-accent animate-pulse" />
        )}
        {/* 尺寸指示 */}
        <span className="tabular-nums opacity-60">
          {contentHeight} x {width}
        </span>
      </div>
    </div>
  )
}
