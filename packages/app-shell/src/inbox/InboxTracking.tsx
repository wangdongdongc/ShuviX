/**
 * 收件箱的「跟踪中」一节（T1，2026-11-10 用户选定；`docs/inbox-tracking-status-design.md`）—— 跟踪项从侧栏资料库搬进
 * 收件箱页，与「等你回答 / 新回复 / 运行中」同一页，但**不计入侧栏收件箱那一行的数字**：那个数字是「要你处理的」，
 * 跟踪项是你自己的清单。
 *
 * - 一行：圆圈（点一下归档，底部出「已归档 · 撤销」）、标题、`waiting` 的琥珀「等待中」标签、日期（文件最后修改）、
 *   下面一行灰字是最新一条进展（没有就是结论的第一句）。点行 = 打开那份 md 的笔记本（与侧栏原来那一组同一条路）。
 * - `active` 与 `waiting` 混排，按修改时间倒序；「已归档 N」在这一节末尾折着，展开后每行带结论与「恢复」。
 * - 行菜单（右键）：归档 / 恢复、标为等待中 / 不再等待、在文件夹中显示、复制路径、删除（先确认）。
 * - 状态写在文件里（frontmatter 的 `status`），这里只调宿主的 `setStatus`；乐观地先挪行，`tracking.changed` 重扫对齐。
 *
 * 宿主不给 adapter（Chrome 侧栏、手机）就没有这一节。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, Check, ChevronRight } from 'lucide-react'
import { copyToClipboard, useAppEvent } from '@shuvix/chat-ui'
import type { TrackingItem, TrackingStatus } from '@shuvix/chat-protocol/trackingNotes'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import type { TrackingGroupAdapter } from '../sidebar/TrackingGroup'
import { RowMenuButton } from '../sidebar/RowMenuButton'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { unreadTimeLabel } from './inboxItems'

/** 宿主注入的跟踪项能力：侧栏那一组的全部，加上改状态 */
export interface InboxTrackingAdapter extends TrackingGroupAdapter {
  /** 改一项的状态（只改 frontmatter 的 `status` 一行，宿主提交并广播 `tracking.changed`） */
  setStatus: (fileName: string, status: TrackingStatus) => Promise<unknown>
}

/** 已归档展开后一次多显示几项 */
const ARCHIVED_PAGE = 20

/**
 * 跟踪项清单：打开即扫，之后窗口聚焦与 `tracking.changed` 重扫（stale-guard 防乱序回包）。`patch` 让界面先挪行
 * （归档、撤销），重扫回来再以文件为准
 */
