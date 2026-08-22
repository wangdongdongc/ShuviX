/**
 * AboutTab —— 共享关于页（应用信息 + 更新 + 项目链接 + 协议），prop 驱动 + 能力开关。
 *
 * 从桌面 AboutSettings 抽出。版本号 / openExternal 由宿主注入；更新区块通过可选 `update`
 * 注入：桌面传入完整更新 API，扩展不传 → 自动屏蔽更新区块（其余完全一致）。
 * about.* 文案来自共享 chat-protocol locales，两端一致。
 */
import { useTranslation } from 'react-i18next'
import {
  Github,
  ExternalLink,
  RefreshCw,
  Download,
  RotateCcw,
  AlertCircle,
  CheckCircle,
  Bug
} from 'lucide-react'
import type { UpdateEvent } from '@shuvix/chat-protocol/chatApi'
import logoImg from '../assets/ngnl_xiubi_color_mini.jpg'
import { SettingsSection, SettingsRow, Toggle } from './SettingsPrimitives'

const REPO_URL = 'https://github.com/wangdongdongc/ShuviX'

/** 更新能力（注入即显示更新区块；桌面提供，扩展不提供 → 屏蔽自动更新） */
export interface AboutTabUpdateApi {
  autoCheck: boolean
  event: UpdateEvent | null
  onToggleAutoCheck: () => void
  onCheck: () => void
  onDownload: () => void
  onInstall: () => void
}

export interface AboutTabProps {
  /** 应用版本号（桌面 app:version / 扩展 manifest.version） */
  appVersion?: string
  /** 打开外链（桌面 window.api.app.openExternal / 扩展 window.open） */
  openExternal: (url: string) => void
  /** 更新 API；不传则不渲染更新区块 */
  update?: AboutTabUpdateApi
}

export function AboutTab(props: AboutTabProps): React.JSX.Element {
  const { t } = useTranslation()
  const { appVersion, openExternal, update } = props

  const e = update?.event ?? null
  const isChecking = e?.type === 'checking'
  const isDownloading = e?.type === 'downloading'
  const isAvailable = e?.type === 'available'
  const isReady = e?.type === 'ready'

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
    if (isAvailable) {
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
            description={statusDesc || undefined}
            control={renderUpdateAction()}
          />
          <SettingsRow
            title={t('about.autoCheckUpdate')}
            control={<Toggle on={update.autoCheck} onClick={update.onToggleAutoCheck} />}
          />
        </SettingsSection>
      )}

      {/* 项目链接 */}
      <SettingsSection title={t('about.projectGroup')}>
        <button
          onClick={() => openExternal(REPO_URL)}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-bg-hover/40 transition-colors"
        >
          <Github size={14} className="text-text-secondary shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-text-primary">{t('about.sourceCode')}</div>
            <div className="text-[11px] text-text-tertiary mt-0.5 font-mono truncate">
              {REPO_URL}
            </div>
          </div>
          <ExternalLink size={11} className="text-text-tertiary shrink-0" />
        </button>
        <button
          onClick={() => openExternal(`${REPO_URL}/issues`)}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-bg-hover/40 transition-colors"
        >
          <Bug size={14} className="text-text-secondary shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-text-primary">{t('about.reportIssue')}</div>
            <div className="text-[11px] text-text-tertiary mt-0.5 font-mono truncate">
              {REPO_URL}/issues
            </div>
          </div>
          <ExternalLink size={11} className="text-text-tertiary shrink-0" />
        </button>
      </SettingsSection>

      {/* 开源协议 */}
      <p className="text-[11px] text-text-tertiary leading-relaxed px-1">{t('about.license')}</p>
    </div>
  )
}
