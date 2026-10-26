/**
 * 应用日志（监视器 tab 的子页）—— 主进程 main.log 的尾部，只读。
 *
 * 打开时读文件的最后一段（APP_LOG_TAIL_BYTES），解析成一条一条；「跟随」开着时每 FOLLOW_MS 带着游标再读一次，
 * 只取新增的行接在后面（文件轮转了就整个重读）。新的在下面，像终端：停在底部时新行进来跟着滚，往上翻了就不动。
 * 一条消息里换行之后的部分（堆栈）收起来，点开才看。筛选只有级别与文字搜索；更早的内容去文件里看 ——
 * 路径、复制路径、在文件夹中显示（web 客户端没有：文件在跑 ShuviX 的那台电脑上）都在说明行里。
 */
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react'
import {
  RefreshCw,
  ScrollText,
  Copy,
  Check,
  FolderOpen,
  Pause,
  Play,
  Search,
  ChevronRight,
  ChevronDown,
  Loader2
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { copyToClipboard } from '@shuvix/chat-ui'
import { ZenSelect } from '../common/ZenSelect'
import { isWebHost } from '../../host/hostMedia'
import {
  APP_LOG_TAIL_BYTES,
  formatAppLogEntry,
  parseAppLog,
  type AppLogCursor,
  type AppLogEntry
} from '../../../../shared/appLog'

/** 最多留这么多条（再多的从最早的丢） */
export const APP_LOG_MAX_ENTRIES = 2000
/** 跟随时多久读一次新增 */
export const APP_LOG_FOLLOW_MS = 2000

/** 级别的轻重：筛「警告及以上」= 0..1 */
const LEVEL_RANK: Record<string, number> = {
  error: 0,
  warn: 1,
  info: 2,
  verbose: 3,
  debug: 4,
  silly: 5
}

type LevelFilter = '' | 'warn' | 'error'

interface Row extends AppLogEntry {
  id: number
}

/** 离底部这么近就算「停在底部」 */
const STICK_PX = 24

const ICON_BUTTON =
  'inline-flex items-center justify-center w-6 h-6 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors'

export function AppLogSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [rows, setRows] = useState<Row[]>([])
  const [path, setPath] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [missing, setMissing] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [follow, setFollow] = useState(true)
  const [level, setLevel] = useState<LevelFilter>('')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())
  const [copied, setCopied] = useState<'' | 'shown' | 'path'>('')

  const cursorRef = useRef<AppLogCursor | null>(null)
  const nextIdRef = useRef(0)
  /** 在途的读取数；跟随的那一次有读取在途就跳过 */
  const busyRef = useRef(0)
  /** 每次整个重读加一：在途的读取回来时已经不是这一代，结果作废 */
  const genRef = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  /** 读一次：fresh = 不带游标整个重读（打开时、点刷新） */
  const read = useCallback(async (fresh: boolean): Promise<void> => {
    if (!fresh && busyRef.current > 0) return
    const gen = fresh ? ++genRef.current : genRef.current
    busyRef.current++
    if (fresh) setLoading(true)
    try {
      const tail = await window.api.appLog.tail(fresh ? null : cursorRef.current)
      if (gen !== genRef.current) return
      cursorRef.current = tail.fileId ? { fileId: tail.fileId, offset: tail.end } : null
      const parsed = parseAppLog(tail.text)
      const fresher = parsed.entries.map((entry) => ({ ...entry, id: nextIdRef.current++ }))
      setPath(tail.path)
      setError('')
      if (tail.reset) {
        setMissing(!tail.fileId)
        setTruncated(tail.truncated)
        setExpanded(new Set())
        setRows(fresher.slice(-APP_LOG_MAX_ENTRIES))
      } else if (fresher.length > 0 || parsed.orphan.length > 0) {
        setRows((prev) => {
          let base = prev
          // 接着读时开头没有行头的行，是上一次最后那条的续行
          if (parsed.orphan.length > 0 && prev.length > 0) {
            const last = prev[prev.length - 1]
            base = [...prev.slice(0, -1), { ...last, more: [...last.more, ...parsed.orphan] }]
          }
          const all = fresher.length > 0 ? [...base, ...fresher] : base
          return all.length > APP_LOG_MAX_ENTRIES ? all.slice(-APP_LOG_MAX_ENTRIES) : all
        })
      }
    } catch (err) {
      if (gen === genRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      busyRef.current--
      if (gen === genRef.current) {
        setLoaded(true)
        if (fresh) setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void read(true)
  }, [read])

  useEffect(() => {
    if (!follow) return
    const timer = setInterval(() => {
      if (!document.hidden) void read(false)
    }, APP_LOG_FOLLOW_MS)
    return () => clearInterval(timer)
  }, [follow, read])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(''), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const visible = useMemo(() => {
    const max = level === 'error' ? 0 : level === 'warn' ? 1 : Infinity
    const q = query.trim().toLowerCase()
    return rows.filter(
      (row) =>
        (LEVEL_RANK[row.level] ?? LEVEL_RANK.info) <= max &&
        (!q ||
          row.text.toLowerCase().includes(q) ||
          row.scope.toLowerCase().includes(q) ||
          row.more.some((line) => line.toLowerCase().includes(q)))
    )
  }, [rows, level, query])

  // 停在底部时，新行 / 换了筛选之后仍停在底部
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [visible])

  const onScroll = (): void => {
    const el = listRef.current
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
  }

  const toggle = (id: number): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const size = `${Math.round(APP_LOG_TAIL_BYTES / 1024)} KB`

  const body = (): React.JSX.Element => {
    if (error) return <EmptyState text={t('settings.appLog.readFailed', { message: error })} />
    if (!loaded) {
      return (
        <div className="h-full flex items-center justify-center text-text-tertiary">
          <Loader2 size={16} className="animate-spin" />
        </div>
      )
    }
    if (missing) return <EmptyState text={t('settings.appLog.missing')} />
    if (rows.length === 0) return <EmptyState text={t('settings.appLog.empty')} />
    if (visible.length === 0) return <EmptyState text={t('settings.appLog.noMatch')} />
    return (
      <>
        {(truncated || rows.length >= APP_LOG_MAX_ENTRIES) && (
          <div data-app-log-limit className="px-3 py-2 text-center text-[10px] text-text-tertiary">
            {rows.length >= APP_LOG_MAX_ENTRIES
              ? t('settings.appLog.limit', { count: APP_LOG_MAX_ENTRIES })
              : t('settings.appLog.truncated', { size })}
          </div>
        )}
        {visible.map((row) => (
          <LogRow
            key={row.id}
            row={row}
            open={expanded.has(row.id)}
            onToggle={() => toggle(row.id)}
          />
        ))}
      </>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        data-app-log-toolbar
        className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border-secondary"
      >
        <div className="flex-1 min-w-0 max-w-[130px]">
          <ZenSelect
            value={level}
            onChange={(value) => setLevel(value as LevelFilter)}
            placeholder={t('settings.appLog.levelAll')}
            options={[
              { value: 'warn', label: t('settings.appLog.levelWarn') },
              { value: 'error', label: t('settings.appLog.levelError') }
            ]}
          />
        </div>
        <label className="flex-1 min-w-0 max-w-[220px] flex items-center gap-1.5 bg-bg-primary border border-border-secondary/50 rounded-md px-2 py-1 focus-within:border-accent/60 transition-colors">
          <Search size={11} className="shrink-0 text-text-tertiary" />
          <input
            data-app-log-search
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('settings.appLog.search')}
            className="flex-1 min-w-0 bg-transparent outline-none text-[11px] text-text-primary placeholder:text-text-tertiary"
          />
        </label>
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <button
            data-app-log-follow
            aria-pressed={follow}
            onClick={() => setFollow((on) => !on)}
            title={t('settings.appLog.follow')}
            className={`${ICON_BUTTON} ${follow ? 'text-accent' : ''}`}
          >
            {follow ? <Pause size={12} /> : <Play size={12} />}
          </button>
          <button
            data-app-log-refresh
            onClick={() => void read(true)}
            disabled={loading}
            title={t('common.refresh')}
            className={ICON_BUTTON}
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            data-app-log-copy
            onClick={() => {
              copyToClipboard(visible.map(formatAppLogEntry).join('\n'))
              setCopied('shown')
            }}
            disabled={visible.length === 0}
            title={t('settings.appLog.copyShown')}
            className={ICON_BUTTON}
          >
            {copied === 'shown' ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      </div>

      <div
        data-app-log-hint
        className="flex-shrink-0 px-3 py-1.5 border-b border-border-secondary/50 text-[10px] leading-relaxed text-text-tertiary space-y-1"
      >
        <div>{t('settings.appLog.hint')}</div>
        {path && (
          <div className="flex items-start gap-1">
            <code data-app-log-path className="flex-1 min-w-0 break-all font-mono">
              {path}
            </code>
            <button
              data-app-log-copy-path
              onClick={() => {
                copyToClipboard(path)
                setCopied('path')
              }}
              title={t('settings.appLog.copyPath')}
              className={`${ICON_BUTTON} w-5 h-5`}
            >
              {copied === 'path' ? <Check size={11} /> : <Copy size={11} />}
            </button>
            {!isWebHost && (
              <button
                data-app-log-reveal
                onClick={() => void window.api.app.revealPath(path)}
                title={t('settings.appLog.reveal')}
                className={`${ICON_BUTTON} w-5 h-5`}
              >
                <FolderOpen size={11} />
              </button>
            )}
          </div>
        )}
      </div>

      <div ref={listRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto">
        {body()}
      </div>
    </div>
  )
}

/** 一条：时间、级别、标签、正文；后续行（堆栈）收起 */
function LogRow({
  row,
  open,
  onToggle
}: {
  row: Row
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const levelClass =
    row.level === 'error'
      ? 'text-error'
      : row.level === 'warn'
        ? 'text-amber-500'
        : 'text-text-tertiary'
  return (
    <div
      data-app-log-entry
      data-level={row.level}
      className={`px-3 py-1 border-b border-border-secondary/20 font-mono text-[11px] leading-relaxed ${
        row.level === 'error' ? 'bg-error/5' : ''
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="shrink-0 tabular-nums text-text-tertiary" title={row.time}>
          {row.time.slice(5)}
        </span>
        <span className={`shrink-0 w-[5ch] uppercase ${levelClass}`}>{row.level}</span>
        {row.scope && <span className="shrink-0 text-text-secondary">{row.scope}</span>}
        <span
          data-app-log-text
          className="grow basis-64 min-w-0 whitespace-pre-wrap break-all text-text-primary"
        >
          {row.text}
        </span>
      </div>
      {row.more.length > 0 && (
        <>
          <button
            data-app-log-more
            onClick={onToggle}
            className="mt-0.5 inline-flex items-center gap-0.5 font-sans text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
          >
            {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            {t('settings.appLog.moreLines', { count: row.more.length })}
          </button>
          {open && (
            <pre className="mt-0.5 whitespace-pre-wrap break-all text-text-secondary">
              {row.more.join('\n')}
            </pre>
          )}
        </>
      )}
    </div>
  )
}

function EmptyState({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-text-tertiary px-6">
      <ScrollText size={28} className="opacity-40" />
      <span className="text-[11px] text-center">{text}</span>
    </div>
  )
}
