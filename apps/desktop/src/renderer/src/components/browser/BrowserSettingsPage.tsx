import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Globe,
  Loader2,
  Search,
  ShieldCheck,
  ShieldAlert,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import { SettingsSection, SettingsRow, Toggle, InlineSelect } from '../settings/SettingsPrimitives'
import { useBrowserTabsStore } from '../../stores/browserTabsStore'
import {
  SEARCH_ENGINE_SETTING,
  SEARCH_ENGINES,
  searchEngineOf,
  type SearchEngineId
} from './omnibox'

const IGNORE_CERT_SETTING = 'tool.browser.ignoreCertificateErrors'

/** 设置页的三节（左侧导航与锚点） */
export type BrowserSettingsSection = 'search' | 'privacy' | 'certificates'
const SECTIONS: Array<{ id: BrowserSettingsSection; icon: typeof Search; labelKey: string }> = [
  { id: 'search', icon: Search, labelKey: 'browser.settingsPage.search' },
  { id: 'privacy', icon: ShieldCheck, labelKey: 'browser.settingsPage.privacy' },
  { id: 'certificates', icon: ShieldAlert, labelKey: 'browser.settingsPage.certificates' }
]

interface SavedSite {
  host: string
  cookieCount: number
}

/**
 * 浏览器的设置页 —— 内部页面 `shuvix://settings`（Chrome 的 chrome://settings 那个位置），在一个标签页里
 * 打开（⋮ → 设置；主设置窗口 MCP → 内置 browser 那一行的「打开浏览器设置」）。2026-10-16 从 MCP 设置里
 * 搬过来：这些设置讲的是浏览器本身，不是 agent 的能力。
 *
 * 三节照 Chrome 的分法：搜索引擎；隐私和安全（删除浏览数据、网站数据 —— chrome://settings/content/all）；
 * 证书（忽略全部证书错误 —— Chrome 没有这个开关，留给内网自签名证书用 —— 与本次运行里放行过的网站）。
 * 页面是浏览器窗口外壳里的 DOM，agent 碰不到（它那一侧根本看不到这个 tab）。
 */
