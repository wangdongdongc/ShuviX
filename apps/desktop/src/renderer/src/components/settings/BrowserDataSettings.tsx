/**
 * 内置浏览器的数据与证书设置 —— 挂在 MCP 设置里内置 `browser` 那一行的展开区。
 *
 * 以前它是「LLM 工具」页 browser 工具的子页；浏览器改成按会话勾选的内置 MCP 能力服务器之后，
 * 工具页上没有它了，设置跟着能力走。内容本身讲的是**面板那个浏览器**（已保存站点的 cookie、
 * 证书错误怎么处理），与 agent 有没有勾上它无关 —— 用户自己在面板里浏览时同样适用。
 */
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Trash2, TriangleAlert, Globe } from 'lucide-react'
import { SettingsSection, SettingsRow, Toggle } from './SettingsPrimitives'

interface SavedSite {
  host: string
  cookieCount: number
}

export function BrowserDataSettings(): React.JSX.Element {
  const { t } = useTranslation()

  const [ignoreCert, setIgnoreCert] = useState(false)
  const [loading, setLoading] = useState(true)
  const [sites, setSites] = useState<SavedSite[]>([])
  const [sitesLoading, setSitesLoading] = useState(true)
  const [confirmHost, setConfirmHost] = useState<string | null>(null)
  const [clearingHost, setClearingHost] = useState<string | null>(null)
  const [confirmClearAll, setConfirmClearAll] = useState(false)
  const [clearingAll, setClearingAll] = useState(false)

  const loadSites = useCallback(async () => {
    setSitesLoading(true)
    try {
      const list = await window.api.browserData.listSites()
      setSites(list)
    } finally {
      setSitesLoading(false)
    }
  }, [])

  useEffect(() => {
    window.api.settings.getAll().then((settings) => {
      setIgnoreCert(settings['tool.browser.ignoreCertificateErrors'] === 'true')
      setLoading(false)
    })
    loadSites()
  }, [loadSites])

  const handleToggle = (): void => {
    const next = !ignoreCert
    setIgnoreCert(next)
    window.api.settings.set({
      key: 'tool.browser.ignoreCertificateErrors',
      value: String(next)
    })
  }

  const handleClearSite = async (host: string): Promise<void> => {
    setClearingHost(host)
    try {
      await window.api.browserData.clearSite(host)
      await loadSites()
    } finally {
      setClearingHost(null)
      setConfirmHost(null)
    }
  }

  const handleClearAll = async (): Promise<void> => {
    setClearingAll(true)
    try {
      await window.api.browserData.clearAll()
      await loadSites()
    } finally {
      setClearingAll(false)
      setConfirmClearAll(false)
    }
  }

  return (
    <div className="flex-1 px-5 py-5 space-y-5">
      {/* 行为 */}
      <SettingsSection
        title={t('settings.toolBrowserTitle')}
        description={t('settings.toolBrowserDesc')}
      >
        {loading ? (
          <div className="flex items-center gap-2 px-4 py-4 text-text-tertiary">
            <Loader2 size={12} className="animate-spin" />
            <span className="text-[11px]">{t('common.loading') || 'Loading...'}</span>
          </div>
        ) : (
          <>
            <SettingsRow
              title={t('settings.toolBrowserIgnoreCertificateErrors')}
              description={t('settings.toolBrowserIgnoreCertificateErrorsHint')}
              control={<Toggle on={ignoreCert} onClick={handleToggle} />}
            />
            {ignoreCert && (
              <div className="flex items-start gap-2 px-4 py-3 bg-amber-500/5">
                <TriangleAlert size={12} className="text-amber-500 shrink-0 mt-0.5" />
                <p className="text-[11px] text-text-secondary leading-relaxed">
                  {t('settings.toolBrowserSecurityWarning')}
                </p>
              </div>
            )}
          </>
        )}
      </SettingsSection>

      {/* 已保存站点 */}
      <SettingsSection
        title={t('settings.toolBrowserSavedSitesTitle')}
        description={t('settings.toolBrowserSavedSitesDesc')}
        headerAction={
          <div className="flex items-center gap-3">
            {sites.length > 0 &&
              (confirmClearAll ? (
                <div className="flex items-center gap-1">
                  <button
                    onClick={handleClearAll}
                    disabled={clearingAll}
                    className="px-1.5 py-0.5 text-[10px] text-error hover:bg-error/10 rounded transition-colors disabled:opacity-50 flex items-center gap-1"
                  >
                    {clearingAll && <Loader2 size={9} className="animate-spin" />}
                    {t('common.confirm')}
                  </button>
                  <button
                    onClick={() => setConfirmClearAll(false)}
                    disabled={clearingAll}
                    className="px-1.5 py-0.5 text-[10px] text-text-tertiary hover:text-text-secondary rounded transition-colors disabled:opacity-50"
                  >
                    {t('ssh.cancel')}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmClearAll(true)}
                  className="text-[11px] text-text-tertiary hover:text-error transition-colors"
                >
                  {t('settings.toolBrowserClearAll')}
                </button>
              ))}
            <button
              onClick={loadSites}
              disabled={sitesLoading}
              className="text-[11px] text-text-tertiary hover:text-text-secondary disabled:opacity-50 transition-colors"
            >
              {sitesLoading ? <Loader2 size={11} className="animate-spin" /> : t('common.refresh')}
            </button>
          </div>
        }
      >
        {sitesLoading && sites.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-4 text-text-tertiary">
            <Loader2 size={12} className="animate-spin" />
            <span className="text-[11px]">{t('common.loading') || 'Loading...'}</span>
          </div>
        ) : sites.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-[11px] text-text-tertiary">{t('settings.toolBrowserNoSites')}</p>
          </div>
        ) : (
          sites.map((site) => (
            <SettingsRow
              key={site.host}
              icon={<Globe size={11} className="text-text-tertiary shrink-0" />}
              title={<span className="font-mono">{site.host}</span>}
              control={
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-text-tertiary tabular-nums">
                    {site.cookieCount}
                  </span>
                  {confirmHost === site.host ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleClearSite(site.host)}
                        disabled={clearingHost === site.host}
                        className="px-1.5 py-0.5 text-[10px] text-error hover:bg-error/10 rounded transition-colors disabled:opacity-50 flex items-center gap-1"
                      >
                        {clearingHost === site.host && (
                          <Loader2 size={9} className="animate-spin" />
                        )}
                        {t('common.confirm')}
                      </button>
                      <button
                        onClick={() => setConfirmHost(null)}
                        disabled={clearingHost === site.host}
                        className="px-1.5 py-0.5 text-[10px] text-text-tertiary hover:text-text-secondary rounded transition-colors disabled:opacity-50"
                      >
                        {t('ssh.cancel')}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmHost(site.host)}
                      className="p-1 text-text-tertiary hover:text-error transition-colors"
                      title={t('settings.toolBrowserClearSite')}
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
              }
            />
          ))
        )}
      </SettingsSection>
    </div>
  )
}
