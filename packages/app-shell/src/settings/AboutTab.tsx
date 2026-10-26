/**
 * AboutTab —— 共享关于页（应用信息 + 更新 + 日志 + 协议与源码仓库链接），prop 驱动 + 能力开关。
 *
 * 从桌面 AboutSettings 抽出。版本号 / openExternal 由宿主注入；更新区块通过可选 `update`
 * 注入：桌面传入完整更新 API，扩展不传 → 自动屏蔽更新区块（其余完全一致）。日志区块同理（可选 `appLog`）：
 * 用户被问「日志在哪」时的去处 —— 路径、复制路径、在文件夹中显示（宿主给了才有）、去监视器里查看。
 * 主进程装不了更新时（无头运行），`available` 事件带 `manual`：不给下载按钮，改为说明 + 要在那台电脑上执行的命令。
 * about.* 文案来自共享 chat-protocol locales，两端一致。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { copyToClipboard } from '@shuvix/chat-ui'
import {
  Github,
  RefreshCw,
  Download,
  RotateCcw,
  AlertCircle,
  CheckCircle,
  Copy,
  Check,
  FolderOpen
} from 'lucide-react'
import type { UpdateEvent } from '@shuvix/chat-protocol/chatApi'
import logoImg from '../assets/ngnl_xiubi_color_mini.jpg'
import { SettingsSection, SettingsRow, Toggle } from './SettingsPrimitives'

const REPO_URL = 'https://github.com/wangdongdongc/ShuviX'

/** 次要按钮（与「检查更新」同一套描边样式） */
const SECONDARY_BUTTON =
  'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-secondary border border-border-secondary/50 hover:text-text-primary hover:border-border-secondary transition-colors'

/** 更新能力（注入即显示更新区块；桌面提供，扩展不提供 → 屏蔽自动更新） */
export interface AboutTabUpdateApi {
  autoCheck: boolean
  event: UpdateEvent | null
  onToggleAutoCheck: () => void
  onCheck: () => void
  onDownload: () => void
  onInstall: () => void
}

/** 应用日志（注入即显示日志区块） */
export interface AboutTabLogApi {
  /** main.log 的绝对路径 */
  path: string
  /** 去设置 → 监视器 → 应用日志 */
  onView: () => void
  /** 在系统文件管理器里选中它；不传（web 客户端：文件在另一台电脑上）→ 不给这个按钮 */
  onReveal?: () => void
}

export interface AboutTabProps {
  /** 应用版本号（桌面 app:version / 扩展 manifest.version） */
  appVersion?: string
  /** 打开外链（桌面 window.api.app.openExternal / 扩展 window.open） */
  openExternal: (url: string) => void
  /** 更新 API；不传则不渲染更新区块 */
  update?: AboutTabUpdateApi
  /** 应用日志；不传则不渲染日志区块 */
  appLog?: AboutTabLogApi
}

