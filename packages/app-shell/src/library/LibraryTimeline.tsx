/**
 * 文件时间线（文件库的第一个界面，docs/file-library-design.md §8；用户裁决 2026-11-18：先在右侧栏做一个简单的
 * 时间线）—— 按天排会话，每条会话下面是它的文件：用户发送的图片、放进笔记的文件、输入框里添加的文件、agent 摆出来
 * 的图、会话的产物。会话已经删掉的文件还在，归进当天的「不属于任何会话」一组。
 *
 * 只读：点会话标题切到那条会话，点文件开预览。分类、标签、删除留给以后的管理页。
 * 数据经 HostApi `library.timeline`（渠道端没有，不渲染内容），`library.changed` 与面板重新可见时重取。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileQuestion, ImageOff, NotebookText, MessageSquare, Search } from 'lucide-react'
import { getHostApi, useAppEvent, useChatStore, useMediaUrl } from '@shuvix/chat-ui'
import {
  groupLibraryTimeline,
  libraryRef,
  type LibraryTimelineEntry,
  type LibraryTimelineGroup,
  type LibraryTimelineResult
} from '@shuvix/chat-protocol/fileLibrary'

export interface LibraryTimelineProps {
  /** 面板此刻可见（常驻挂载的面板据此在重新可见时重取） */
  active?: boolean
  /** 点会话标题：切到那条会话。不给 → 标题不可点 */
  onOpenSession?: (sessionId: string) => void
}

/** 交给 mediaUrl seam 的会话参数（库引用不按会话解析，宿主只要求非空） */
const LIBRARY_MEDIA_SESSION = 'library'
/** 一组里先显示几张图，其余收在「+N」后面 */
const THUMBS_SHOWN = 8

