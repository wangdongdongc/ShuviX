/**
 * BotGroup —— 侧栏置顶的「Bots」特殊分组（原设置页 Bots tab 的列表侧），排在知识库之上。
 * 列 `~/.shuvix/bots/` 里的 bot 档案：合法的一行一个（头像 + 显示名），解析不过的文件缀在
 * 末尾以琥珀行呈现（文件名 + 三角）；点任一行把主区切到 **bot 档案页**
 * （`chatStore.setActiveBot` —— 与会话互斥的主区目标，正文由宿主经 ChatBody 的
 * contentOverride 渲染，桌面是 BotPage）。**没有内置 bot**，故列表里也没有内置/用户之分。
 *
 * prop 驱动、不触宿主 API（同 WikiGroup）：清单 / 打开目录 / 新建会话 / 删除由宿主注入。
 * 行样式对齐 WikiGroup（13px / truncate / bg-bg-active 选中态），组头经 SessionGroup 的
 * bots 形态渲染。扫描是懒的：**首次展开才扫**，之后每次展开 + 窗口聚焦 + `bot.changed`
 * 事件（保存 / 新建 / 删除 / 修好非法文件）重扫，stale-guard 防乱序回包。
 *
 * 动作全部收在菜单里（右键 / ⋮ 同一份，与会话行一致）：组头 = 新建 bot / 打开目录 / 刷新；
 * bot 行 = 新建 Bot 会话 / 删除；非法行 = 删除。删除的确认对话框归宿主 —— 真删掉后
 * `bot.changed` 会让本组重扫，这里不猜结果。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { BotAvatar, selectActiveBot, useAppEvent, useChatStore } from '@shuvix/chat-ui'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import { SessionGroup } from './SessionGroup'
import { RowMenuButton } from './RowMenuButton'
import { useFocusDim } from './useFocusDim'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'
import type { BotPickItem } from './BotSessionDialog'

/** 目录里无法解析的文件（身份是文件名 —— 它解析不出 name） */
export interface BotGroupInvalidFile {
  fileName: string
  /** 解析器的人读拒绝理由（行的 title 提示） */
  error: string
}

/** 宿主注入的 bots 注册表能力（桌面：window.api.bot 的窄投影） */
export interface BotGroupAdapter {
  /** 拉取注册表：合法 bot + 无法解析的文件（须为稳定引用，避免重复扫描） */
  list: () => Promise<{ bots: BotPickItem[]; invalid: BotGroupInvalidFile[] }>
  /** 打开 bots 目录（OS 文件管理器） */
  openFolder: () => void | Promise<unknown>
  /** 以该 bot 为唯一成员新建聊天会话（宿主负责建会话、刷新列表并选中） */
  newSession: (name: string) => void | Promise<void>
  /** 删除 bot（宿主自带确认对话框；删掉后经 `bot.changed` 事件重扫） */
  delete: (name: string) => void
  /** 删除无法解析的文件（同上） */
  deleteFile: (fileName: string) => void
}

export interface BotGroupProps {
  adapter: BotGroupAdapter
}

