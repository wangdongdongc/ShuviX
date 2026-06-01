import { useState, useEffect } from 'react'
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
import logoImg from '../../assets/ngnl_xiubi_color_mini.jpg'
import { useUpdateStore } from '../../stores/updateStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { SettingsSection, SettingsRow, Toggle } from './SettingsPrimitives'

const REPO_URL = 'https://github.com/wangdongdongc/ShuviX'

/**
 * 关于页 — 展示应用版本、开源仓库等信息，并提供检查/安装更新功能
 */
export function AboutSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [appVersion, setAppVersion] = useState('')
  const { updateEvent, setUpdateEvent } = useUpdateStore()
  const { autoCheckUpdate } = useSettingsStore()

  useEffect(() => {
    void window.electron.ipcRenderer.invoke('app:version').then((v: string) => setAppVersion(v))
  }, [])

  // 注册实时事件监听（设置窗口独立进程，主窗口的 useAppInit 监听器不共享）
  useEffect(() => {
    const removeListener = window.api.update.onEvent((event) => {
      setUpdateEvent(event)
    })
    void window.api.update.getLastEvent().then((last) => {
      if (last) setUpdateEvent(last)
    })
    return removeListener
  }, [setUpdateEvent])

  const openLink = (url: string): void => {
    void window.api.app.openExternal(url)
  }

  const handleCheck = (): void => {
    setUpdateEvent(null)
    void window.api.update.check()
  }

  const handleToggleAutoCheck = (): void => {
    const next = !autoCheckUpdate
    useSettingsStore.setState({ autoCheckUpdate: next })
    void window.api.settings.set({ key: 'updates.autoCheck', value: String(next) })
  }

  const handleDownload = (): void => {
    void window.api.update.download()
  }

  const handleInstall = (): void => {
    void window.api.update.install()
  }

  const isChecking = updateEvent?.type === 'checking'
  const isDownloading = updateEvent?.type === 'downloading'
  const isAvailable = updateEvent?.type === 'available'
  const isReady = updateEvent?.type === 'ready'

  /** 更新状态信息（标题 / 描述 / 操作按钮） */
  const renderUpdateAction = (): React.JSX.Element => {
    if (isReady) {
      return (
        <button
          onClick={handleInstall}
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
          onClick={handleDownload}
          className="flex items-center gap-1 px-3 py-1 rounded-md text-[11px] font-medium bg-accent text-white hover:bg-accent-hover transition-colors"
        >
          <Download size={11} />
          {t('about.updateDownload')}
        </button>
      )
    }
    return (
      <button
        onClick={handleCheck}
        disabled={isChecking || isDownloading}
        className="flex items-center gap-1 px-3 py-1 rounded-md text-[11px] text-text-secondary border border-border-secondary/50 hover:text-text-primary hover:border-border-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <RefreshCw size={11} className={isChecking ? 'animate-spin' : ''} />
        {t('about.checkUpdate')}
      </button>
    )
  }

  /** 当前版本下方的状态描述 */
  const renderUpdateStatusDesc = (): React.JSX.Element | null => {
    if (!updateEvent) return null

    switch (updateEvent.type) {
      case 'up-to-date':
        return (
          <span className="inline-flex items-center gap-1 text-emerald-500">
            <CheckCircle size={10} />
            {t('about.updateUpToDate', { version: updateEvent.version })}
          </span>
        )
      case 'available':
        return (
          <span className="text-accent">
            {t('about.updateAvailable', { version: updateEvent.version })}
          </span>
        )
      case 'downloading':
        return (
          <span className="inline-flex items-center gap-1 text-text-tertiary">
            <Download size={10} className="animate-bounce" />
            {t('about.updateDownloading', { percent: Math.round(updateEvent.percent) })}
          </span>
        )
      case 'ready':
        return (
          <span className="text-emerald-500">
            {t('about.updateReady', { version: updateEvent.version })}
          </span>
        )
      case 'error':
        return (
          <span className="inline-flex items-center gap-1 text-danger">
            <AlertCircle size={10} />
            {t('about.updateError', { message: updateEvent.message })}
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

      {/* 更新 */}
      <SettingsSection title={t('about.updateGroup')}>
        <SettingsRow
          title={t('about.checkUpdate')}
          description={statusDesc || undefined}
          control={renderUpdateAction()}
        />
        <SettingsRow
          title={t('about.autoCheckUpdate')}
          control={<Toggle on={autoCheckUpdate} onClick={handleToggleAutoCheck} />}
        />
      </SettingsSection>

      {/* 项目链接 */}
      <SettingsSection title={t('about.projectGroup')}>
        <button
          onClick={() => openLink(REPO_URL)}
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
          onClick={() => openLink(`${REPO_URL}/issues`)}
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