export function useTrackingItems(adapter: InboxTrackingAdapter | undefined): {
  items: TrackingItem[] | null
  patch: (fileName: string, status: TrackingStatus) => void
  rescan: () => void
} {
  const [items, setItems] = useState<TrackingItem[] | null>(null)
  const seq = useRef(0)
  // setState 只在回包的回调里（不在 effect 体里同步调）
  const scan = useCallback((): void => {
    if (!adapter) return
    const mine = ++seq.current
    adapter.list().then(
      (r) => {
        if (mine === seq.current) setItems(r)
      },
      () => {
        if (mine === seq.current) setItems((prev) => prev ?? [])
      }
    )
  }, [adapter])
  useEffect(() => {
    void scan()
    const onFocus = (): void => void scan()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [scan])
  useAppEvent('tracking.changed', () => void scan())
  const patch = useCallback((fileName: string, status: TrackingStatus) => {
    // 正在路上的扫描回包作废：它读的是改之前的文件
    seq.current++
    setItems((prev) => prev?.map((x) => (x.fileName === fileName ? { ...x, status } : x)) ?? prev)
  }, [])
  return { items, patch, rescan: () => void scan() }
}

export interface InboxTrackingSectionProps {
  adapter: InboxTrackingAdapter
  items: TrackingItem[]
  /** 打开收件箱那一刻（日期标签分今天 / 更早） */
  now: number
  /** 列表页的大节标题，还是逐张处理里的小标题 */
  variant: 'list' | 'triage'
  /** 先挪行（useTrackingItems 的 patch） */
  patch: (fileName: string, status: TrackingStatus) => void
  rescan: () => void
  /** 归档了一项（收件箱页据此弹「已归档 · 撤销」） */
  onArchived: (item: TrackingItem, previous: TrackingStatus) => void
}

export function InboxTrackingSection({
  adapter,
  items,
  now,
  variant,
  patch,
  rescan,
  onArchived
}: InboxTrackingSectionProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const showContextMenu = useContextMenu()
  const [showArchived, setShowArchived] = useState(false)
  const [archivedShown, setArchivedShown] = useState(ARCHIVED_PAGE)
  const [confirmingDelete, setConfirmingDelete] = useState<TrackingItem | null>(null)

  const live = items.filter((x) => x.status !== 'archived')
  const archived = items.filter((x) => x.status === 'archived')
  if (live.length === 0 && archived.length === 0) return null

  const setStatus = (item: TrackingItem, status: TrackingStatus): void => {
    if (item.status === status) return
    patch(item.fileName, status)
    // 写不进去（文件刚被删、权限）：重扫，把行放回文件里的样子
    void adapter.setStatus(item.fileName, status).catch(rescan)
    if (status === 'archived') onArchived(item, item.status)
  }

  const openRowMenu = (item: TrackingItem, e: React.MouseEvent): void => {
    const menu: ContextMenuItem[] =
      item.status === 'archived'
        ? [{ id: 'restore', label: t('inbox.trackingRestore') }]
        : [
            { id: 'archive', label: t('inbox.trackingArchive') },
            item.status === 'waiting'
              ? { id: 'active', label: t('inbox.trackingMarkActive') }
              : { id: 'waiting', label: t('inbox.trackingMarkWaiting') }
          ]
    menu.push({ type: 'separator' })
    if (adapter.revealFile) menu.push({ id: 'reveal', label: t('sidebar.trackingRevealFile') })
    menu.push({ id: 'copy-path', label: t('sidebar.trackingCopyPath') })
    if (adapter.remove) {
      menu.push({ type: 'separator' })
      menu.push({ id: 'delete', label: t('sidebar.trackingDelete') })
    }
    void showContextMenu(e, menu, (action) => {
      if (action === 'archive') setStatus(item, 'archived')
      if (action === 'restore' || action === 'active') setStatus(item, 'active')
      if (action === 'waiting') setStatus(item, 'waiting')
      if (action === 'reveal') adapter.revealFile?.(item.path)
      if (action === 'copy-path') copyToClipboard(item.path)
      if (action === 'delete') setConfirmingDelete(item)
    })
  }

  const openHeaderMenu = (e: React.MouseEvent): void => {
    const menu: ContextMenuItem[] = [
      { id: 'open-folder', label: t('sidebar.trackingOpenFolder') },
      { type: 'separator' },
      { id: 'refresh', label: t('panel.filesRefresh') }
    ]
    void showContextMenu(e, menu, (action) => {
      if (action === 'open-folder') void adapter.openFolder()
      if (action === 'refresh') rescan()
    })
  }

  const heading =
    variant === 'list' ? (
      <h2 className="group/head mb-1 mt-7 flex items-baseline gap-2 border-b border-border-secondary pb-1.5 text-[13px] font-semibold text-text-primary">
        {t('inbox.trackingSection')}
        <span className="min-w-0 flex-1 truncate text-[12px] font-normal text-text-secondary">
          {t('inbox.trackingHint')}
        </span>
        <RowMenuButton
          className="self-center opacity-0 group-hover/head:opacity-100 focus-visible:opacity-100"
          onOpen={openHeaderMenu}
        />
      </h2>
    ) : (
      <div className="group/head mb-1 mt-6 flex items-center gap-2 px-0.5 text-[12px] font-semibold text-text-secondary">
        <span className="min-w-0 flex-1 truncate">{t('inbox.trackingSection')}</span>
        <RowMenuButton
          className="opacity-0 group-hover/head:opacity-100 focus-visible:opacity-100"
          onOpen={openHeaderMenu}
        />
      </div>
    )

  const liveRow = (item: TrackingItem): React.JSX.Element => (
    <div
      key={item.fileName}
      data-tracking-item={item.fileName}
      data-tracking-status={item.status}
      onContextMenu={(e) => openRowMenu(item, e)}
      className="group flex items-start gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-bg-hover/60"
    >
      <button
        type="button"
        data-tracking-archive=""
        aria-label={t('inbox.trackingArchive')}
        title={t('inbox.trackingArchive')}
        onClick={() => setStatus(item, 'archived')}
        className="group/circle mt-px flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-text-tertiary text-accent transition-colors hover:border-accent focus-visible:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <Check
          size={10}
          strokeWidth={3}
          aria-hidden="true"
          className="opacity-0 transition-opacity group-hover/circle:opacity-100 group-focus-visible/circle:opacity-100"
        />
      </button>
      <button
        type="button"
        data-tracking-open=""
        onClick={() => void adapter.open(item.fileName, item.title)}
        title={item.fileName}
        className="flex min-w-0 flex-1 flex-col gap-[3px] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className="flex w-full items-center gap-2">
          <span data-tracking-title="" className="min-w-0 truncate text-[14px] text-text-primary">
            {item.title}
          </span>
          {item.status === 'waiting' && (
            <span
              data-tracking-waiting=""
              className="shrink-0 rounded px-1.5 text-[11px] font-medium leading-[18px] bg-amber-500/15 text-amber-700 dark:text-amber-400"
            >
              {t('inbox.trackingWaiting')}
            </span>
          )}
          <span className="flex-1" />
          <span className="shrink-0 text-[12px] text-text-secondary">
            {unreadTimeLabel(item.updatedAt, now)}
          </span>
        </span>
        {item.latest && (
          <span
            data-tracking-latest=""
            className="w-full truncate text-[12.5px] text-text-secondary"
          >
            {item.latest}
          </span>
        )}
      </button>
    </div>
  )

  const archivedRow = (item: TrackingItem): React.JSX.Element => (
    <div
      key={item.fileName}
      data-tracking-item={item.fileName}
      data-tracking-status="archived"
      onContextMenu={(e) => openRowMenu(item, e)}
      className="group flex items-center gap-3 rounded-lg px-2 py-[7px] text-text-secondary transition-colors hover:bg-bg-hover/60"
    >
      <Archive size={15} aria-hidden="true" className="shrink-0 text-text-tertiary" />
      <button
        type="button"
        data-tracking-open=""
        onClick={() => void adapter.open(item.fileName, item.title)}
        title={item.fileName}
        className="min-w-0 flex-1 truncate text-left text-[13.5px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span data-tracking-title="">{item.title}</span>
        {item.conclusion && (
          <span data-tracking-latest="" className="text-[12px]">
            {' · '}
            {t('inbox.trackingConclusion', { text: item.conclusion })}
          </span>
        )}
      </button>
      <span className="shrink-0 text-[12px]">{unreadTimeLabel(item.updatedAt, now)}</span>
      <button
        type="button"
        data-tracking-restore=""
        onClick={() => setStatus(item, 'active')}
        className="shrink-0 rounded-md border border-border-primary px-2 py-0.5 text-[12px] text-text-primary transition-colors hover:border-accent/60 hover:text-accent"
      >
        {t('inbox.trackingRestore')}
      </button>
    </div>
  )

  return (
    <section data-inbox-section="tracking" aria-label={t('inbox.trackingSection')}>
      {heading}
      <div className="flex flex-col">{live.map(liveRow)}</div>
      {archived.length > 0 && (
        <>
          <button
            type="button"
            data-tracking-archived-toggle=""
            aria-expanded={showArchived}
            onClick={() => setShowArchived((v) => !v)}
            className="mt-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover/60 hover:text-text-primary"
          >
            <ChevronRight
              size={12}
              aria-hidden="true"
              className={`transition-transform ${showArchived ? 'rotate-90' : ''}`}
            />
            {t('inbox.trackingArchivedCount', { count: archived.length })}
          </button>
          {showArchived && (
            <div className="flex flex-col">
              {archived.slice(0, archivedShown).map(archivedRow)}
              {archived.length > archivedShown && (
                <button
                  type="button"
                  onClick={() => setArchivedShown((n) => n + ARCHIVED_PAGE)}
                  className="self-start rounded-md py-1.5 pl-[35px] pr-2 text-[12px] text-text-secondary transition-colors hover:text-text-primary"
                >
                  {t('inbox.trackingShowMore', {
                    count: Math.min(ARCHIVED_PAGE, archived.length - archivedShown)
                  })}
                </button>
              )}
            </div>
          )}
        </>
      )}
      {confirmingDelete && adapter.remove && (
        <ConfirmDialog
          title={t('sidebar.trackingConfirmDeleteTitle')}
          description={t('sidebar.trackingConfirmDeleteDescription', {
            title: confirmingDelete.title
          })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={() => {
            const target = confirmingDelete
            setConfirmingDelete(null)
            void Promise.resolve(adapter.remove?.(target.fileName)).catch(() => undefined)
          }}
          onCancel={() => setConfirmingDelete(null)}
        />
      )}
    </section>
  )
}
