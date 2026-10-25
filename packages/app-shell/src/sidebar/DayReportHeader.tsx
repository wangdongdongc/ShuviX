import { useState } from 'react'
import { FilePlus2, NotebookText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { copyToClipboard } from '@shuvix/chat-ui'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'
import { RowMenuButton } from './RowMenuButton'

export interface DayReportHeaderProps {
  /** 选中的那一天 */
  day: Date
  /** 那天的日报：undefined = 还没查到（先不出动作）；null = 没有；有则带摘录（只有模板时为空串）与文件的绝对路径 */
  report: { excerpt: string; path: string } | null | undefined
  /** 那天能不能写：未来的日子不能（日报记的是已经发生的事），过去的可以补 */
  writable: boolean
  /** 主区开着的正是这份日报 —— 行按选中态画 */
  active?: boolean
  /** 打开那天的日报（还没有就按模板建） */
  onOpen: () => void
  /** 在系统文件管理器里定位那份日报（行菜单里的一项）；宿主不注入则整项不出现 */
  onRevealFile?: (path: string) => void
  /** 删掉那天的日报（行菜单里的一项，确认框由这里弹，确认后才调）；宿主不注入则整项不出现 */
  onDelete?: () => void
}

/**
 * 日历当天列表的头：日期 + 那天的日报。
 *
 * 没有日报时只在日期行尾放一颗「新建」图标（不放文字按钮 —— 日期就是它的说明）；写了就在日期下面多
 * 一行，图标 + 摘录，点开就是那份日报的笔记本。行与侧栏同一套 .sb-row，桌面 / 手机两档密度共用；
 * 摘录至多两行，故是 .sb-row-wrap（图标对齐第一行）。日报行与下面的会话行一样有菜单（右键整行 /
 * 悬停的 ⋮ 是同一份）：在文件夹中显示 / 复制路径 / 删除日报 —— 它是一份文件，会话那套配置 / 导出 / 分支
 * 对它没有意义；删的是文件本身（连同它的笔记本会话），所以总要先确认。
 */
export function DayReportHeader({
  day,
  report,
  writable,
  active = false,
  onOpen,
  onRevealFile,
  onDelete
}: DayReportHeaderProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const showContextMenu = useContextMenu()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const openMenu = (path: string, e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [
      ...(onRevealFile ? [{ id: 'reveal', label: t('daily.revealFile') }] : []),
      { id: 'copy-path', label: t('daily.copyPath') }
    ]
    if (onDelete) {
      items.push({ type: 'separator' })
      items.push({ id: 'delete', label: t('daily.delete') })
    }
    void showContextMenu(e, items, (action) => {
      if (action === 'reveal') onRevealFile?.(path)
      if (action === 'copy-path') copyToClipboard(path)
      if (action === 'delete') setConfirmingDelete(true)
    })
  }
  const label = day.toLocaleDateString(i18n.language, {
    month: 'long',
    day: 'numeric',
    weekday: 'short'
  })
  return (
    <div data-day-report-header="" className="pb-1">
      <div className="sb-section" style={{ marginTop: 0 }}>
        <span className="flex-1 min-w-0 truncate">{label}</span>
        {report === null && writable && (
          <button
            type="button"
            data-daily-write=""
            onClick={onOpen}
            title={t('daily.write')}
            aria-label={t('daily.write')}
            className="flex-shrink-0 -mr-1 p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-active"
          >
            <FilePlus2 className="sb-icon" />
          </button>
        )}
      </div>
      {report && (
        <div
          role="button"
          tabIndex={0}
          data-daily-report=""
          onClick={onOpen}
          onContextMenu={(e) => openMenu(report.path, e)}
          onKeyDown={(e) => {
            // 只认行自己的键：焦点在行里的 ⋮ 上时，回车是开菜单，不是打开日报
            if (e.target !== e.currentTarget) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onOpen()
            }
          }}
          title={t('daily.open')}
          className={`group relative sb-row sb-row-wrap cursor-pointer ${
            active ? 'bg-bg-active/80' : 'hover:bg-bg-hover/60'
          }`}
        >
          <NotebookText className="sb-icon text-success" />
          <span
            className={`sb-label flex-1 min-w-0 line-clamp-2 group-hover:pr-6 ${
              report.excerpt ? 'text-text-secondary' : 'text-text-tertiary'
            }`}
          >
            {report.excerpt || t('daily.empty')}
          </span>
          {/* 与第一行同心（RowMenuButton 高 1rem：12px 图标 + 上下各 2px），而不是整行居中 */}
          <RowMenuButton
            className="absolute right-1.5 top-[calc((var(--sb-row-h)_-_1rem)/2)] opacity-0 group-hover:opacity-100"
            onOpen={(e) => openMenu(report.path, e)}
          />
        </div>
      )}
      {confirmingDelete && onDelete && (
        <ConfirmDialog
          title={t('daily.confirmDeleteTitle')}
          description={t('daily.confirmDeleteDescription', { day: label })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={() => {
            setConfirmingDelete(false)
            onDelete()
          }}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  )
}
