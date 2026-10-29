import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { Globe, Loader2, Search, Trash2, X } from 'lucide-react'
import { useBrowserTabsStore } from '../../stores/browserTabsStore'
import {
  displayUrlOf,
  type HistoryActorFilter,
  type HistoryItem
} from '../../../../shared/browserHistory'
import { sessionDotColor } from './sessionColor'

const PAGE_SIZE = 100
const SEARCH_DEBOUNCE_MS = 200
const FILTERS: Array<{ id: HistoryActorFilter; labelKey: string }> = [
  { id: 'all', labelKey: 'browser.history.filterAll' },
  { id: 'user', labelKey: 'browser.history.filterYou' },
  { id: 'agent', labelKey: 'browser.history.filterAgents' }
]

/** YYYY-MM-DD（本地）→ 那一天 0 点的 Date */
function dayDate(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function localDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 一天的标题：今天 / 昨天带前缀，照 Chrome 的历史记录页 */
function dayLabel(day: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const date = new Intl.DateTimeFormat(i18next.language, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(dayDate(day))
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (day === localDay(today)) return t('browser.history.today', { date })
  if (day === localDay(yesterday)) return t('browser.history.yesterday', { date })
  return date
}

function timeOf(ms: number): string {
  return new Intl.DateTimeFormat(i18next.language, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(ms)
  )
}

/**
 * 历史记录页 —— 内部页面 `shuvix://history`（Chrome 的 chrome://history），⋮ → 历史记录或 ⌘Y / Ctrl+H 打开。
 *
 * 按天分组、新的在上，同一天同一个网址同一个访问者合成一行；搜索框过滤网址与标题，「全部 / 我的 / Agent」
 * 只看谁打开的。agent 打开的那行标出会话（圆点颜色 = 那个会话的颜色），点会话名回到那段对话；这些页面
 * 只在这里，地址栏的建议里没有它们（2026-10-29 用户裁定）。点一行在这个标签页里打开，⌘ / 中键点在新标签页
 * 里开；行尾的 × 删掉那一行，「清除浏览历史」删掉全部。页面是外壳里的 DOM，agent 碰不到。
 */
export function BrowserHistoryPage({
  tabId,
  compact
}: {
  tabId: string
  compact?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const navigateTab = useBrowserTabsStore((s) => s.navigateTab)
  const createTab = useBrowserTabsStore((s) => s.createTab)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [actor, setActor] = useState<HistoryActorFilter>('all')
  const [items, setItems] = useState<HistoryItem[] | null>(null)
  /** 下一页的 cursor，连同它属于哪一次查询（换了搜索 / 过滤之后旧的 cursor 作废） */
  const [next, setNext] = useState<{ cursor: number; gen: number } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  /** 每次换条件加一：晚到的旧结果丢掉 */
  const generation = useRef(0)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // 搜索框停手一会儿再查
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  const load = useCallback(
    async (cursor: number | null, forGen?: number): Promise<void> => {
      const gen = cursor === null ? ++generation.current : (forGen ?? generation.current)
      if (gen !== generation.current) return
      try {
        const page = await window.api.browserHistory.list({
          search,
          actor,
          cursor,
          limit: PAGE_SIZE
        })
        if (gen !== generation.current) return
        setItems((prev) => (cursor === null ? page.items : [...(prev ?? []), ...page.items]))
        setNext(page.next === null ? null : { cursor: page.next, gen })
      } catch {
        if (gen === generation.current && cursor === null) setItems([])
      }
    },
    [search, actor]
  )

  useEffect(() => {
    void load(null)
  }, [load])

  // 滚到底再要下一页
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || next === null) return
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || loadingMore) return
      if (next.gen !== generation.current) return
      setLoadingMore(true)
      void load(next.cursor, next.gen).finally(() => setLoadingMore(false))
    })
    io.observe(el)
    return () => io.disconnect()
  }, [next, load, loadingMore])

  const remove = async (item: HistoryItem): Promise<void> => {
    setItems((prev) => prev?.filter((i) => i.key !== item.key) ?? prev)
    await window.api.browserHistory.remove([item.key]).catch(() => {})
  }

  const clearAll = async (): Promise<void> => {
    setClearing(true)
    try {
      await window.api.browserHistory.clear()
      await load(null)
    } finally {
      setClearing(false)
      setConfirmClear(false)
    }
  }

  const open = (item: HistoryItem, newTab: boolean): void => {
    if (newTab) createTab(item.url)
    else navigateTab(tabId, item.url)
  }

  // 按天分组（列表本来就按时间倒序）
  const groups: Array<{ day: string; items: HistoryItem[] }> = []
  for (const item of items ?? []) {
    const last = groups[groups.length - 1]
    if (last && last.day === item.day) last.items.push(item)
    else groups.push({ day: item.day, items: [item] })
  }

  return (
    <div
      className="absolute inset-0 overflow-y-auto bg-bg-primary text-text-primary"
      data-browser-history-page
    >
      <div
        className={`mx-auto max-w-[760px] ${compact ? 'px-3 py-3 space-y-3' : 'px-6 py-6 space-y-5'}`}
      >
        <div className="flex flex-wrap items-center gap-3">
          {!compact && (
            <h1 className="text-[15px] font-medium mr-auto">{t('browser.history.title')}</h1>
          )}
          <label className="flex items-center gap-1.5 h-8 px-3 rounded-full bg-bg-secondary border border-border-secondary/40 focus-within:border-accent/50 min-w-0 flex-1 max-w-[320px]">
            <Search size={13} className="flex-shrink-0 text-text-tertiary" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('browser.history.search')}
              spellCheck={false}
              className="flex-1 min-w-0 bg-transparent text-[12px] outline-none placeholder:text-text-tertiary"
              data-history-search
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="flex-shrink-0 text-text-tertiary hover:text-text-primary"
                aria-label={t('common.clear')}
              >
                <X size={12} />
              </button>
            )}
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex items-center p-0.5 rounded-full bg-bg-secondary"
            title={t('browser.history.agentHint')}
          >
            {FILTERS.map(({ id, labelKey }) => (
              <button
                key={id}
                onClick={() => setActor(id)}
                aria-pressed={actor === id}
                className={`px-3 py-0.5 rounded-full text-[11px] transition-colors ${
                  actor === id
                    ? 'bg-bg-primary text-text-primary shadow-sm'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
                data-history-filter={id}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1">
            {confirmClear ? (
              <>
                <button
                  onClick={() => void clearAll()}
                  disabled={clearing}
                  className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-error hover:bg-error/10 rounded transition-colors disabled:opacity-50"
                  data-history-clear-confirm
                >
                  {clearing && <Loader2 size={10} className="animate-spin" />}
                  {t('browser.history.clearConfirm')}
                </button>
                <button
                  onClick={() => setConfirmClear(false)}
                  disabled={clearing}
                  className="px-2 py-0.5 text-[11px] text-text-tertiary hover:text-text-secondary rounded transition-colors disabled:opacity-50"
                >
                  {t('common.cancel')}
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmClear(true)}
                disabled={!items?.length && !search && actor === 'all'}
                className="flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-md border border-border-secondary/60 text-text-secondary hover:bg-bg-hover/60 transition-colors disabled:opacity-40"
                data-history-clear
              >
                <Trash2 size={11} />
                {t('browser.history.clear')}
              </button>
            )}
          </div>
        </div>

        {items === null ? (
          <div className="flex justify-center py-10 text-text-tertiary">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : groups.length === 0 ? (
          <p className="py-10 text-center text-[12px] text-text-tertiary" data-history-empty>
            {search || actor !== 'all'
              ? t('browser.history.noResults')
              : t('browser.history.empty')}
          </p>
        ) : (
          groups.map((group) => (
            <section
              key={group.day}
              className="rounded-xl border border-border-secondary/40 overflow-hidden"
              data-history-day={group.day}
            >
              <h2 className="px-4 py-2 text-[12px] font-medium text-text-secondary bg-bg-secondary/50">
                {dayLabel(group.day, t)}
              </h2>
              {group.items.map((item) => (
                <HistoryRow
                  key={item.key}
                  item={item}
                  onOpen={(newTab) => open(item, newTab)}
                  onRemove={() => void remove(item)}
                />
              ))}
            </section>
          ))
        )}
        {next !== null && (
          <div ref={sentinelRef} className="flex justify-center py-3 text-text-tertiary">
            <Loader2 size={14} className="animate-spin" />
          </div>
        )}
      </div>
    </div>
  )
}

function HistoryRow({
  item,
  onOpen,
  onRemove
}: {
  item: HistoryItem
  onOpen: (newTab: boolean) => void
  onRemove: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [iconFailed, setIconFailed] = useState(false)
  const host = (() => {
    try {
      return new URL(item.url).host || displayUrlOf(item.url)
    } catch {
      return item.url
    }
  })()
  return (
    <div
      className="group flex items-center gap-3 h-9 px-4 hover:bg-bg-hover/50 text-[12px]"
      data-history-item={item.key}
      data-history-url={item.url}
      data-history-session={item.sessionId}
    >
      <span className="flex-shrink-0 w-16 whitespace-nowrap tabular-nums text-text-tertiary">
        {timeOf(item.lastAt)}
      </span>
      {item.favicon && !iconFailed ? (
        <img
          src={item.favicon}
          alt=""
          draggable={false}
          className="flex-shrink-0 w-[14px] h-[14px]"
          onError={() => setIconFailed(true)}
        />
      ) : (
        <Globe size={14} className="flex-shrink-0 text-text-tertiary" />
      )}
      <a
        href={item.url}
        onClick={(e) => {
          e.preventDefault()
          onOpen(e.metaKey || e.ctrlKey)
        }}
        onAuxClick={(e) => {
          if (e.button !== 1) return
          e.preventDefault()
          onOpen(true)
        }}
        title={item.url}
        className="min-w-0 truncate text-text-primary hover:underline"
        data-history-open
      >
        {item.title || displayUrlOf(item.url)}
      </a>
      <span className="min-w-0 flex-shrink truncate text-text-tertiary">{host}</span>
      {item.count > 1 && (
        <span
          className="flex-shrink-0 text-[10px] tabular-nums text-text-tertiary"
          title={t('browser.history.visits', { count: item.count })}
        >
          ×{item.count}
        </span>
      )}
      <span className="flex-1" />
      {item.sessionId && (
        <button
          onClick={() => void window.api.browserView.openSession(item.sessionId!)}
          className="flex-shrink-0 flex items-center gap-1.5 max-w-[200px] px-2 py-0.5 rounded-full bg-bg-secondary text-[11px] text-text-secondary hover:text-text-primary"
          title={t('browser.history.openedByAgent', {
            title: item.sessionTitle || t('browser.history.deletedSession')
          })}
          data-history-agent={item.sessionId}
        >
          <span
            className="flex-shrink-0 w-1.5 h-1.5 rounded-full"
            style={{ background: sessionDotColor(item.sessionId) }}
          />
          <span className="truncate">
            {item.sessionTitle || t('browser.history.deletedSession')}
          </span>
        </button>
      )}
      <button
        onClick={onRemove}
        className="flex-shrink-0 p-1 rounded-full text-text-tertiary hover:text-text-primary hover:bg-bg-tertiary invisible group-hover:visible focus:visible"
        title={t('browser.history.remove')}
        aria-label={t('browser.history.remove')}
        data-history-remove
      >
        <X size={12} />
      </button>
    </div>
  )
}
