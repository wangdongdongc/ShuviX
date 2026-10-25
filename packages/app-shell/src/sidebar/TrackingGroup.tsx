/**
 * TrackingGroup —— 侧栏 Library 的「跟踪项」分组（实验，`~/.shuvix/tracking/`）。跟踪项是需要持续跟进、跨好几天才
 * 有结论的事，一项一个 md，由 bot（内置的日报 bot）从会话里整理出来并全权维护；这里只列出来、点开看。
 *
 * 点一行 = 打开或复用那份 md 的**笔记本会话**（隐藏项目 `__tracking__`），与 Bots、Hooks、知识库条目同一条路：
 * live-preview、自动保存、外部改动合并 —— bot 正改着的时候开着也不丢字。行的文字是正文第一个一级标题，按修改时间
 * 倒序。没有新建入口：让 bot 记，或在目录里自己放一份 md。行菜单（右键整行 / 悬停的 ⋮，手机上长按）与日历里的日报行
 * 同形：在文件夹中显示 / 复制路径 / 删除跟踪项 —— 删的是文件本身（连同它的笔记本会话），所以总要先确认。
 *
 * prop 驱动、不触宿主 API（同 BotGroup）。扫描是懒的：**首次展开才扫**，之后每次展开 + 窗口聚焦 +
 * `tracking.changed`（笔记本写入、bot 一次触发运行结束）重扫，stale-guard 防乱序回包。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText } from 'lucide-react'
import { copyToClipboard, useAppEvent, useChatStore } from '@shuvix/chat-ui'
import { TRACKING_PROJECT_ID, type TrackingItem } from '@shuvix/chat-protocol/trackingNotes'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import { SessionGroup } from './SessionGroup'
import { RowMenuButton } from './RowMenuButton'
import { useFocusDim } from './useFocusDim'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'
import { ConfirmDialog } from '../common/ConfirmDialog'

/** 宿主注入的跟踪项能力（桌面：window.api.tracking 的窄投影） */
export interface TrackingGroupAdapter {
  /** 拉取清单（须为稳定引用，避免重复扫描） */
  list: () => Promise<TrackingItem[]>
  /** 打开 / 复用这份文件的笔记本会话（宿主负责建会话、刷新列表并选中）；title 只在新建会话时用 */
  open: (fileName: string, title?: string) => void | Promise<void>
  /** 打开跟踪项目录（OS 文件管理器） */
  openFolder: () => void | Promise<unknown>
  /** 在系统文件管理器里定位那份文件（行菜单里的一项）；宿主不注入则整项不出现 */
  revealFile?: (path: string) => void
  /** 删掉那份跟踪项（行菜单里的一项，确认框由这里弹，确认后才调）；宿主不注入则整项不出现 */
  remove?: (fileName: string) => void | Promise<void>
}

export interface TrackingGroupProps {
  adapter: TrackingGroupAdapter
}

export function TrackingGroup({ adapter }: TrackingGroupProps): React.JSX.Element {
  const { t } = useTranslation()
  const { dim } = useFocusDim()
  const showContextMenu = useContextMenu()
  // 活动会话是不是某份跟踪项的笔记本（分组头高亮 + 命中行选中态）
  const activeFileName = useChatStore((s) => {
    const active = s.sessions.find((x) => x.id === s.activeSessionId)
    if (active?.projectId !== TRACKING_PROJECT_ID) return null
    return active.settings.notebookPath ?? null
  })
  const isNoteActive = activeFileName !== null

  const [collapsed, setCollapsed] = useState(true)
  const [items, setItems] = useState<TrackingItem[] | null>(null)
  /** 正在确认删除的那一项 */
  const [confirmingDelete, setConfirmingDelete] = useState<TrackingItem | null>(null)
  const scannedOnce = useRef(false)
  const scanSeq = useRef(0)

  const scan = useCallback(async (): Promise<void> => {
    scannedOnce.current = true
    const seq = ++scanSeq.current
    try {
      const r = await adapter.list()
      if (seq === scanSeq.current) setItems(r)
    } catch {
      if (seq === scanSeq.current) setItems([])
    }
  }, [adapter])

  useEffect(() => {
    const onFocus = (): void => {
      if (scannedOnce.current) void scan()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [scan])

  useAppEvent('tracking.changed', () => {
    if (scannedOnce.current) void scan()
  })

  const toggle = (): void => {
    const next = !collapsed
    setCollapsed(next)
    if (!next) void scan()
  }

  const openGroupMenu = (e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [
      { id: 'open-folder', label: t('sidebar.trackingOpenFolder') },
      { type: 'separator' },
      { id: 'refresh', label: t('panel.filesRefresh') }
    ]
    void showContextMenu(e, items, (action) => {
      if (action === 'open-folder') void adapter.openFolder()
      if (action === 'refresh') void scan()
    })
  }

  const openRowMenu = (item: TrackingItem, e: React.MouseEvent): void => {
    const menu: ContextMenuItem[] = [
      ...(adapter.revealFile ? [{ id: 'reveal', label: t('sidebar.trackingRevealFile') }] : []),
      { id: 'copy-path', label: t('sidebar.trackingCopyPath') }
    ]
    if (adapter.remove) {
      menu.push({ type: 'separator' })
      menu.push({ id: 'delete', label: t('sidebar.trackingDelete') })
    }
    void showContextMenu(e, menu, (action) => {
      if (action === 'reveal') adapter.revealFile?.(item.path)
      if (action === 'copy-path') copyToClipboard(item.path)
      if (action === 'delete') setConfirmingDelete(item)
    })
  }

  const rowClass = (active: boolean): string =>
    `group relative sb-row cursor-pointer transition-opacity duration-200 ${
      active
        ? 'bg-bg-active/80 text-text-primary'
        : `text-text-primary hover:bg-bg-hover/60 ${
            dim && isNoteActive ? 'opacity-30 hover:opacity-100' : ''
          }`
    }`

  return (
    <SessionGroup
      label={t('sidebar.trackingGroup')}
      variant="tracking"
      experimental="tracking"
      collapsed={collapsed}
      onToggle={toggle}
      active={isNoteActive}
      dim={dim && !isNoteActive}
      onMenu={openGroupMenu}
    >
      {items !== null &&
        (items.length === 0 ? (
          <div className="sb-hint">{t('sidebar.trackingEmpty')}</div>
        ) : (
          items.map((item) => (
            <div
              key={item.fileName}
              data-tracking-row={item.fileName}
              onClick={() => void adapter.open(item.fileName, item.title)}
              onContextMenu={(e) => openRowMenu(item, e)}
              title={item.fileName}
              className={rowClass(activeFileName === item.fileName)}
            >
              <span className="sb-icon">
                <FileText size={12} className="text-text-tertiary" />
              </span>
              <span className="flex-1 min-w-0 truncate group-hover:pr-5">{item.title}</span>
              <RowMenuButton
                className="absolute right-1.5 opacity-0 group-hover:opacity-100"
                onOpen={(e) => openRowMenu(item, e)}
              />
            </div>
          ))
        ))}
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
            // 删不掉（权限之类）：行还在，用户看得见没删成 —— 失败不该成为一条没人接的 rejection
            void Promise.resolve(adapter.remove?.(target.fileName)).catch(() => undefined)
          }}
          onCancel={() => setConfirmingDelete(null)}
        />
      )}
    </SessionGroup>
  )
}
