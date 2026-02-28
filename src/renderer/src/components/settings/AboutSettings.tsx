import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Github, ExternalLink } from 'lucide-react'
import logoImg from '../../assets/ngnl_xiubi_color_mini.jpg'

const REPO_URL = 'https://github.com/wangdongdongc/ShuviX'

/**
 * 关于页 — 展示应用版本、开源仓库等信息
 */
export function AboutSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    window.electron.ipcRenderer.invoke('app:version').then((v: string) => setAppVersion(v))
  }, [])

  /** 用系统浏览器打开链接 */
  const openLink = (url: string): void => {
    void window.api.app.openExternal(url)
  }

  return (
    <div className="flex-1 px-5 py-5 space-y-6">
      {/* 应用信息 */}
      <div className="flex items-center gap-4">
        <img src={logoImg} alt="ShuviX" className="w-16 h-16 rounded-2xl shadow-lg object-cover" />
        <div>
          <h3 className="text-lg font-semibold text-text-primary">ShuviX</h3>
          <p className="text-xs text-text-tertiary mt-0.5">{t('about.description')}</p>
          {appVersion && (
            <p className="text-[11px] text-text-tertiary mt-1">
              {t('about.version', { version: appVersion })}
            </p>
          )}
        </div>
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
