/**
 * 手机布局的「浏览器设置」—— 从浏览器那一页推入（2026-11-17）。与浏览器窗口里的 `shuvix://settings`、桌面浏览器里
 * 远程访问时的管理页（BrowserSettingsPage）是同一组设置，换成手机的分组卡片：
 *
 *  - 设置：搜索引擎（地址栏用哪个、要不要搜索建议；那台电脑无头运行时没有地址栏，这一组置灰并说明）；隐私和安全
 *    （网站数据 → 推入一页；删除浏览历史、删除浏览数据，各先问一句）；证书（忽略证书错误、这次运行里放行过的网站）。
 *    读历史不在这里：历史只在那台电脑的浏览器窗口里读。
 *  - 网站数据：在内置浏览器里存过数据的网站，按主域名分组；搜索、按名称 / 占用排序（「⋯」）；点一个网站推入它那页。
 *  - 一个网站：BrowserSiteDetails 原样（分类、来源、Cookie、各自的删除），只是不画它自己的返回键与网站名。
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDownAZ,
  ArrowDownWideNarrow,
  ChevronRight,
  CircleEllipsis,
  Search,
  TriangleAlert,
  X
} from 'lucide-react'
import { ConfirmDialog } from '@shuvix/app-shell'
import { Toggle } from '../components/settings/SettingsPrimitives'
import {
  SEARCH_ENGINE_SETTING,
  SEARCH_ENGINES,
  searchEngineOf,
  type SearchEngineId
} from '../components/browser/omnibox'
import { BrowserSiteDetails } from '../components/browser/BrowserSiteDetails'
import { SEARCH_SUGGEST_SETTING, searchSuggestEnabled } from '../../../shared/browserSearchEngines'
import { formatBytes, type SiteSummary } from '../../../shared/browserSiteData'
import { MobilePage, pageCard, pageRow, pageRowBase, pageSectionLabel } from './MobilePage'
import { PullDownMenu, type PullDownItem } from './PullDownMenu'
import { shownSites, siteBytes, type SiteSort } from './browserPure'

const IGNORE_CERT_SETTING = 'tool.browser.ignoreCertificateErrors'

/** 开关按手指的尺寸放大（控件还是桌面那一个） */
function BigToggle({ on, onClick }: { on: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <span className="inline-flex shrink-0 origin-right scale-[1.3]">
      <Toggle on={on} onClick={onClick} />
    </span>
  )
}

export interface MobileBrowserSettingsPageProps {
  /** 那台电脑在无头运行：没有地址栏，搜索那一组置灰 */
  headless: boolean
  /** 这一页此刻在最上面（从网站数据退回来时重新数一遍网站：那里可能删过） */
  active: boolean
  onBack: () => void
  onOpenSites: () => void
}

