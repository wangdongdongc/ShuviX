/**
 * 文件时间线（文件库的第一个界面，docs/file-library-design.md §8）—— 右侧栏里按天排的一张文件列表：用户发送的图片、
 * 放进笔记的文件、输入框里添加的文件、agent 摆出来的图、会话的产物。
 *
 * 样子（用户裁决 2026-11-23，样稿 3，去掉搜索那一行）：不按会话分组，一件文件一行 —— 小图（或文件图标）、名字，
 * 第二行灰字是所属会话与大小，右端是时刻。没有搜索框、没有文件计数、没有会话标题行。同一件文件当天出现在两条会话里
 * 就是两行。会话已经删掉的文件还在，第二行只有大小。
 *
 * 只读：点一行开预览（图片进看图层，同一天的图是一组），点第二行里的会话名切到那条会话。分类、标签、删除留给以后的
 * 管理页。数据经 HostApi `library.timeline`（渠道端没有，不渲染内容），`library.changed` 与面板重新可见时重取。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { File as FileIcon, FileQuestion, ImageOff } from 'lucide-react'
import {
  getHostApi,
  openImageViewer,
  useAppEvent,
  useChatStore,
  useMediaUrl,
  type ViewerImage
} from '@shuvix/chat-ui'
import {
  groupLibraryTimeline,
  libraryRef,
  type LibraryTimelineEntry,
  type LibraryTimelineResult
} from '@shuvix/chat-protocol/fileLibrary'

export interface LibraryTimelineProps {
  /** 面板此刻可见（常驻挂载的面板据此在重新可见时重取） */
  active?: boolean
  /** 点一行里的会话名：切到那条会话。不给 → 会话名只是文字 */
  onOpenSession?: (sessionId: string) => void
  /**
   * 专注模式（宿主经 useFocusDim 判定后传当前选中的会话；不淡时不传）：日期标题和别的会话的行都淡，
   * 这条会话自己的行照常；悬浮 / 键盘焦点在上面时恢复。缺省不淡
   */
  focusSessionId?: string | null
}

const FADED = 'opacity-30 hover:opacity-100 focus-within:opacity-100'

/** 交给 mediaUrl seam 的会话参数（库引用不按会话解析，宿主只要求非空） */
const LIBRARY_MEDIA_SESSION = 'library'
const EMPTY: LibraryTimelineResult = { entries: [], sessions: {} }

/** 一行左端小图（或文件图标）的边长（CSS px） */
export const TIMELINE_THUMB_PX = 32

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  // 四舍五入到 1024 KB 的进一位写成 MB
  if (Math.round(bytes / 1024) < 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function openFile(itemId: string): void {
  useChatStore.getState().requestFilePreview(libraryRef(itemId))
}

/** 一天里的图 → 看图层的一组（文件库的引用不按会话解析） */
function viewerImagesOf(entries: LibraryTimelineEntry[]): ViewerImage[] {
  return entries.map((e) => ({
    sessionId: LIBRARY_MEDIA_SESSION,
    path: libraryRef(e.item.id),
    mimeType: e.item.mime,
    name: e.item.name,
    openPath: libraryRef(e.item.id)
  }))
}

function Lead({
  entry,
  broken,
  onFail
}: {
  entry: LibraryTimelineEntry
  broken: boolean
  onFail: () => void
}): React.JSX.Element {
  const isImage = entry.item.kind === 'image'
  const url = useMediaUrl(LIBRARY_MEDIA_SESSION, libraryRef(entry.item.id))
  const Icon = entry.missing ? FileQuestion : isImage ? ImageOff : FileIcon
  return (
    <span
      style={{ width: TIMELINE_THUMB_PX, height: TIMELINE_THUMB_PX }}
      className="pointer-events-none relative flex flex-shrink-0 items-center justify-center overflow-hidden rounded-[5px] bg-bg-tertiary text-text-tertiary"
    >
      {isImage && !broken && url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          draggable={false}
          onError={onFail}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <Icon size={16} aria-hidden="true" />
      )}
    </span>
  )
}

