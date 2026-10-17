import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Cookie,
  FileText,
  Loader2,
  Lock,
  Settings,
  ShieldAlert,
  TriangleAlert,
  X
} from 'lucide-react'
import { useBrowserTabsStore, type BrowserTabInfo } from '../../stores/browserTabsStore'
import { urlDisplayOf } from './omnibox'

/**
 * 站点信息气泡 —— 点地址栏左侧的安全图标打开（Chrome 的 page info）：连接是否安全、这个站点的 Cookie 与
 * 「清除此网站的数据」、「网站设置」（打开设置页的网站数据一节，搜索框填好这个站点）。
 *
 * 它是 DOM 弹层，会落在页面区上方；原生页面画在 DOM 之上，所以打开期间页面区换成截图（store 的 pageCover，
 * 由打开它的地方先抓好），关掉时换回来。Esc、点气泡外面、换了 tab 或地址都会关掉它。
 */
export function SiteInfoBubble({
  tab,
  onClose
}: {
  tab: BrowserTabInfo
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const openSettings = useBrowserTabsStore((s) => s.openSettings)
  const [info, setInfo] = useState<{
    cookieCount: number
    certException: boolean
    site?: string
  } | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [clearing, setClearing] = useState(false)

  const display = urlDisplayOf(tab.url)
  const web = display.kind === 'secure' || display.kind === 'insecure'

  useEffect(() => {
    if (!web) return
    let cancelled = false
    void window.api.browserData.siteInfo(tab.url).then((r) => {
      if (!cancelled) setInfo(r)
    })
    return () => {
      cancelled = true
    }
  }, [tab.url, web])

  // Esc / 点外面关掉
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  const clear = async (): Promise<void> => {
    setClearing(true)
    try {
      await window.api.browserData.clearSiteData(tab.url)
      onClose()
      void window.api.browserView.reload(tab.id)
    } catch {
      // 没清掉：气泡留着、确认按钮可以再点一次
    } finally {
      setClearing(false)
    }
  }
  /** 网站数据列表按 cookie 的域名列（不含端口）：搜索框填主机名 */
  let hostname = ''
  try {
    hostname = new URL(tab.url).hostname
  } catch {
    // 非网页没有主机名
  }

  const connection =
    display.kind === 'local'
      ? {
          icon: FileText,
          cls: 'text-text-secondary',
          title: t('browser.siteInfo.local'),
          detail: ''
        }
      : info?.certException
        ? {
            icon: ShieldAlert,
            cls: 'text-error',
            title: t('browser.siteInfo.certException'),
            detail: t('browser.siteInfo.certExceptionDetail')
          }
        : display.kind === 'secure'
          ? {
              icon: Lock,
              cls: 'text-text-secondary',
              title: t('browser.siteInfo.secure'),
              detail: ''
            }
          : {
              icon: TriangleAlert,
              cls: 'text-amber-500',
              title: t('browser.siteInfo.insecure'),
              detail: t('browser.siteInfo.insecureDetail')
            }
  const ConnIcon = connection.icon

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={display.host}
      className="absolute left-0 top-full mt-1.5 z-50 w-[320px] rounded-xl border border-border-secondary/60 bg-bg-secondary shadow-xl text-[12px]"
      data-site-info={display.host || tab.url}
    >
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <span className="flex-1 min-w-0 truncate font-medium text-text-primary">
          {display.host || display.rest}
        </span>
        <button
          onClick={onClose}
          className="p-1 rounded-full text-text-tertiary hover:text-text-primary hover:bg-bg-hover"
          aria-label={t('common.close')}
        >
          <X size={13} />
        </button>
      </div>

      <div
        className="flex items-start gap-3 px-4 py-2.5 border-t border-border-secondary/40"
        data-site-connection={display.kind}
      >
        <ConnIcon size={15} className={`flex-shrink-0 mt-0.5 ${connection.cls}`} />
        <div className="min-w-0">
          <p className="text-text-primary">{connection.title}</p>
          {connection.detail && <p className="text-text-tertiary mt-0.5">{connection.detail}</p>}
        </div>
      </div>

      {web && (
        <div className="flex items-start gap-3 px-4 py-2.5 border-t border-border-secondary/40">
          <Cookie size={15} className="flex-shrink-0 mt-0.5 text-text-secondary" />
          <div className="flex-1 min-w-0">
            <p className="text-text-primary">{t('browser.siteInfo.cookies')}</p>
            <p className="text-text-tertiary mt-0.5" data-site-cookies={info?.cookieCount ?? ''}>
              {info ? t('browser.siteInfo.cookieCount', { count: info.cookieCount }) : '…'}
            </p>
            {confirm ? (
              <div className="flex items-center gap-1 mt-1.5">
                <button
                  onClick={() => void clear()}
                  disabled={clearing}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-error hover:bg-error/10 disabled:opacity-50"
                  data-site-clear-confirm
                >
                  {clearing && <Loader2 size={10} className="animate-spin" />}
                  {t('browser.siteInfo.clearConfirm')}
                </button>
                <button
                  onClick={() => setConfirm(false)}
                  disabled={clearing}
                  className="px-2 py-0.5 rounded text-text-tertiary hover:text-text-secondary"
                >
                  {t('common.cancel')}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirm(true)}
                disabled={!info || info.cookieCount === 0}
                className="mt-1.5 px-2 py-0.5 -ml-2 rounded text-accent hover:bg-accent/10 disabled:text-text-tertiary disabled:hover:bg-transparent"
                data-site-clear
              >
                {t('browser.siteInfo.clear')}
              </button>
            )}
          </div>
        </div>
      )}

      <button
        onClick={() => {
          onClose()
          // 进这个网站的详情（主进程按可注册域名给出分组键）；还没查到就退回网站数据一节、搜索框填主机名
          openSettings('privacy', web && hostname ? hostname : undefined, info?.site)
        }}
        className="w-full flex items-center gap-3 px-4 py-2.5 border-t border-border-secondary/40 rounded-b-xl text-text-primary hover:bg-bg-hover/50"
        data-site-settings
      >
        <Settings size={15} className="text-text-secondary" />
        {t('browser.siteInfo.siteSettings')}
      </button>
    </div>
  )
}
