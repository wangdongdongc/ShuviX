import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ChevronDown, ChevronRight, Loader2, Trash2 } from 'lucide-react'
import { SettingsSection, SettingsRow } from '../settings/SettingsPrimitives'
import {
  formatBytes,
  type SiteCookie,
  type SiteDataCategory,
  type SiteDetails
} from '../../../../shared/browserSiteData'

/** 存储那一栏的几类（Cookie 单独一栏） */
const STORAGE_ROWS: Array<{
  category: Exclude<SiteDataCategory, 'cookies'>
  labelKey: string
  size: (d: SiteDetails) => number | null
}> = [
  {
    category: 'localStorage',
    labelKey: 'browser.siteData.cat.localStorage',
    // 本地存储拿不到大小：有就显示「有数据」
    size: (d) => (d.localStorage ? null : 0)
  },
  {
    category: 'indexedDB',
    labelKey: 'browser.siteData.cat.indexedDB',
    size: (d) => d.origins.reduce((n, o) => n + o.usage.indexedDB, 0)
  },
  {
    category: 'cacheStorage',
    labelKey: 'browser.siteData.cat.cacheStorage',
    size: (d) => d.origins.reduce((n, o) => n + o.usage.cacheStorage, 0)
  },
  {
    category: 'serviceWorkers',
    labelKey: 'browser.siteData.cat.serviceWorkers',
    size: (d) => d.origins.reduce((n, o) => n + o.usage.serviceWorkers, 0)
  },
  {
    category: 'other',
    labelKey: 'browser.siteData.cat.other',
    size: (d) => d.origins.reduce((n, o) => n + o.usage.other, 0)
  }
]

const confirmBtn =
  'px-2 py-0.5 text-[11px] text-error hover:bg-error/10 rounded transition-colors disabled:opacity-50 flex items-center gap-1'
const cancelBtn =
  'px-2 py-0.5 text-[11px] text-text-tertiary hover:text-text-secondary rounded transition-colors disabled:opacity-50'
const trashBtn = 'p-1 text-text-tertiary hover:text-error transition-colors'

/**
 * 一个网站的数据（Chrome 的 chrome://settings/content/siteDetails 加上开发者工具里的 Cookie 表）：
 * 占用合计与「删除此网站的所有数据」；按类别的占用与删除；用过存储的各个来源；逐条的 Cookie。
 * 删整个网站、删一类、删一个来源要先确认；删一条 Cookie 直接删。删完重读一遍。
 */