export function BotGroup({ adapter }: BotGroupProps): React.JSX.Element {
  const { t } = useTranslation()
  const { dim } = useFocusDim()
  const showContextMenu = useContextMenu()
  const activeTarget = useChatStore(selectActiveBot)
  const setActiveBot = useChatStore((s) => s.setActiveBot)
  const isPageActive = activeTarget !== null

  const [collapsed, setCollapsed] = useState(true)
  const [scanned, setScanned] = useState<{
    bots: BotPickItem[]
    invalid: BotGroupInvalidFile[]
  } | null>(null)
  // 是否扫过（聚焦 / 事件重扫只在首次展开后生效）
  const scannedOnce = useRef(false)
  // 递增序号丢弃过期回包（聚焦 / 事件 / 手动刷新并发时只认最后一次）
  const scanSeq = useRef(0)

  const scan = useCallback(async (): Promise<void> => {
    scannedOnce.current = true
    const seq = ++scanSeq.current
    try {
      const r = await adapter.list()
      if (seq === scanSeq.current) setScanned(r)
    } catch {
      if (seq === scanSeq.current) setScanned({ bots: [], invalid: [] })
    }
  }, [adapter])

  useEffect(() => {
    const onFocus = (): void => {
      if (scannedOnce.current) void scan()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [scan])

  // 经 botService 落盘的变更（保存 / 新建 / 删除 / 修好非法文件）—— 列表跟着走，
  // 不必等用户切窗口；没展开过就不扫，下次展开自然会扫
  useAppEvent('bot.changed', () => {
    if (scannedOnce.current) void scan()
  })

  const toggle = (): void => {
    const next = !collapsed
    setCollapsed(next)
    if (!next) void scan()
  }

  const openBot = (name: string): void => {
    if (activeTarget?.kind === 'edit' && activeTarget.name === name) return
    setActiveBot({ kind: 'edit', name })
  }
  const openInvalid = (fileName: string): void => {
    if (activeTarget?.kind === 'fix' && activeTarget.fileName === fileName) return
    setActiveBot({ kind: 'fix', fileName })
  }

  const openGroupMenu = (e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [
      { id: 'new-bot', label: t('sidebar.newBot') },
      { id: 'open-folder', label: t('bot.dialogOpenFolder') },
      { type: 'separator' },
      { id: 'refresh', label: t('panel.filesRefresh') }
    ]
    void showContextMenu(e, items, (action) => {
      if (action === 'new-bot') setActiveBot({ kind: 'create' })
      if (action === 'open-folder') void adapter.openFolder()
      if (action === 'refresh') void scan()
    })
  }

  const openRowMenu = (name: string, e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [
      { id: 'new-bot-chat', label: t('sidebar.newBotChat') },
      { type: 'separator' },
      { id: 'delete-bot', label: t('sidebar.deleteBot') }
    ]
    void showContextMenu(e, items, (action) => {
      if (action === 'new-bot-chat') void adapter.newSession(name)
      if (action === 'delete-bot') adapter.delete(name)
    })
  }

  const openInvalidMenu = (fileName: string, e: React.MouseEvent): void => {
    void showContextMenu(e, [{ id: 'delete-bot-file', label: t('common.delete') }], (action) => {
      if (action === 'delete-bot-file') adapter.deleteFile(fileName)
    })
  }

  // 行的通用外壳：与 WikiGroup 的条目行同一副排版（10px 基准内缩、13px、选中态 bg-bg-active）。
  // 标签直接是行的子节点而不包一层 div —— 侧栏 e2e 按「div > span.truncate」认会话行，别撞上
  const rowClass = (active: boolean): string =>
    `group relative flex items-center gap-1.5 pl-2.5 pr-1.5 py-0.5 cursor-pointer transition-opacity duration-200 ${
      active
        ? 'bg-bg-active/80 text-text-primary'
        : `text-text-secondary hover:bg-bg-hover/50 hover:text-text-primary ${
            dim && isPageActive ? 'opacity-30 hover:opacity-100' : ''
          }`
    }`

  return (
    <SessionGroup
      label={t('sidebar.botsGroup')}
      variant="bots"
      collapsed={collapsed}
      onToggle={toggle}
      active={isPageActive}
      dim={dim && !isPageActive}
      onMenu={openGroupMenu}
    >
      {scanned !== null &&
        (scanned.bots.length === 0 && scanned.invalid.length === 0 ? (
          <div className="px-3 py-2 text-xs text-text-tertiary">{t('sidebar.botsEmpty')}</div>
        ) : (
          <>
            {scanned.bots.map((b) => {
              const active = activeTarget?.kind === 'edit' && activeTarget.name === b.name
              return (
                <div
                  key={b.name}
                  data-bot-row={b.name}
                  onClick={() => openBot(b.name)}
                  onContextMenu={(e) => openRowMenu(b.name, e)}
                  title={b.description}
                  className={rowClass(active)}
                >
                  <BotAvatar name={b.name} displayName={b.displayName} size={12} />
                  <span className="flex-1 min-w-0 text-[13px] truncate group-hover:pr-5">
                    {b.displayName}
                  </span>
                  <RowMenuButton
                    className="absolute right-1.5 opacity-0 group-hover:opacity-100"
                    onOpen={(e) => openRowMenu(b.name, e)}
                  />
                </div>
              )
            })}
            {scanned.invalid.map((f) => {
              const active = activeTarget?.kind === 'fix' && activeTarget.fileName === f.fileName
              return (
                <div
                  key={f.fileName}
                  data-bot-invalid-row={f.fileName}
                  onClick={() => openInvalid(f.fileName)}
                  onContextMenu={(e) => openInvalidMenu(f.fileName, e)}
                  title={f.error}
                  className={rowClass(active)}
                >
                  <AlertTriangle size={11} className="flex-shrink-0 text-amber-500" />
                  <span className="flex-1 min-w-0 text-[12px] font-mono truncate group-hover:pr-5">
                    {f.fileName}
                  </span>
                  <RowMenuButton
                    className="absolute right-1.5 opacity-0 group-hover:opacity-100"
                    onOpen={(e) => openInvalidMenu(f.fileName, e)}
                  />
                </div>
              )
            })}
          </>
        ))}
    </SessionGroup>
  )
}
