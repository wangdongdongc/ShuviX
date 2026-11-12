/**
 * 收件箱的「跟踪中」一节（T1，2026-11-10 用户选定；`docs/inbox-tracking-status-design.md`）—— 跟踪项从侧栏资料库搬进
 * 收件箱页，摆在最上面（M1），但**不计入侧栏收件箱那一行的数字**：那个数字是「要你处理的」，跟踪项是你自己的清单。
 *
 * - 一行（M1：单行，状态靠图形）：圆圈（点一下归档，底部出「已归档 · 撤销」；在等别人的项是琥珀虚线圈）、标题、
 *   最新一条进展（没有就是结论的第一句）；日期（文件最后修改）只在悬停时出现。点行 = 打开那份 md 的笔记本。
 * - `active` 与 `waiting` 混排，按修改时间倒序；已归档的折在这一节末尾的归档图标 + 数字后面，展开后每行是结论，
 *   悬停出「恢复」。
 * - 行菜单（右键）：归档 / 恢复、标为等待中 / 不再等待、在文件夹中显示、复制路径、删除（先确认）。
 * - 状态写在文件里（frontmatter 的 `status`），这里只调宿主的 `setStatus`；乐观地先挪行，`tracking.changed` 重扫对齐。
 *
 * 宿主不给 adapter（Chrome 侧栏、手机）就没有这一节。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, Check } from 'lucide-react'
import { copyToClipboard, useAppEvent } from '@shuvix/chat-ui'
import type { TrackingItem, TrackingStatus } from '@shuvix/chat-protocol/trackingNotes'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import type { TrackingGroupAdapter } from '../sidebar/TrackingGroup'
import { RowMenuButton } from '../sidebar/RowMenuButton'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { unreadTimeLabel } from './inboxItems'
import { GlyphCell, InboxLine } from './InboxLine'

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

  const heading = (
    <h2 className="group/head mb-0.5 mt-3 flex h-6 items-center gap-2 pl-2 text-[12px] font-medium text-text-tertiary">
      <span className="min-w-0 flex-1 truncate">{t('inbox.trackingSection')}</span>
      <RowMenuButton
        className="opacity-0 group-hover/head:opacity-100 focus-visible:opacity-100"
        onOpen={openHeaderMenu}
      />
    </h2>
  )

  const date = (item: TrackingItem): string => unreadTimeLabel(item.updatedAt, now)

  const liveRow = (item: TrackingItem): React.JSX.Element => (
    <InboxLine
      key={item.fileName}
      attrs={{ 'data-tracking-item': item.fileName, 'data-tracking-status': item.status }}
      onContextMenu={(e) => openRowMenu(item, e)}
      leading={
        // 圆圈就是归档按钮：悬停时圈里出一个勾；在等别人的项是一圈琥珀虚线
        <button
          type="button"
          data-tracking-archive=""
          data-tracking-waiting={item.status === 'waiting' ? '' : undefined}
          aria-label={
            item.status === 'waiting'
              ? `${t('inbox.trackingWaiting')} · ${t('inbox.trackingArchive')}`
              : t('inbox.trackingArchive')
          }
          title={
            item.status === 'waiting'
              ? `${t('inbox.trackingWaiting')} · ${t('inbox.trackingArchive')}`
              : t('inbox.trackingArchive')
          }
          onClick={() => setStatus(item, 'archived')}
          className="group/circle flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          <span
            className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border-[1.5px] text-accent transition-colors group-hover/circle:border-solid group-hover/circle:border-accent ${
              item.status === 'waiting' ? 'border-dashed border-amber-400' : 'border-text-tertiary'
            }`}
          >
            <Check
              size={9}
              strokeWidth={3}
              aria-hidden="true"
              className="opacity-0 transition-opacity group-hover/circle:opacity-100 group-focus-visible/circle:opacity-100"
            />
          </span>
        </button>
      }
      title={<span data-tracking-title="">{item.title}</span>}
      preview={item.latest ? <span data-tracking-latest="">{item.latest}</span> : null}
      hoverMeta={
        <span className="pr-0.5 text-[12px] tabular-nums text-text-tertiary">{date(item)}</span>
      }
      openTitle={item.fileName}
      openAttrs={{ 'data-tracking-open': '' }}
      onOpen={() => void adapter.open(item.fileName, item.title)}
    />
  )

  const archivedRow = (item: TrackingItem): React.JSX.Element => (
    <InboxLine
      key={item.fileName}
      attrs={{ 'data-tracking-item': item.fileName, 'data-tracking-status': 'archived' }}
      onContextMenu={(e) => openRowMenu(item, e)}
      leading={
        <GlyphCell>
          <Archive size={14} aria-hidden="true" className="text-text-tertiary" />
        </GlyphCell>
      }
      title={<span data-tracking-title="">{item.title}</span>}
      titleClassName="text-text-secondary"
      preview={item.conclusion ? <span data-tracking-latest="">{item.conclusion}</span> : null}
      hoverMeta={
        <button
          type="button"
          data-tracking-restore=""
          onClick={() => setStatus(item, 'active')}
          className="rounded-md border border-border-primary bg-bg-primary px-2 py-0.5 text-[12px] text-text-primary transition-colors hover:border-accent/60 hover:text-accent"
        >
          {t('inbox.trackingRestore')}
        </button>
      }
      openTitle={item.fileName}
      openAttrs={{ 'data-tracking-open': '' }}
      onOpen={() => void adapter.open(item.fileName, item.title)}
    />
  )

  return (
    <section data-inbox-section="tracking" aria-label={t('inbox.trackingSection')}>
      {heading}
      <div className="flex flex-col">{live.map(liveRow)}</div>
      {archived.length > 0 && (
        <div className="flex flex-col">
          <button
            type="button"
            data-tracking-archived-toggle=""
            aria-expanded={showArchived}
            aria-label={t('inbox.trackingArchivedCount', { count: archived.length })}
            title={t('inbox.trackingArchivedCount', { count: archived.length })}
            onClick={() => setShowArchived((v) => !v)}
            className={`flex items-center gap-2.5 self-start rounded-md py-1 pl-2 pr-2.5 text-[12px] tabular-nums transition-colors hover:bg-bg-hover/60 hover:text-text-primary ${
              showArchived ? 'text-text-primary' : 'text-text-tertiary'
            }`}
          >
            <GlyphCell>
              <Archive size={13} aria-hidden="true" />
            </GlyphCell>
            {archived.length}
          </button>
          {showArchived && (
            <div className="flex flex-col">
              {archived.slice(0, archivedShown).map(archivedRow)}
              {archived.length > archivedShown && (
                <button
                  type="button"
                  onClick={() => setArchivedShown((n) => n + ARCHIVED_PAGE)}
                  className="self-start rounded-md py-1.5 pl-9 pr-2 text-[12px] text-text-tertiary transition-colors hover:text-text-primary"
                >
                  {t('inbox.trackingShowMore', {
                    count: Math.min(ARCHIVED_PAGE, archived.length - archivedShown)
                  })}
                </button>
              )}
            </div>
          )}
        </div>
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