export function BrowserSiteDetails({
  site,
  onBack
}: {
  site: string
  onBack: () => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [details, setDetails] = useState<SiteDetails | null | undefined>(undefined)
  /** 待确认的删除：'site' / 一个类别 / 'origin:<origin>' */
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [openCookie, setOpenCookie] = useState<string | null>(null)

  const load = useCallback(async () => {
    setDetails(await window.api.browserData.siteDetails(site))
  }, [site])

  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.browserData.siteDetails(site).then(
      (d) => {
        if (!cancelled) setDetails(d)
      },
      () => {
        if (!cancelled) setLoadFailed(true)
      }
    )
    return () => {
      cancelled = true
    }
  }, [site])

  const run = async (key: string, op: () => Promise<void>): Promise<void> => {
    setBusy(key)
    try {
      await op()
      await load()
    } catch {
      // 没删掉：不重读，界面保持原样；确认收起，回到垃圾桶，可以再点一次
    } finally {
      setBusy(null)
      setConfirm(null)
    }
  }

  const dateText = (ms: number): string =>
    new Date(ms).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })

  /** 一个「删除」控件：先点垃圾桶，再确认 */
  const confirmable = (
    key: string,
    onConfirm: () => Promise<void>,
    label: string
  ): React.JSX.Element =>
    confirm === key ? (
      <div className="flex items-center gap-1">
        <button
          onClick={() => void run(key, onConfirm)}
          disabled={busy === key}
          className={confirmBtn}
          data-site-data-confirm={key}
        >
          {busy === key && <Loader2 size={10} className="animate-spin" />}
          {t('common.confirm')}
        </button>
        <button onClick={() => setConfirm(null)} disabled={busy === key} className={cancelBtn}>
          {t('common.cancel')}
        </button>
      </div>
    ) : (
      <button
        onClick={() => setConfirm(key)}
        className={trashBtn}
        title={label}
        aria-label={label}
        data-site-data-delete={key}
      >
        <Trash2 size={12} />
      </button>
    )

  const header = (
    <button
      onClick={onBack}
      className="flex items-center gap-1.5 text-[12px] text-text-secondary hover:text-text-primary"
      data-site-details-back
    >
      <ArrowLeft size={14} />
      {t('browser.settingsPage.siteData')}
    </button>
  )

  if (details === undefined && loadFailed) {
    return (
      <div className="space-y-4" data-site-details={site}>
        {header}
        <h2 className="text-[16px] font-medium font-mono">{site}</h2>
        <p className="text-[12px] text-text-tertiary" data-site-details-failed>
          {t('browser.siteData.loadFailed')}
        </p>
      </div>
    )
  }

  if (details === undefined) {
    return (
      <div className="space-y-4" data-site-details={site}>
        {header}
        <div className="flex items-center gap-2 py-6 text-text-tertiary">
          <Loader2 size={12} className="animate-spin" />
          <span className="text-[11px]">{t('common.loading')}</span>
        </div>
      </div>
    )
  }

  if (details === null) {
    return (
      <div className="space-y-4" data-site-details={site}>
        {header}
        <h2 className="text-[16px] font-medium font-mono">{site}</h2>
        <p className="text-[12px] text-text-tertiary" data-site-details-empty>
          {t('browser.siteData.noData')}
        </p>
      </div>
    )
  }

  const total = details.usageBytes + details.cookieBytes
  const storageRows = STORAGE_ROWS.map((row) => ({ ...row, value: row.size(details) })).filter(
    (row) => row.value === null || row.value > 0
  )

  return (
    <div className="space-y-5" data-site-details={site}>
      {header}

      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-[16px] font-medium font-mono truncate">{site}</h2>
          <p className="mt-1 text-[12px] text-text-tertiary">
            {[
              formatBytes(total),
              t('browser.settingsPage.cookies', { count: details.cookieCount }),
              t('browser.siteData.originCount', { count: details.originCount })
            ].join(' · ')}
          </p>
        </div>
        {confirm === 'site' ? (
          <div className="flex items-center gap-1">
            <button
              onClick={() => void run('site', () => window.api.browserData.clearSite(site))}
              disabled={busy === 'site'}
              className={confirmBtn}
              data-site-data-confirm="site"
            >
              {busy === 'site' && <Loader2 size={10} className="animate-spin" />}
              {t('browser.siteData.deleteAllConfirm')}
            </button>
            <button
              onClick={() => setConfirm(null)}
              disabled={busy === 'site'}
              className={cancelBtn}
            >
              {t('common.cancel')}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirm('site')}
            className="flex-shrink-0 px-2.5 py-1 text-[11px] rounded-md border border-border-secondary/60 text-text-secondary hover:text-error hover:border-error/40 transition-colors"
            data-site-data-delete="site"
          >
            {t('browser.siteData.deleteAll')}
          </button>
        )}
      </div>

      {/* ── 按类别 ── */}
      <SettingsSection title={t('browser.siteData.storage')}>
        {storageRows.length === 0 ? (
          <div className="px-4 py-4">
            <p className="text-[11px] text-text-tertiary">{t('browser.siteData.noStorage')}</p>
          </div>
        ) : (
          storageRows.map((row) => (
            <div key={row.category} data-site-category={row.category}>
              <SettingsRow
                title={t(row.labelKey)}
                control={
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-text-tertiary tabular-nums">
                      {row.value === null ? t('browser.siteData.present') : formatBytes(row.value)}
                    </span>
                    {confirmable(
                      row.category,
                      () => window.api.browserData.clearSiteCategory(site, row.category),
                      t('browser.siteData.deleteCategory', { what: t(row.labelKey) })
                    )}
                  </div>
                }
              />
            </div>
          ))
        )}
      </SettingsSection>

      {/* ── 来源 ── */}
      {details.origins.length > 0 && (
        <SettingsSection
          title={t('browser.siteData.origins')}
          description={t('browser.siteData.originsDesc')}
        >
          {details.origins.map((o) => (
            <div key={o.origin} data-site-origin={o.origin}>
              <SettingsRow
                title={<span className="font-mono">{o.origin}</span>}
                subtitle={[
                  formatBytes(o.usageBytes),
                  ...(o.localStorage ? [t('browser.siteData.cat.localStorage')] : []),
                  ...(o.lastAccessed
                    ? [t('browser.siteData.lastUsed', { when: dateText(o.lastAccessed) })]
                    : [])
                ].join(' · ')}
                control={confirmable(
                  `origin:${o.origin}`,
                  () => window.api.browserData.clearOrigin(o.origin),
                  t('browser.siteData.deleteOrigin')
                )}
              />
            </div>
          ))}
        </SettingsSection>
      )}

      {/* ── Cookie ── */}
      <SettingsSection
        title={t('browser.siteData.cookiesTitle', { count: details.cookieCount })}
        headerAction={
          details.cookies.length > 0
            ? confirmable(
                'cookies',
                () => window.api.browserData.clearSiteCategory(site, 'cookies'),
                t('browser.siteData.deleteAllCookies')
              )
            : undefined
        }
      >
        {details.cookies.length === 0 ? (
          <div className="px-4 py-4">
            <p className="text-[11px] text-text-tertiary">{t('browser.siteData.noCookies')}</p>
          </div>
        ) : (
          details.cookies.map((c) => (
            <CookieRow
              key={`${c.domain}|${c.path}|${c.name}`}
              cookie={c}
              open={openCookie === `${c.domain}|${c.path}|${c.name}`}
              onToggle={() =>
                setOpenCookie((cur) =>
                  cur === `${c.domain}|${c.path}|${c.name}`
                    ? null
                    : `${c.domain}|${c.path}|${c.name}`
                )
              }
              onDelete={() =>
                void run(`cookie:${c.domain}|${c.path}|${c.name}`, () =>
                  window.api.browserData.removeCookie({
                    name: c.name,
                    domain: c.domain,
                    path: c.path,
                    secure: c.secure
                  })
                )
              }
              expiresText={c.expires ? dateText(c.expires) : t('browser.siteData.sessionCookie')}
            />
          ))
        )}
      </SettingsSection>
    </div>
  )
}