export function MobileBrowserSettingsPage({
  headless,
  active,
  onBack,
  onOpenSites
}: MobileBrowserSettingsPageProps): React.JSX.Element {
  const { t } = useTranslation()
  const [engine, setEngine] = useState<SearchEngineId>(searchEngineOf(undefined))
  const [searchSuggest, setSearchSuggest] = useState(true)
  const [ignoreCert, setIgnoreCert] = useState(false)
  /** null = 还没取到（或取不到）：行尾不写数 */
  const [siteCount, setSiteCount] = useState<number | null>(null)
  const [certHosts, setCertHosts] = useState<string[]>([])
  const [confirming, setConfirming] = useState<'history' | 'all' | null>(null)

  const loadSiteCount = useCallback((): void => {
    void window.api.browserData.listSites().then(
      (list) => setSiteCount(list.length),
      () => setSiteCount(null)
    )
  }, [])

  // 各取各的：一样取不到不耽误别的
  useEffect(() => {
    let alive = true
    void window.api.settings
      .getAll()
      .then((settings) => {
        if (!alive) return
        setEngine(searchEngineOf(settings[SEARCH_ENGINE_SETTING]))
        setSearchSuggest(searchSuggestEnabled(settings[SEARCH_SUGGEST_SETTING]))
        setIgnoreCert(settings[IGNORE_CERT_SETTING] === 'true')
      })
      .catch(() => undefined)
    void window.api.browserData
      .certExceptions()
      .then((hosts) => {
        if (alive) setCertHosts(hosts)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    if (active) loadSiteCount()
  }, [active, loadSiteCount])

  const changeEngine = (value: string): void => {
    if (headless) return
    const next = searchEngineOf(value)
    const before = engine
    setEngine(next)
    // 没存上（这台设备不许改这一项、连接断了）：退回原来的值，不显示一个没生效的选择
    window.api.settings
      .set({ key: SEARCH_ENGINE_SETTING, value: next })
      .catch(() => setEngine(before))
  }
  const toggleSearchSuggest = (): void => {
    if (headless) return
    const next = !searchSuggest
    setSearchSuggest(next)
    window.api.settings
      .set({ key: SEARCH_SUGGEST_SETTING, value: String(next) })
      .catch(() => setSearchSuggest(!next))
  }
  const toggleIgnoreCert = (): void => {
    const next = !ignoreCert
    setIgnoreCert(next)
    window.api.settings
      .set({ key: IGNORE_CERT_SETTING, value: String(next) })
      .catch(() => setIgnoreCert(!next))
  }

  const confirmDelete = (): void => {
    const which = confirming
    setConfirming(null)
    if (which === 'history') {
      void window.api.browserHistory.clear().catch(() => undefined)
    } else if (which === 'all') {
      // 删完重数一遍网站；没删掉就保持原样
      void window.api.browserData.clearAll().then(loadSiteCount, () => undefined)
    }
  }

  return (
    <MobilePage
      kind="browser-settings"
      backLabel={t('browser.manager.title')}
      onBack={onBack}
      title={t('mobile.browserSettings')}
      bodyClassName="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-6 pt-1"
    >
      <section data-mobile-browser-section="search">
        <div className={pageSectionLabel}>{t('browser.settingsPage.search')}</div>
        <div
          className={`${pageCard} ${headless ? 'pointer-events-none select-none opacity-50' : ''}`}
          aria-disabled={headless || undefined}
          // 不只是点不到：键盘也进不去
          inert={headless || undefined}
          data-search-settings-disabled={headless ? 'true' : undefined}
        >
          <label className={`${pageRow} relative`}>
            <span className="min-w-0 flex-1 truncate">{t('settings.toolBrowserSearchEngine')}</span>
            <span data-mobile-browser-engine-name="" className="shrink-0 text-text-tertiary">
              {SEARCH_ENGINES[engine].name}
            </span>
            <ChevronRight size={16} className="shrink-0 text-text-tertiary" aria-hidden="true" />
            {/* 整行就是那个下拉框（透明地盖在行上）：点哪儿都弹出系统的选择器 */}
            <select
              data-mobile-browser-engine=""
              value={engine}
              onChange={(e) => changeEngine(e.target.value)}
              aria-label={t('settings.toolBrowserSearchEngine')}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            >
              {(Object.keys(SEARCH_ENGINES) as SearchEngineId[]).map((id) => (
                <option key={id} value={id}>
                  {SEARCH_ENGINES[id].name}
                </option>
              ))}
            </select>
          </label>
          <div className={pageRow}>
            <span className="min-w-0 flex-1 truncate">
              {t('browser.settingsPage.searchSuggest')}
            </span>
            <span data-mobile-browser-suggest={searchSuggest ? 'on' : 'off'}>
              <BigToggle on={searchSuggest} onClick={toggleSearchSuggest} />
            </span>
          </div>
        </div>
        <p className="px-4 pt-1.5 text-[13px] leading-snug text-text-tertiary">
          {headless ? (
            <span data-headless-search-note="">{t('browser.settingsPage.headlessSearchNote')}</span>
          ) : (
            t('browser.settingsPage.searchSuggestDesc', { engine: SEARCH_ENGINES[engine].name })
          )}
        </p>
      </section>

      <section data-mobile-browser-section="privacy">
        <div className={pageSectionLabel}>{t('browser.settingsPage.privacy')}</div>
        <div className={pageCard}>
          <button
            type="button"
            data-mobile-browser-open-sites=""
            onClick={onOpenSites}
            className={`${pageRow} active:bg-bg-hover`}
          >
            <span className="min-w-0 flex-1 truncate">{t('browser.settingsPage.siteData')}</span>
            {siteCount !== null && (
              <span
                data-mobile-browser-site-count=""
                className="shrink-0 text-[15px] tabular-nums text-text-tertiary"
              >
                {siteCount}
              </span>
            )}
            <ChevronRight size={16} className="shrink-0 text-text-tertiary" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-mobile-browser-clear="history"
            onClick={() => setConfirming('history')}
            className={`${pageRowBase} text-error active:bg-bg-hover`}
          >
            {t('browser.settingsPage.clearHistory')}
          </button>
          <button
            type="button"
            data-mobile-browser-clear="all"
            onClick={() => setConfirming('all')}
            className={`${pageRowBase} text-error active:bg-bg-hover`}
          >
            {t('browser.settingsPage.clearAll')}
          </button>
        </div>
      </section>

      <section data-mobile-browser-section="certificates">
        <div className={pageSectionLabel}>{t('browser.settingsPage.certificates')}</div>
        <div className={pageCard}>
          <div className={pageRow}>
            <span className="min-w-0 flex-1 truncate">
              {t('settings.toolBrowserIgnoreCertificateErrors')}
            </span>
            <span data-mobile-browser-ignore-cert={ignoreCert ? 'on' : 'off'}>
              <BigToggle on={ignoreCert} onClick={toggleIgnoreCert} />
            </span>
          </div>
          {ignoreCert && (
            <div
              data-mobile-browser-cert-warning=""
              className="flex items-start gap-2 bg-amber-500/5 px-4 py-3 text-[13px] leading-snug text-text-secondary"
            >
              <TriangleAlert
                size={16}
                className="mt-0.5 shrink-0 text-amber-500"
                aria-hidden="true"
              />
              {t('settings.toolBrowserSecurityWarning')}
            </div>
          )}
          <div className={`${pageRow} py-2`}>
            <span className="shrink-0">{t('browser.settingsPage.certExceptions')}</span>
            <span
              data-mobile-browser-cert-hosts=""
              className="min-w-0 flex-1 break-all text-right text-[14px] text-text-tertiary"
            >
              {certHosts.length === 0
                ? t('browser.settingsPage.noCertExceptions')
                : certHosts.join(' · ')}
            </span>
          </div>
        </div>
        <p className="px-4 pt-1.5 text-[13px] leading-snug text-text-tertiary">
          {t('browser.settingsPage.certExceptionsDesc')}
        </p>
      </section>

      {confirming && (
        <ConfirmDialog
          title={t(
            confirming === 'history'
              ? 'browser.settingsPage.clearHistory'
              : 'browser.settingsPage.clearAll'
          )}
          description={t(
            confirming === 'history'
              ? 'browser.settingsPage.clearHistoryDesc'
              : 'browser.settingsPage.clearAllDesc'
          )}
          confirmText={t(
            confirming === 'history'
              ? 'browser.settingsPage.clearHistoryConfirm'
              : 'browser.settingsPage.clearAllConfirm'
          )}
          cancelText={t('common.cancel')}
          onConfirm={confirmDelete}
          onCancel={() => setConfirming(null)}
        />
      )}
    </MobilePage>
  )
}

export interface MobileBrowserSitesPageProps {
  /** 这一页此刻在最上面（从某个网站那页退回来时重新取一遍：那里可能删过东西） */
  active: boolean
  onBack: () => void
  onOpenSite: (site: string) => void
}

export function MobileBrowserSitesPage({
  active,
  onBack,
  onOpenSite
}: MobileBrowserSitesPageProps): React.JSX.Element {
  const { t } = useTranslation()
  const [sites, setSites] = useState<SiteSummary[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SiteSort>('name')
  const [menuAnchor, setMenuAnchor] = useState<{ right: number; bottom: number } | null>(null)

  useEffect(() => {
    if (!active) return
    let alive = true
    void window.api.browserData.listSites().then(
      (list) => {
        if (!alive) return
        setSites(list)
        setFailed(false)
      },
      () => {
        // 读不到：列表保持上一次的样子；一次都没读到过就说读不到
        if (alive) setFailed(true)
      }
    )
    return () => {
      alive = false
    }
  }, [active])

  const shown = shownSites(sites ?? [], query, sort)
  const totalBytes = (sites ?? []).reduce((sum, site) => sum + siteBytes(site), 0)
  const menuGroups: PullDownItem[][] = [
    [
      {
        id: 'name',
        label: t('browser.siteData.sortName'),
        icon: <ArrowDownAZ size={18} aria-hidden="true" />,
        disabled: sort === 'name'
      },
      {
        id: 'size',
        label: t('browser.siteData.sortSize'),
        icon: <ArrowDownWideNarrow size={18} aria-hidden="true" />,
        disabled: sort === 'size'
      }
    ]
  ]

  return (
    <MobilePage
      kind="browser-sites"
      backLabel={t('mobile.browserSettings')}
      onBack={onBack}
      title={t('browser.settingsPage.siteData')}
      actions={
        <button
          type="button"
          data-mobile-browser-sites-menu=""
          data-sort={sort}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setMenuAnchor({ right: rect.right, bottom: rect.bottom })
          }}
          aria-label={t('mobile.moreActions')}
          aria-haspopup="menu"
          aria-expanded={menuAnchor !== null}
          className="flex h-10 w-10 items-center justify-center rounded-full text-accent active:bg-bg-hover"
        >
          <CircleEllipsis size={22} aria-hidden="true" />
        </button>
      }
      header={
        <div className="flex flex-shrink-0 items-center px-3 pb-3">
          <label className="flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-[10px] bg-bg-secondary px-2.5 text-text-tertiary">
            <Search size={16} aria-hidden="true" className="shrink-0" />
            <input
              data-mobile-browser-sites-search=""
              type="search"
              enterKeyHint="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('browser.settingsPage.searchSites')}
              aria-label={t('browser.settingsPage.searchSites')}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="min-w-0 flex-1 appearance-none bg-transparent text-[16px] text-text-primary outline-none placeholder:text-text-tertiary [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                data-mobile-browser-sites-search-clear=""
                onClick={() => setQuery('')}
                aria-label={t('mobile.cancel')}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-hover text-text-secondary"
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </label>
        </div>
      }
      toolbar={
        <span data-mobile-browser-sites-total="">
          {sites && sites.length > 0
            ? t('browser.siteData.total', {
                count: sites.length,
                size: formatBytes(totalBytes)
              })
            : ''}
        </span>
      }
    >
      {sites === null ? (
        failed && (
          <p
            data-mobile-browser-sites-empty="error"
            className="px-4 py-10 text-center text-[14px] text-text-tertiary"
          >
            {t('browser.siteData.loadFailed')}
          </p>
        )
      ) : shown.length === 0 ? (
        <p
          data-mobile-browser-sites-empty={sites.length === 0 ? 'none' : 'search'}
          className="px-4 py-10 text-center text-[14px] text-text-tertiary"
        >
          {sites.length === 0
            ? t('settings.toolBrowserNoSites')
            : t('browser.settingsPage.noMatch')}
        </p>
      ) : (
        <div className={pageCard} data-mobile-browser-sites="">
          {shown.map((entry) => (
            <button
              key={entry.site}
              type="button"
              data-mobile-browser-site={entry.site}
              onClick={() => onOpenSite(entry.site)}
              className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2 text-left active:bg-bg-hover"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[16px] text-text-primary">{entry.site}</span>
                <span data-site-meta="" className="block truncate text-[13px] text-text-tertiary">
                  {[
                    formatBytes(siteBytes(entry)),
                    t('browser.settingsPage.cookies', { count: entry.cookieCount })
                  ].join(' · ')}
                </span>
              </span>
              <ChevronRight size={16} className="shrink-0 text-text-tertiary" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      {menuAnchor && (
        <PullDownMenu
          anchor={menuAnchor}
          groups={menuGroups}
          onPick={(id) => {
            if (id === 'name' || id === 'size') setSort(id)
          }}
          onClose={() => setMenuAnchor(null)}
        />
      )}
    </MobilePage>
  )
}

export interface MobileBrowserSitePageProps {
  site: string
  onBack: () => void
}

export function MobileBrowserSitePage({
  site,
  onBack
}: MobileBrowserSitePageProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <MobilePage
      kind="browser-site"
      backLabel={t('browser.settingsPage.siteData')}
      onBack={onBack}
      title={<span className="font-mono">{site}</span>}
    >
      {/* 控件还是那一份，外观换成手机的分组卡片（main.css 里 [data-settings-stacked] 那组规则），字号按这台设备放大 */}
      <div data-settings-stacked="" data-mobile-scale="" data-mobile-browser-site-detail={site}>
        <BrowserSiteDetails site={site} onBack={onBack} embedded />
      </div>
    </MobilePage>
  )
}
