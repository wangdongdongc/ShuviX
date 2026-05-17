import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Github,
  ExternalLink,
  RefreshCw,
  Download,
  RotateCcw,
  AlertCircle,
  CheckCircle
} from 'lucide-react'
import logoImg from '../../assets/ngnl_xiubi_color_mini.jpg'
import { useUpdateStore } from '../../stores/updateStore'
import { useSettingsStore } from '../../stores/settingsStore'

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
    // 拉取主进程缓存的最后一次事件（用户通过侧边栏按钮跳转过来时已有结果）
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

  /** 根据当前更新事件渲染状态行 */
  const renderUpdateStatus = (): React.JSX.Element | null => {
    if (!updateEvent) return null

    switch (updateEvent.type) {
      case 'checking':
        return null
      case 'up-to-date':
        return (
          <p className="text-[11px] text-text-tertiary mt-1 flex items-center gap-1">
            <CheckCircle size={10} className="text-green-500" />
            {t('about.updateUpToDate', { version: updateEvent.version })}
          </p>
        )
      case 'available':
        return (
          <p className="text-[11px] text-blue-400 mt-1">
            {t('about.updateAvailable', { version: updateEvent.version })}
          </p>
        )
      case 'downloading':
        return (
          <p className="text-[11px] text-text-tertiary mt-1 flex items-center gap-1">
            <Download size={10} className="animate-bounce" />
            {t('about.updateDownloading', { percent: Math.round(updateEvent.percent) })}
          </p>
        )
      case 'ready':
        return (
          <div className="mt-1 space-y-1">
            <p className="text-[11px] text-green-400">
              {t('about.updateReady', { version: updateEvent.version })}
            </p>
            <button
              onClick={handleInstall}
              className="text-[11px] px-2 py-0.5 rounded bg-green-600 hover:bg-green-500 text-white transition-colors flex items-center gap-1"
            >
              <RotateCcw size={10} />
              {t('about.updateInstall')}
            </button>
          </div>
        )
      case 'error':
        return (
          <p className="text-[11px] text-red-400 mt-1 flex items-center gap-1">
            <AlertCircle size={10} />
            {t('about.updateError', { message: updateEvent.message })}
          </p>
        )
      default:
        return null
    }
  }

  const isChecking = updateEvent?.type === 'checking'
  const isDownloading = updateEvent?.type === 'downloading'
  const isAvailable = updateEvent?.type === 'available'

  return (
    <div className="flex-1 px-5 py-5 space-y-6">
      {/* 应用信息 */}
      <div className="flex items-start gap-4">
        <img src={logoImg} alt="ShuviX" className="w-16 h-16 rounded-2xl shadow-lg object-cover" />
        <div>
          <h3 className="text-lg font-semibold text-text-primary">ShuviX</h3>
          <p className="text-xs text-text-tertiary mt-0.5">{t('about.description')}</p>
          {appVersion && (
            <p className="text-[11px] text-text-tertiary mt-1">
              {t('about.version', { version: appVersion })}
            </p>
          )}
          <button
            onClick={isAvailable ? handleDownload : handleCheck}
            disabled={isChecking || isDownloading}
            className={`flex items-center gap-1.5 mt-1.5 px-2 py-1 rounded border text-[11px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              isAvailable
                ? 'border-blue-600 bg-blue-600 hover:bg-blue-500 hover:border-blue-500 text-white'
                : 'border-border-primary bg-bg-secondary hover:bg-bg-hover text-text-primary'
            }`}
          >
            {isAvailable ? (
              <Download size={11} />
            ) : (
              <RefreshCw size={11} className={isChecking ? 'animate-spin' : ''} />
            )}
            {isAvailable ? t('about.updateDownload') : t('about.checkUpdate')}
          </button>
          {renderUpdateStatus()}
        </div>
      </div>

      {/* 自动检查更新开关 */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-text-secondary">{t('about.autoCheckUpdate')}</span>
        <button
          onClick={handleToggleAutoCheck}
          className={`relative w-8 h-[18px] rounded-full transition-colors ${autoCheckUpdate ? 'bg-accent' : 'bg-bg-hover'}`}
        >
          <span
            className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${autoCheckUpdate ? 'left-[16px]' : 'left-[2px]'}`}
          />
        </button>
      </div>

      {/* 链接 */}
      <div className="space-y-2">
        <button
          onClick={() => openLink(REPO_URL)}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-border-primary bg-bg-secondary hover:bg-bg-hover transition-colors group"
        >
          <Github size={18} className="text-text-secondary group-hover:text-text-primary" />
          <div className="flex-1 text-left">
            <div className="text-xs font-medium text-text-primary">{t('about.sourceCode')}</div>
            <div className="text-[10px] text-text-tertiary mt-0.5">{REPO_URL}</div>
          </div>
          <ExternalLink size={14} className="text-text-tertiary group-hover:text-text-secondary" />
        </button>

        <button
          onClick={() => openLink(`${REPO_URL}/issues`)}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-border-primary bg-bg-secondary hover:bg-bg-hover transition-colors group"
        >
          <span className="w-[18px] text-center text-text-secondary group-hover:text-text-primary text-sm">
            🐛
          </span>
          <div className="flex-1 text-left">
            <div className="text-xs font-medium text-text-primary">{t('about.reportIssue')}</div>
            <div className="text-[10px] text-text-tertiary mt-0.5">{REPO_URL}/issues</div>
          </div>
          <ExternalLink size={14} className="text-text-tertiary group-hover:text-text-secondary" />
        </button>
      </div>

      {/* 开源协议 */}
      <div className="text-[10px] text-text-tertiary leading-relaxed">
        <p>{t('about.license')}</p>
      </div>
    </div>
  )
}