function Row({
  entry,
  result,
  dim,
  onOpen,
  onOpenSession
}: {
  entry: LibraryTimelineEntry
  result: LibraryTimelineResult
  dim: boolean
  onOpen: () => void
  onOpenSession?: (sessionId: string) => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [failed, setFailed] = useState(false)
  const session = entry.sessionId ? result.sessions[entry.sessionId] : undefined
  const sessionId = session ? (entry.sessionId as string) : ''
  const broken = !!entry.missing || failed
  const relation = entry.relation
    ? t(`library.relation.${entry.relation}`, { defaultValue: '' })
    : ''
  const hint = [entry.item.name, entry.missing ? t('library.missing') : relation]
    .filter(Boolean)
    .join(' · ')
  const time = new Intl.DateTimeFormat(i18n.language, {
    hour: '2-digit',
    minute: '2-digit',
    // 一律 24 小时制（用户裁决 2026-11-23）：英文界面否则是 "09:05 AM"，比别的语言宽一截
    hourCycle: 'h23'
  }).format(new Date(entry.at))
  return (
    <div
      data-timeline-row=""
      data-session={sessionId}
      className={`relative flex h-[42px] items-center gap-2 rounded-md px-1.5 hover:bg-bg-hover transition-opacity duration-200 ${
        dim ? FADED : ''
      }`}
    >
      <button
        type="button"
        data-timeline-file={entry.item.id}
        data-relation={entry.relation ?? ''}
        data-missing={broken ? '' : undefined}
        title={hint}
        aria-label={hint}
        onClick={onOpen}
        className="absolute inset-0 rounded-md"
      />
      <Lead entry={entry} broken={broken} onFail={() => setFailed(true)} />
      <span className="pointer-events-none relative flex min-w-0 flex-1 flex-col">
        <span data-timeline-name className="truncate text-[13px] text-text-primary">
          {entry.item.name}
        </span>
        <span className="flex min-w-0 items-baseline gap-1 text-[11px] text-text-tertiary">
          {session &&
            (onOpenSession ? (
              <button
                type="button"
                data-timeline-open-session={sessionId}
                onClick={() => onOpenSession(sessionId)}
                className="pointer-events-auto min-w-0 truncate hover:text-text-secondary hover:underline"
              >
                {session.title}
              </button>
            ) : (
              <span data-timeline-session-name className="min-w-0 truncate">
                {session.title}
              </span>
            ))}
          {session && <span aria-hidden="true">·</span>}
          <span data-timeline-meta className="flex-shrink-0">
            {entry.missing ? t('library.missing') : sizeLabel(entry.item.size)}
          </span>
        </span>
      </span>
      <span
        data-timeline-time
        className="pointer-events-none relative flex-shrink-0 text-[11px] text-text-tertiary"
      >
        {time}
      </span>
    </div>
  )
}

export function LibraryTimeline({
  active = true,
  onOpenSession,
  focusSessionId = null
}: LibraryTimelineProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [result, setResult] = useState<LibraryTimelineResult | null>(null)
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

  // 天 → 行：分组函数管去重与「会话已删」的归并，这里把一天里各组的条目摊平，新的在前
  const days = useMemo(
    () =>
      groupLibraryTimeline(result ?? EMPTY).map((day) => ({
        day: day.day,
        rows: day.groups.flatMap((g) => g.entries).sort((a, b) => b.at - a.at)
      })),
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
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {result !== null && days.length === 0 ? (
          <div data-timeline-empty className="px-2 py-10 text-center text-xs text-text-tertiary">
            {t('library.empty')}
          </div>
        ) : (
          days.map((day) => {
            const images = day.rows.filter((e) => e.item.kind === 'image' && !e.missing)
            const unique = images.filter(
              (e, i) => images.findIndex((x) => x.item.id === e.item.id) === i
            )
            return (
              <section key={day.day} data-timeline-day={day.day}>
                <h3
                  className={`px-1.5 pb-1 pt-4 text-[11px] font-semibold text-text-secondary transition-opacity duration-200 ${
                    focusSessionId ? FADED : ''
                  }`}
                >
                  {dayLabel(day.day)}
                </h3>
                {day.rows.map((entry) => (
                  <Row
                    key={`${entry.sessionId ?? ''}\u0000${entry.item.id}`}
                    entry={entry}
                    result={result ?? EMPTY}
                    dim={!!focusSessionId && entry.sessionId !== focusSessionId}
                    onOpenSession={onOpenSession}
                    onOpen={() => {
                      // 不是图、或不在了：照旧走打开（不在的给出「文件不存在」的提示）
                      const index = unique.findIndex((e) => e.item.id === entry.item.id)
                      if (index < 0) openFile(entry.item.id)
                      else openImageViewer(viewerImagesOf(unique), index)
                    }}
                  />
                ))}
              </section>
            )
          })
        )}
      </div>
    </div>
  )
}