/** Electron 的 sameSite 取值 → Chrome / 开发者工具里的写法（unspecified 不显示） */
const SAME_SITE_LABELS: Record<string, string> = {
  no_restriction: 'None',
  lax: 'Lax',
  strict: 'Strict'
}

/** Cookie 表的一行：名字、域与路径、过期、大小、标志；点开看值 */
function CookieRow({
  cookie: c,
  open,
  onToggle,
  onDelete,
  expiresText
}: {
  cookie: SiteCookie
  open: boolean
  onToggle: () => void
  onDelete: () => void
  expiresText: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const flags = [
    c.secure ? 'Secure' : '',
    c.httpOnly ? 'HttpOnly' : '',
    c.sameSite && SAME_SITE_LABELS[c.sameSite] ? `SameSite=${SAME_SITE_LABELS[c.sameSite]}` : ''
  ].filter(Boolean)
  return (
    <div
      className="px-4 py-2 border-t border-border-secondary/30 first:border-t-0 text-[11px]"
      data-site-cookie={c.name}
      data-site-cookie-key={`${c.domain}|${c.path}|${c.name}`}
    >
      <div className="flex items-center gap-2">
        <button
          onClick={onToggle}
          className="flex-shrink-0 text-text-tertiary hover:text-text-primary"
          aria-label={open ? t('browser.siteData.hideValue') : t('browser.siteData.showValue')}
          aria-expanded={open}
          data-site-cookie-toggle
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-text-primary" title={c.name}>
          {c.name}
        </span>
        <span className="hidden sm:inline min-w-0 max-w-[30%] truncate font-mono text-text-tertiary">
          {c.domain}
          {c.path}
        </span>
        <span className="flex-shrink-0 w-36 truncate text-text-tertiary" title={expiresText}>
          {expiresText}
        </span>
        <span className="flex-shrink-0 w-12 text-right tabular-nums text-text-tertiary">
          {formatBytes(c.size)}
        </span>
        <button
          onClick={onDelete}
          className={trashBtn}
          title={t('browser.siteData.deleteCookie')}
          aria-label={t('browser.siteData.deleteCookie')}
          data-site-cookie-delete
        >
          <Trash2 size={12} />
        </button>
      </div>
      {open && (
        <div className="mt-1.5 ml-5 space-y-1">
          <p className="font-mono text-text-secondary break-all select-text" data-site-cookie-value>
            {c.value || '""'}
          </p>
          <p className="text-text-tertiary">
            {[`${c.domain}${c.path}`, ...flags, c.hostOnly ? t('browser.siteData.hostOnly') : '']
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
      )}
    </div>
  )
}
