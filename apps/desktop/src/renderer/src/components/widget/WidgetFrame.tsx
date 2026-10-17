import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { isWebHost } from '../../host/hostMedia'
import { widgetFrameUrl } from '../../host/hostUrls'

/**
 * 浏览器里的 web 客户端（server mode phase D）：widget 经网络服务转发，与 web 客户端同源 —— iframe 加沙箱、
 * 不给 allow-same-origin，widget 的代码于是够不着这一页的 `window.api`（桌面靠跨源做到同一件事）。
 * 它的 bundle / db / sse / fs 请求照样能用：widget 服务与网络服务的转发给它们都回了 CORS 头。
 */
const WEB_WIDGET_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads'

type LoadPhase =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; message: string }

/**
 * 承载一个 widget 页面的 iframe —— 独立窗口（WidgetWindowShell）与 Widget 面板里的应用共用。
 *
 * - 挂载时调 widget.open：懒启动 server + 注册构建 + 拿 URL（计一次打开）；`reloadNonce` 变了就走
 *   startWidget 重新拿（不计数）。URL 永远现取不持久化，天然规避 server 随机端口在重启后过期。
 * - 内容用跨源 iframe 承载（127.0.0.1 在 renderer CSP frame-src 白名单内）；preload 只注入顶层页面，
 *   widget 的 agent 生成代码拿不到 window.api
 * - `onWidget`：widget.open 回来的那份摘要（名字给窗口标题用）
 */
export function WidgetFrame({
  widgetId,
  title,
  reloadNonce,
  onWidget,
  className = ''
}: {
  widgetId: string
  title: string
  reloadNonce: number
  onWidget?: (widget: WidgetSummary) => void
  className?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<LoadPhase>({ status: 'loading' })
  const [frameKey, setFrameKey] = useState(0)
  const openedRef = useRef(false)
  const onWidgetRef = useRef(onWidget)
  useEffect(() => {
    onWidgetRef.current = onWidget
  }, [onWidget])

  /** initial=true 走 widget.open（计一次打开）；重载 / 重试走 startWidget。setState 都在 .then 里 */
  const start = useCallback(
    (initial: boolean): void => {
      const req = initial
        ? window.api.widget.open(widgetId)
        : window.api.widget.startWidget(widgetId)
      void req.then((res) => {
        if (!res.success) {
          setPhase({ status: 'error', message: res.error })
          return
        }
        if ('widget' in res) onWidgetRef.current?.(res.widget)
        if (!res.url) {
          setPhase({ status: 'error', message: t('widgets.serverStopped') })
          return
        }
        // URL 可能因 server 重启换端口 —— 每次都重挂 iframe。web 客户端经网络服务的 /w/ 转发
        setFrameKey((v) => v + 1)
        setPhase({
          status: 'ready',
          url: widgetFrameUrl(window.api.app.platform, res.url, window.location.origin)
        })
      })
    },
    [widgetId, t]
  )

  const retry = useCallback((): void => {
    setPhase({ status: 'loading' })
    start(false)
  }, [start])

  useEffect(() => {
    // StrictMode 下 effect 会双跑 —— ref 防止 widget.open 重复计数 / 重复构建
    if (openedRef.current) return
    openedRef.current = true
    start(true)
  }, [start])

  // 重新加载（标题栏 / 应用顶栏的按钮）：首次挂载的 0 不算
  const lastNonce = useRef(reloadNonce)
  useEffect(() => {
    if (reloadNonce === lastNonce.current) return
    lastNonce.current = reloadNonce
    // 事件驱动的重载：先置 loading，再走异步流程
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase({ status: 'loading' })
    start(false)
  }, [reloadNonce, start])

  return (
    <div className={`relative ${className}`}>
      {phase.status === 'ready' && (
        <iframe
          key={frameKey}
          src={phase.url}
          title={title}
          data-widget-frame={widgetId}
          sandbox={isWebHost ? WEB_WIDGET_SANDBOX : undefined}
          className="absolute inset-0 w-full h-full border-0"
        />
      )}
      {phase.status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex items-center gap-2 text-[12px] text-text-tertiary">
            <Loader2 size={14} className="animate-spin" />
            <span>{t('widgets.windowStarting')}</span>
          </div>
        </div>
      )}
      {phase.status === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center px-6">
          <div className="text-center max-w-sm">
            <p className="text-[12px] text-text-secondary mb-1">{t('widgets.windowStartFailed')}</p>
            <p className="text-[11px] text-text-tertiary/70 break-all mb-3">{phase.message}</p>
            <button
              onClick={retry}
              className="px-3 py-1 rounded-md text-[11px] bg-bg-tertiary/80 hover:bg-bg-hover text-text-secondary transition-colors"
            >
              {t('widgets.windowRetry')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
