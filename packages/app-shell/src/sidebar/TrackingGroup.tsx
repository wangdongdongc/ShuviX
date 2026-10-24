/**
 * TrackingGroup —— 侧栏 Library 的「跟踪项」分组（实验，`~/.shuvix/tracking/`）。跟踪项是需要持续跟进、跨好几天才
 * 有结论的事，一项一个 md，由 bot（内置的日报 bot）从会话里整理出来并全权维护；这里只列出来、点开看。
 *
 * 点一行 = 打开或复用那份 md 的**笔记本会话**（隐藏项目 `__tracking__`），与 Bots、Hooks、知识库条目同一条路：
 * live-preview、自动保存、外部改动合并 —— bot 正改着的时候开着也不丢字。行的文字是正文第一个一级标题，按修改时间
 * 倒序。没有新建入口：让 bot 记，或在目录里自己放一份 md。
 *
 * prop 驱动、不触宿主 API（同 BotGroup）。扫描是懒的：**首次展开才扫**，之后每次展开 + 窗口聚焦 +
 * `tracking.changed`（笔记本写入、bot 一次触发运行结束）重扫，stale-guard 防乱序回包。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText } from 'lucide-react'
import { useAppEvent, useChatStore } from '@shuvix/chat-ui'
import { TRACKING_PROJECT_ID, type TrackingItem } from '@shuvix/chat-protocol/trackingNotes'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import { SessionGroup } from './SessionGroup'
import { useFocusDim } from './useFocusDim'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'

/** 宿主注入的跟踪项能力（桌面：window.api.tracking 的窄投影） */
export interface TrackingGroupAdapter {
  /** 拉取清单（须为稳定引用，避免重复扫描） */
  list: () => Promise<TrackingItem[]>
  /** 打开 / 复用这份文件的笔记本会话（宿主负责建会话、刷新列表并选中）；title 只在新建会话时用 */
  open: (fileName: string, title?: string) => void | Promise<void>
  /** 打开跟踪项目录（OS 文件管理器） */
  openFolder: () => void | Promise<unknown>
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
              title={item.fileName}
              className={rowClass(activeFileName === item.fileName)}
            >
              <span className="sb-icon">
                <FileText size={12} className="text-text-tertiary" />
              </span>
              <span className="flex-1 min-w-0 truncate">{item.title}</span>
            </div>
          ))
        ))}
    </SessionGroup>
  )
}