export function AboutTab(props: AboutTabProps): React.JSX.Element {
  const { t } = useTranslation()
  const { appVersion, openExternal, update, appLog } = props

  const e = update?.event ?? null
  const isChecking = e?.type === 'checking'
  const isDownloading = e?.type === 'downloading'
  const isAvailable = e?.type === 'available'
  const isReady = e?.type === 'ready'
  const manual = e?.type === 'available' ? e.manual : undefined

  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const [logPathCopied, setLogPathCopied] = useState(false)
  useEffect(() => {
    if (!logPathCopied) return
    const timer = setTimeout(() => setLogPathCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [logPathCopied])

  const renderUpdateAction = (): React.JSX.Element | null => {
    if (!update) return null
    if (isReady) {
      return (
        <button
          onClick={update.onInstall}
          className="flex items-center gap-1 px-3 py-1 rounded-md text-[11px] font-medium bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
        >
          <RotateCcw size={11} />
          {t('about.updateInstall')}
        </button>
      )
    }
    if (isAvailable && !manual) {
      return (
        <button
          onClick={update.onDownload}
          className="flex items-center gap-1 px-3 py-1 rounded-md text-[11px] font-medium bg-accent text-white hover:bg-accent-hover transition-colors"
        >
          <Download size={11} />
          {t('about.updateDownload')}
        </button>
      )
    }
    return (
      <button
        onClick={update.onCheck}
        disabled={isChecking || isDownloading}
        className="flex items-center gap-1 px-3 py-1 rounded-md text-[11px] text-text-secondary border border-border-secondary/50 hover:text-text-primary hover:border-border-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <RefreshCw size={11} className={isChecking ? 'animate-spin' : ''} />
        {t('about.checkUpdate')}
      </button>
    )
  }

  const renderUpdateStatusDesc = (): React.JSX.Element | null => {
    if (!e) return null
    switch (e.type) {
      case 'up-to-date':
        return (
          <span className="inline-flex items-center gap-1 text-emerald-500">
            <CheckCircle size={10} />
            {t('about.updateUpToDate', { version: e.version })}
          </span>
        )
      case 'available':
        return (
          <span className="text-accent">{t('about.updateAvailable', { version: e.version })}</span>
        )
      case 'downloading':
        return (
          <span className="inline-flex items-center gap-1 text-text-tertiary">
            <Download size={10} className="animate-bounce" />
            {t('about.updateDownloading', { percent: Math.round(e.percent) })}
          </span>
        )
      case 'ready':
        return (
          <span className="text-emerald-500">{t('about.updateReady', { version: e.version })}</span>
        )
      case 'error':
        return (
          <span className="inline-flex items-center gap-1 text-error">
            <AlertCircle size={10} />
            {t('about.updateError', { message: e.message })}
          </span>
        )
      default:
        return null
    }
  }

  const statusDesc = renderUpdateStatusDesc()

  return (
    <div className="flex-1 px-5 py-5 space-y-5">
      {/* Hero — 应用信息 */}
      <div className="flex items-center gap-4 px-1">
        <img src={logoImg} alt="ShuviX" className="w-16 h-16 rounded-2xl shadow-md object-cover" />
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-text-primary">ShuviX</h3>
          <p className="text-[11px] text-text-tertiary mt-0.5 leading-relaxed">
            {t('about.description')}
          </p>
          {appVersion && (
            <p className="text-[11px] text-text-tertiary mt-1 font-mono">v{appVersion}</p>
          )}
        </div>
      </div>

      {/* 更新（桌面专属；扩展不注入 update → 不渲染） */}
      {update && (
        <SettingsSection title={t('about.updateGroup')}>
          <SettingsRow
            title={t('about.checkUpdate')}
            subtitle={statusDesc || undefined}
            control={renderUpdateAction()}
          />
          {manual && (
            <div className="px-4 py-3 space-y-2" data-update-manual>
              <p className="text-[11px] text-text-secondary leading-relaxed">
                {manual.command ? t('about.updateManual') : t('about.updateManualNoCommand')}
              </p>
              {manual.command && (
                <div className="flex items-start gap-2">
                  <code
                    className="flex-1 min-w-0 break-all rounded-md bg-bg-tertiary px-2 py-1.5 text-[11px] font-mono text-text-primary select-all"
                    data-update-command
                  >
                    {manual.command}
                  </code>
                  <button
                    onClick={() => {
                      copyToClipboard(manual.command ?? '')
                      setCopied(true)
                    }}
                    className="flex shrink-0 items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-secondary border border-border-secondary/50 hover:text-text-primary hover:border-border-secondary transition-colors"
                    data-update-command-copy
                  >
                    {copied ? <Check size={11} /> : <Copy size={11} />}
                    {copied ? t('about.commandCopied') : t('about.copyCommand')}
                  </button>
                </div>
              )}
            </div>
          )}
          <SettingsRow
            title={t('about.autoCheckUpdate')}
            control={<Toggle on={update.autoCheck} onClick={update.onToggleAutoCheck} />}
          />
        </SettingsSection>
      )}

      {/* 日志（桌面与它的 web 客户端；扩展不注入 appLog → 不渲染） */}
      {appLog && (
        <SettingsSection title={t('about.logGroup')}>
          <SettingsRow
            title={t('about.appLog')}
            subtitle={t('about.appLogDesc')}
            control={
              <button onClick={appLog.onView} className={SECONDARY_BUTTON} data-about-log-view>
                {t('about.viewLog')}
              </button>
            }
          />
          <div className="px-4 pb-3 flex items-start gap-2">
            <code
              className="flex-1 min-w-0 break-all rounded-md bg-bg-tertiary px-2 py-1.5 text-[11px] font-mono text-text-primary select-all"
              data-about-log-path
            >
              {appLog.path}
            </code>
            <button
              onClick={() => {
                copyToClipboard(appLog.path)
                setLogPathCopied(true)
              }}
              className={`shrink-0 ${SECONDARY_BUTTON}`}
              data-about-log-copy
            >
              {logPathCopied ? <Check size={11} /> : <Copy size={11} />}
              {logPathCopied ? t('about.pathCopied') : t('about.copyPath')}
            </button>
            {appLog.onReveal && (
              <button
                onClick={appLog.onReveal}
                className={`shrink-0 ${SECONDARY_BUTTON}`}
                data-about-log-reveal
              >
                <FolderOpen size={11} />
                {t('about.revealLog')}
              </button>
            )}
          </div>
        </SettingsSection>
      )}

      {/* 开源协议 + 源码仓库链接 */}
      <div className="flex items-center gap-2 px-1">
        <p className="flex-1 min-w-0 text-[11px] text-text-tertiary leading-relaxed">
          {t('about.license')}
        </p>
        <button
          onClick={() => openExternal(REPO_URL)}
          title={t('about.sourceCode')}
          aria-label={t('about.sourceCode')}
          className="shrink-0 p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover/40 transition-colors"
          data-about-repo
        >
          <Github size={14} />
        </button>
      </div>
    </div>
  )
}
