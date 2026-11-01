import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { isWebHost } from '../../host/hostMedia'
import { widgetFrameUrl } from '../../host/hostUrls'
import { isWidgetReadyMessage, WIDGET_READY_MAX_WAIT_MS } from '../../../../shared/widgetReady'

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

/** 等这么久还没好才出「正在启动」：快的打开不闪一下转圈 */
const SPINNER_DELAY_MS = 400
/** iframe 的 load 之后这么久还没收到就绪信号 → 照样揭开（比页面骨架自己的上限长一点：正常时总是信号先到） */
const REVEAL_AFTER_LOAD_MS = WIDGET_READY_MAX_WAIT_MS + 500
/** 连 load 都没等到（某个资源一直不回）：给了地址之后这么久揭开，至少让人看见页面现在的样子 */
const REVEAL_DEADLINE_MS = 12_000

/**
 * 承载一个 widget 页面的 iframe —— 独立窗口（WidgetWindowShell）与 Widget 面板里的应用共用。
 *
 * - 挂载时调 widget.open：懒启动 server + 注册构建 + 拿 URL（计一次打开）；`reloadNonce` 变了就走
 *   startWidget 重新拿（不计数）。URL 永远现取不持久化，天然规避 server 随机端口在重启后过期。
 * - 内容用跨源 iframe 承载（127.0.0.1 在 renderer CSP frame-src 白名单内）；preload 只注入顶层页面，
 *   widget 的 agent 生成代码拿不到 window.api
 * - iframe 挂上之后先透明，等页面说「画好了」（shared/widgetReady.ts 的信号，只认这个 iframe 发的）再淡入：
 *   空白页、组件自己的「Loading…」不再一闪而过。等不到就按 load / 截止时间兜底揭开。用透明而不是
 *   visibility: hidden —— 后者会让浏览器节流跨源 iframe 的渲染，信号反而迟到
 * - 「正在启动」只在等了 SPINNER_DELAY_MS 还没好时才出
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
  /** 第几次打开（首次挂载、重试、重新加载各算一次）：一次打开从拿地址到揭开是同一段等待，转圈的延时按它计 */
  const [attempt, setAttempt] = useState(0)
  /** 已经揭开的那一个 iframe（frameKey）；-1 = 还没有 */
  const [revealedKey, setRevealedKey] = useState(-1)
  /** 等得够久、该出转圈的那一次打开（attempt） */
  const [slowAttempt, setSlowAttempt] = useState(-1)
  const iframeRef = useRef<HTMLIFrameElement>(null)
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
    setAttempt((v) => v + 1)
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
    setAttempt((v) => v + 1)
    start(false)
  }, [reloadNonce, start])

  const ready = phase.status === 'ready'
  const revealed = ready && revealedKey === frameKey

  // 揭开：这个 iframe 发来就绪信号；或截止时间到了（load 的那一支在 onLoad 里起）
  useEffect(() => {
    if (!ready) return undefined
    const key = frameKey
    const reveal = (): void => setRevealedKey(key)
    const onMessage = (event: MessageEvent): void => {
      const frame = iframeRef.current
      if (!frame || event.source !== frame.contentWindow) return
      if (isWidgetReadyMessage(event.data)) reveal()
    }
    window.addEventListener('message', onMessage)
    const deadline = setTimeout(reveal, REVEAL_DEADLINE_MS)
    return () => {
      window.removeEventListener('message', onMessage)
      clearTimeout(deadline)
    }
  }, [ready, frameKey])

  const loadFallback = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (loadFallback.current) clearTimeout(loadFallback.current)
    },
    []
  )
  const onFrameLoad = useCallback((): void => {
    const key = frameKey
    if (loadFallback.current) clearTimeout(loadFallback.current)
    loadFallback.current = setTimeout(() => setRevealedKey(key), REVEAL_AFTER_LOAD_MS)
  }, [frameKey])

  // 转圈：这一次打开（拿地址 + iframe 还没揭开，算一段 —— 拿到地址时转圈不能断一下再出来）超过 SPINNER_DELAY_MS 才出
  const waiting = phase.status === 'loading' || (ready && !revealed)
  useEffect(() => {
    if (!waiting) return undefined
    const timer = setTimeout(() => setSlowAttempt(attempt), SPINNER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [waiting, attempt])
  const showSpinner = waiting && slowAttempt === attempt

  return (
    <div className={`relative ${className}`}>
      {phase.status === 'ready' && (
        <iframe
          key={frameKey}
          ref={iframeRef}
          src={phase.url}
          title={title}
          data-widget-frame={widgetId}
          data-revealed={revealed ? '' : undefined}
          sandbox={isWebHost ? WEB_WIDGET_SANDBOX : undefined}
          onLoad={onFrameLoad}
          className={`absolute inset-0 w-full h-full border-0 transition-opacity duration-150 ${
            revealed ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        />
      )}
      {showSpinner && (
        <div
          data-widget-frame-loading=""
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
        >
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