const EMPTY: LibraryTimelineResult = { entries: [], sessions: {} }

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  // 四舍五入到 1024 KB 的进一位写成 MB
  if (Math.round(bytes / 1024) < 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function extOf(fileName: string): string {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(fileName)?.[1]
  return ext ? ext.toUpperCase() : 'FILE'
}

function openFile(itemId: string): void {
  useChatStore.getState().requestFilePreview(libraryRef(itemId))
}

function Thumb({ entry, hint }: { entry: LibraryTimelineEntry; hint: string }): React.JSX.Element {
  const url = useMediaUrl(LIBRARY_MEDIA_SESSION, libraryRef(entry.item.id))
  const [failed, setFailed] = useState(false)
  const broken = entry.missing || failed
  return (
    <button
      type="button"
      data-timeline-file={entry.item.id}
      data-relation={entry.relation ?? ''}
      data-missing={broken ? '' : undefined}
      title={hint}
      aria-label={hint}
      onClick={() => openFile(entry.item.id)}
      className="relative aspect-square overflow-hidden rounded-md bg-bg-tertiary flex items-center justify-center"
    >
      {broken || !url ? (
        <ImageOff size={18} className="text-text-tertiary" aria-hidden="true" />
      ) : (
        <img
          src={url}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </button>
  )
}

function FileRow({
  entry,
  hint,
  meta
}: {
  entry: LibraryTimelineEntry
  hint: string
  meta: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-timeline-file={entry.item.id}
      data-relation={entry.relation ?? ''}
      data-missing={entry.missing ? '' : undefined}
      title={hint}
      onClick={() => openFile(entry.item.id)}
      className="flex h-7 w-full items-center gap-2 rounded-md bg-bg-secondary px-2 text-left text-xs hover:bg-bg-hover"
    >
      {entry.missing ? (
        <FileQuestion size={13} className="flex-shrink-0 text-text-tertiary" aria-hidden="true" />
      ) : (
        <span className="flex-shrink-0 rounded border border-border-primary bg-bg-primary px-1 text-[9px] font-semibold tracking-wide text-text-secondary">
          {extOf(entry.item.fileName)}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-text-primary">{entry.item.name}</span>
      <span className="flex-shrink-0 text-[11px] text-text-tertiary">{meta}</span>
    </button>
  )
}

function Group({
  group,
  result,
  onOpenSession
}: {
  group: LibraryTimelineGroup
  result: LibraryTimelineResult
  onOpenSession?: (sessionId: string) => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const session = group.sessionId ? result.sessions[group.sessionId] : undefined
  const images = group.entries.filter((e) => e.item.kind === 'image')
  const files = group.entries.filter((e) => e.item.kind !== 'image')
  const shown = expanded ? images : images.slice(0, THUMBS_SHOWN)
  const hidden = images.length - shown.length
  const time = new Intl.DateTimeFormat(i18n.language, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(group.at))
  const relationLabel = (entry: LibraryTimelineEntry): string =>
    entry.relation ? t(`library.relation.${entry.relation}`, { defaultValue: '' }) : ''
  const hintOf = (entry: LibraryTimelineEntry): string =>
    [entry.item.name, entry.missing ? t('library.missing') : relationLabel(entry)]
      .filter(Boolean)
      .join(' · ')
  const metaOf = (entry: LibraryTimelineEntry): string =>
    entry.missing
      ? t('library.missing')
      : [relationLabel(entry), sizeLabel(entry.item.size)].filter(Boolean).join(' · ')
  const Icon = session?.notebook ? NotebookText : MessageSquare
  const heading = (
    <>
      <span className="min-w-0 truncate font-semibold text-text-primary">
        {session ? session.title : t('library.noSession')}
      </span>
      {session?.projectName && (
        <span className="min-w-0 flex-shrink truncate text-[11px] text-text-tertiary">
          {session.projectName}
        </span>
      )}
      <span className="ml-auto flex-shrink-0 text-[11px] text-text-tertiary">{time}</span>
    </>
  )
  return (
    <div
      data-timeline-session={group.sessionId ?? ''}
      className="relative flex flex-col gap-1.5 pb-3.5 pl-[22px]"
    >
      <span
        aria-hidden="true"
        className="absolute bottom-0 left-[5px] top-4 w-px bg-border-secondary"
      />
      <span
        aria-hidden="true"
        className={`absolute left-px top-[5px] h-[9px] w-[9px] rounded-full border-2 bg-bg-primary ${
          session ? 'border-accent' : 'border-border-primary'
        }`}
      />
      {session && group.sessionId && onOpenSession ? (
        <button
          type="button"
          data-timeline-open-session={group.sessionId}
          onClick={() => onOpenSession(group.sessionId as string)}
          className="flex w-full items-baseline gap-2 text-left text-[13px] hover:underline"
        >
          <Icon
            size={12}
            className="flex-shrink-0 self-center text-text-tertiary"
            aria-hidden="true"
          />
          {heading}
        </button>
      ) : (
        <div className="flex w-full items-baseline gap-2 text-[13px]">{heading}</div>
      )}
      {shown.length > 0 && (
        <div className="grid grid-cols-4 gap-1.5">
          {shown.map((entry) => (
            <Thumb key={entry.item.id} entry={entry} hint={hintOf(entry)} />
          ))}
          {hidden > 0 && (
            <button
              type="button"
              data-timeline-more
              onClick={() => setExpanded(true)}
              className="aspect-square rounded-md bg-bg-tertiary text-xs font-medium text-text-secondary hover:bg-bg-hover"
            >
              +{hidden}
            </button>
          )}
        </div>
      )}
      {files.map((entry) => (
        <FileRow key={entry.item.id} entry={entry} hint={hintOf(entry)} meta={metaOf(entry)} />
      ))}
    </div>
  )
}

export function LibraryTimeline({
  active = true,
  onOpenSession
}: LibraryTimelineProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [result, setResult] = useState<LibraryTimelineResult | null>(null)
  const [query, setQuery] = useState('')
  const requestSeq = useRef(0)

  const reload = useCallback(() => {
    // 渠道端没有 library：当作空的时间线（统一走 then，不在 effect 里同步 setState）
    const library = getHostApi()?.library
    // 只认最后一次请求的答复：先发的晚到，不该盖掉后发的
    const seq = ++requestSeq.current
    Promise.resolve(library ? library.timeline() : EMPTY).then(
      (r) => {
        if (seq === requestSeq.current) setResult(r)
      },
      () => {
        if (seq === requestSeq.current) setResult((prev) => prev ?? EMPTY)
      }
    )
  }, [])

  useEffect(() => {
    if (active) reload()
  }, [active, reload])
  useAppEvent('library.changed', () => {
    if (active) reload()
  })

  const days = useMemo(() => groupLibraryTimeline(result ?? EMPTY, query), [result, query])
  const fileCount = useMemo(
    () => new Set((result?.entries ?? []).map((e) => e.item.id)).size,
    [result]
  )

  const dayLabel = (day: string): string => {
    const [y, m, d] = day.split('-').map(Number)
    const date = new Date(y, m - 1, d)
    const today = new Date()
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    const diff = Math.round((start - date.getTime()) / 86_400_000)
    if (diff === 0) return t('library.today')
    if (diff === 1) return t('library.yesterday')
    return new Intl.DateTimeFormat(i18n.language, {
      month: 'short',
      day: 'numeric',
      weekday: 'short',
      ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' })
    }).format(date)
  }

  return (
    <div data-library-timeline className="flex h-full flex-col overflow-hidden bg-bg-primary">
      <div className="flex flex-shrink-0 items-center gap-2 px-3 pb-1 pt-2.5">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t('library.search')}</span>
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary"
            aria-hidden="true"
          />
          <input
            data-timeline-search
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('library.search')}
            className="h-7 w-full rounded-md border border-border-primary bg-bg-primary pl-7 pr-2 text-xs text-text-primary outline-none focus:border-accent"
          />
        </label>
        <span data-timeline-count className="flex-shrink-0 text-[11px] text-text-tertiary">
          {t('library.count', { count: fileCount })}
        </span>
      </div>
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {result !== null && days.length === 0 ? (
          <div data-timeline-empty className="px-2 py-10 text-center text-xs text-text-tertiary">
            {query.trim() ? t('library.noMatch') : t('library.empty')}
          </div>
        ) : (
          days.map((day) => (
            <section key={day.day} data-timeline-day={day.day}>
              <h3 className="pb-1.5 pl-[22px] pt-3.5 text-[11px] font-semibold text-text-secondary">
                {dayLabel(day.day)}
              </h3>
              {day.groups.map((group) => (
                <Group
                  key={group.sessionId ?? ''}
                  group={group}
                  result={result ?? EMPTY}
                  onOpenSession={onOpenSession}
                />
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  )
}