export function BrowserSettingsPage({ compact }: { compact?: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const focus = useBrowserTabsStore((s) => s.settingsFocus)
  const clearSettingsFocus = useBrowserTabsStore((s) => s.clearSettingsFocus)

  const [engine, setEngine] = useState<SearchEngineId>(searchEngineOf(undefined))
  const [ignoreCert, setIgnoreCert] = useState(false)
  const [sites, setSites] = useState<SavedSite[] | null>(null)
  const [query, setQuery] = useState('')
  const [confirmHost, setConfirmHost] = useState<string | null>(null)
  const [busyHost, setBusyHost] = useState<string | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const [clearingAll, setClearingAll] = useState(false)
  const [certHosts, setCertHosts] = useState<string[]>([])

  const loadSites = useCallback(async () => {
    setSites(await window.api.browserData.listSites())
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [settings, list, certs] = await Promise.all([
        window.api.settings.getAll(),
        window.api.browserData.listSites(),
        window.api.browserData.certExceptions()
      ])
      if (cancelled) return
      setEngine(searchEngineOf(settings[SEARCH_ENGINE_SETTING]))
      setIgnoreCert(settings[IGNORE_CERT_SETTING] === 'true')
      setSites(list)
      setCertHosts(certs)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 站点信息气泡里的「网站设置」：跳到那一节、搜索框填上那个站点。请求用一次就清掉 —— 之后切走再切回来
  // （单页视图里设置页会重新挂载）不会再跳一次、也不会盖掉用户自己改过的搜索词
  useEffect(() => {
    if (!focus) return
    const raf = requestAnimationFrame(() => {
      if (focus.search !== undefined) setQuery(focus.search)
      scrollRef.current
        ?.querySelector(`[data-settings-section="${focus.section}"]`)
        ?.scrollIntoView({ block: 'start' })
      clearSettingsFocus()
    })
    return () => cancelAnimationFrame(raf)
  }, [focus, clearSettingsFocus])

  const changeEngine = (value: string): void => {
    const next = searchEngineOf(value)
    setEngine(next)
    void window.api.settings.set({ key: SEARCH_ENGINE_SETTING, value: next })
  }

  const toggleIgnoreCert = (): void => {
    const next = !ignoreCert
    setIgnoreCert(next)
    void window.api.settings.set({ key: IGNORE_CERT_SETTING, value: String(next) })
  }

  const clearSite = async (host: string): Promise<void> => {
    setBusyHost(host)
    try {
      await window.api.browserData.clearSite(host)
      await loadSites()
    } finally {
      setBusyHost(null)
      setConfirmHost(null)
    }
  }

  const clearAll = async (): Promise<void> => {
    setClearingAll(true)
    try {
      await window.api.browserData.clearAll()
      await loadSites()
    } finally {
      setClearingAll(false)
      setConfirmAll(false)
    }
  }

  // 主机名也认它的父域：www.github.com 的登录态常记在 github.com 上
  const needle = query.trim().toLowerCase()
  const shown = (sites ?? []).filter((s) => {
    const host = s.host.toLowerCase()
    return !needle || host.includes(needle) || needle.endsWith(`.${host}`)
  })
  const confirmBtn =
    'px-2 py-0.5 text-[11px] text-error hover:bg-error/10 rounded transition-colors disabled:opacity-50 flex items-center gap-1'
  const cancelBtn =
    'px-2 py-0.5 text-[11px] text-text-tertiary hover:text-text-secondary rounded transition-colors disabled:opacity-50'

  return (
    <div
      className="absolute inset-0 flex bg-bg-primary text-text-primary"
      data-browser-settings-page
    >
      {!compact && (
        <nav className="flex-shrink-0 w-48 px-2 py-5 border-r border-border-secondary/40 space-y-0.5">
          <h1 className="px-3 pb-3 text-[15px] font-medium">{t('browser.settingsPage.title')}</h1>
          {SECTIONS.map(({ id, icon: Icon, labelKey }) => (
            <button
              key={id}
              onClick={() =>
                scrollRef.current
                  ?.querySelector(`[data-settings-section="${id}"]`)
                  ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
              }
              className="w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] text-text-secondary hover:bg-bg-hover/60 hover:text-text-primary transition-colors"
              data-settings-nav={id}
            >
              <Icon size={14} />
              {t(labelKey)}
            </button>
          ))}
        </nav>
      )}

      <div ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto">
        <div className={`mx-auto max-w-[720px] space-y-5 ${compact ? 'px-3 py-3' : 'px-6 py-6'}`}>
          {/* ── 搜索引擎 ── */}
          <div data-settings-section="search" className="scroll-mt-4">
            <SettingsSection title={t('browser.settingsPage.search')}>
              <SettingsRow
                title={t('settings.toolBrowserSearchEngine')}
                description={t('settings.toolBrowserSearchEngineHint')}
                control={
                  <InlineSelect value={engine} onChange={changeEngine} width={160}>
                    {(Object.keys(SEARCH_ENGINES) as SearchEngineId[]).map((id) => (
                      <option key={id} value={id}>
                        {SEARCH_ENGINES[id].name}
                      </option>
                    ))}
                  </InlineSelect>
                }
              />
            </SettingsSection>
          </div>

          {/* ── 隐私和安全 ── */}
          <div data-settings-section="privacy" className="scroll-mt-4 space-y-5">
            <SettingsSection title={t('browser.settingsPage.privacy')}>
              <SettingsRow
                title={t('browser.settingsPage.clearAll')}
                description={t('browser.settingsPage.clearAllDesc')}
                control={
                  confirmAll ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => void clearAll()}
                        disabled={clearingAll}
                        className={confirmBtn}
                        data-clear-all-confirm
                      >
                        {clearingAll && <Loader2 size={10} className="animate-spin" />}
                        {t('browser.settingsPage.clearAllConfirm')}
                      </button>
                      <button
                        onClick={() => setConfirmAll(false)}
                        disabled={clearingAll}
                        className={cancelBtn}
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmAll(true)}
                      className="px-2.5 py-1 text-[11px] rounded-md border border-border-secondary/60 text-text-secondary hover:bg-bg-hover/60 transition-colors"
                      data-clear-all
                    >
                      {t('browser.settingsPage.clearAllButton')}
                    </button>
                  )
                }
              />
            </SettingsSection>

            <SettingsSection
              title={t('browser.settingsPage.siteData')}
              description={t('browser.settingsPage.siteDataDesc')}
              headerAction={
                <label className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-bg-secondary border border-border-secondary/40 focus-within:border-accent/50">
                  <Search size={11} className="text-text-tertiary" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('browser.settingsPage.searchSites')}
                    spellCheck={false}
                    className="w-36 bg-transparent text-[11px] outline-none placeholder:text-text-tertiary"
                    data-site-search
                  />
                </label>
              }
            >
              {sites === null ? (
                <div className="flex items-center gap-2 px-4 py-4 text-text-tertiary">
                  <Loader2 size={12} className="animate-spin" />
                  <span className="text-[11px]">{t('common.loading')}</span>
                </div>
              ) : shown.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-[11px] text-text-tertiary">
                    {sites.length === 0
                      ? t('settings.toolBrowserNoSites')
                      : t('browser.settingsPage.noMatch')}
                  </p>
                </div>
              ) : (
                shown.map((site) => (
                  <div key={site.host} data-site-row={site.host}>
                    <SettingsRow
                      icon={<Globe size={12} className="text-text-tertiary shrink-0" />}
                      title={<span className="font-mono">{site.host}</span>}
                      control={
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-text-tertiary tabular-nums">
                            {t('browser.settingsPage.cookies', { count: site.cookieCount })}
                          </span>
                          {confirmHost === site.host ? (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => void clearSite(site.host)}
                                disabled={busyHost === site.host}
                                className={confirmBtn}
                                data-clear-site-confirm
                              >
                                {busyHost === site.host && (
                                  <Loader2 size={10} className="animate-spin" />
                                )}
                                {t('common.confirm')}
                              </button>
                              <button
                                onClick={() => setConfirmHost(null)}
                                disabled={busyHost === site.host}
                                className={cancelBtn}
                              >
                                {t('common.cancel')}
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmHost(site.host)}
                              className="p-1 text-text-tertiary hover:text-error transition-colors"
                              title={t('settings.toolBrowserClearSite')}
                              aria-label={t('settings.toolBrowserClearSite')}
                              data-clear-site
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                      }
                    />
                  </div>
                ))
              )}
            </SettingsSection>
          </div>

          {/* ── 证书 ── */}
          <div data-settings-section="certificates" className="scroll-mt-4">
            <SettingsSection title={t('browser.settingsPage.certificates')}>
              <SettingsRow
                title={t('settings.toolBrowserIgnoreCertificateErrors')}
                description={t('settings.toolBrowserIgnoreCertificateErrorsHint')}
                control={<Toggle on={ignoreCert} onClick={toggleIgnoreCert} />}
              />
              {ignoreCert && (
                <div className="flex items-start gap-2 px-4 py-3 bg-amber-500/5">
                  <TriangleAlert size={12} className="text-amber-500 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-text-secondary leading-relaxed">
                    {t('settings.toolBrowserSecurityWarning')}
                  </p>
                </div>
              )}
              <SettingsRow
                title={t('browser.settingsPage.certExceptions')}
                description={t('browser.settingsPage.certExceptionsDesc')}
                subtitle={
                  certHosts.length === 0
                    ? t('browser.settingsPage.noCertExceptions')
                    : certHosts.join(' · ')
                }
              />
            </SettingsSection>
          </div>
        </div>
      </div>
    </div>
  )
}
