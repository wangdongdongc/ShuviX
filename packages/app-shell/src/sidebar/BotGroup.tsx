/**
 * BotGroup —— 侧栏置顶的「Bots」分组（`~/.shuvix/bots/`）。列目录里的 bot：合法的一行一个
 * （头像 + 显示名），同名里没胜出的几份紧跟在胜出那行之后、划线变淡（与设置页被覆盖的行同一种
 * 样子，谁胜出由宿主那次同名裁决说了算，这里不另判），解析不过的文件缀在末尾以琥珀行呈现（文件名 +
 * 三角）；点任一行打开 / 复用这份
 * 文件的**笔记本会话**（隐藏项目 `__bots__`）—— 与知识库条目同一条路：live-preview、自动保存、
 * 外部改动自动重载，解析器的判定由属性卡实时显示。**没有内置 bot**，故列表里也没有内置/用户之分。
 *
 * prop 驱动、不触宿主 API（同 WikiGroup / KnowledgeGroup）：清单 / 打开 / 新建 / 打开目录 / 新建会话 /
 * 删除由宿主注入。扫描是懒的：**首次展开才扫**，之后每次展开 + 窗口聚焦 + `bot.changed` 事件（笔记本
 * 写入 / 新建 / 删除）重扫，stale-guard 防乱序回包。bot 自己在答话途中用 `edit` 改 md 不广播，由聚焦
 * 重扫兜底。
 *
 * 动作全部收在菜单里（右键 / ⋮ 同一份，与会话行一致）：组头 = 新建 bot / 打开目录 / 刷新；
 * bot 行 = 新建 Bot 会话 / 删除；被遮蔽行与非法行 = 删除（按文件名 —— 按名删会删到生效的那份）。
 * 删除的确认对话框归宿主 —— 真删掉后
 * `bot.changed` 会让本组重扫，这里不猜结果。
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { BotAvatar, useAppEvent, useChatStore } from '@shuvix/chat-ui'
import { REGISTRY_NOTE_PROJECT_IDS } from '@shuvix/chat-protocol/registryNotes'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import { SessionGroup } from './SessionGroup'
import { RowMenuButton } from './RowMenuButton'
import { useFocusDim } from './useFocusDim'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'
import type { BotPickItem } from './BotSessionDialog'

/** 分组里的一个合法 bot */
export interface BotGroupItem extends BotPickItem {
  /** bots 目录下的文件名 —— 笔记本会话按它认（名字随编辑在变，文件名不变） */
  fileName: string
}

/** 同名的另一份压过了它、当前不生效的 bot 文件 */
export interface BotGroupShadowedItem extends BotGroupItem {
  /** 压过它的那份文件的文件名 */
  shadowedBy: string
}

/** 目录里无法解析的文件（身份是文件名 —— 它解析不出 name） */
export interface BotGroupInvalidFile {
  fileName: string
  /** 解析器的人读拒绝理由（行的 title 提示） */
  error: string
}

/** 宿主注入的 bots 注册表能力（桌面：window.api.bot 的窄投影） */
export interface BotGroupAdapter {
  /** 拉取注册表：生效的 bot + 被同名遮蔽的 + 无法解析的文件（须为稳定引用，避免重复扫描） */
  list: () => Promise<{
    bots: BotGroupItem[]
    shadowed: BotGroupShadowedItem[]
    invalid: BotGroupInvalidFile[]
  }>
  /** 打开 / 复用这份文件的笔记本会话（宿主负责建会话、刷新列表并选中）；title 只在新建会话时用 */
  open: (fileName: string, title?: string) => void | Promise<void>
  /** 按模板新建一份 bot 文件并打开它的笔记本 */
  create: () => void | Promise<void>
  /** 打开 bots 目录（OS 文件管理器） */
  openFolder: () => void | Promise<unknown>
  /** 和该 bot 新建一条会话（宿主负责建会话、刷新列表并选中） */
  newSession: (name: string) => void | Promise<void>
  /** 删除 bot（宿主自带确认对话框；删掉后经 `bot.changed` 事件重扫） */
  delete: (bot: BotGroupItem) => void
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
  // 活动会话是不是某份 bot 文件的笔记本（分组头高亮 + 命中行选中态）
  const activeFileName = useChatStore((s) => {
    const active = s.sessions.find((x) => x.id === s.activeSessionId)
    if (active?.projectId !== REGISTRY_NOTE_PROJECT_IDS.bot) return null
    return active.settings.notebookPath ?? null
  })
  const isNoteActive = activeFileName !== null

  const [collapsed, setCollapsed] = useState(true)
  const [scanned, setScanned] = useState<{
    bots: BotGroupItem[]
    shadowed: BotGroupShadowedItem[]
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
      if (seq === scanSeq.current) setScanned({ bots: [], shadowed: [], invalid: [] })
    }
  }, [adapter])

  useEffect(() => {
    const onFocus = (): void => {
      if (scannedOnce.current) void scan()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [scan])

  // 宿主观察到的变更（笔记本写入 / 新建 / 删除）—— 列表跟着走，不必等用户切窗口；
  // 没展开过就不扫，下次展开自然会扫
  useAppEvent('bot.changed', () => {
    if (scannedOnce.current) void scan()
  })

  const toggle = (): void => {
    const next = !collapsed
    setCollapsed(next)
    if (!next) void scan()
  }

  const openFile = (fileName: string, title?: string): void => {
    if (activeFileName === fileName) return
    void adapter.open(fileName, title)
  }

  const openGroupMenu = (e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [
      { id: 'new-bot', label: t('sidebar.newBot') },
      { id: 'open-folder', label: t('bot.dialogOpenFolder') },
      { type: 'separator' },
      { id: 'refresh', label: t('panel.filesRefresh') }
    ]
    void showContextMenu(e, items, (action) => {
      if (action === 'new-bot') void adapter.create()
      if (action === 'open-folder') void adapter.openFolder()
      if (action === 'refresh') void scan()
    })
  }

  const openRowMenu = (bot: BotGroupItem, e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [
      { id: 'new-bot-chat', label: t('sidebar.newBotChat') },
      { type: 'separator' },
      { id: 'delete-bot', label: t('sidebar.deleteBot') }
    ]
    void showContextMenu(e, items, (action) => {
      if (action === 'new-bot-chat') void adapter.newSession(bot.name)
      if (action === 'delete-bot') adapter.delete(bot)
    })
  }

  /** 非法行与被遮蔽行共用：它们都只能按文件名删 */
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
            dim && isNoteActive ? 'opacity-30 hover:opacity-100' : ''
          }`
    }`

  return (
    <SessionGroup
      label={t('sidebar.botsGroup')}
      variant="bots"
      collapsed={collapsed}
      onToggle={toggle}
      active={isNoteActive}
      dim={dim && !isNoteActive}
      onMenu={openGroupMenu}
    >
      {scanned !== null &&
        (scanned.bots.length === 0 && scanned.invalid.length === 0 ? (
          <div className="px-3 py-2 text-xs text-text-tertiary">{t('sidebar.botsEmpty')}</div>
        ) : (
          <>
            {scanned.bots.map((b) => (
              <Fragment key={b.fileName}>
                <div
                  data-bot-row={b.name}
                  onClick={() => openFile(b.fileName, b.displayName)}
                  onContextMenu={(e) => openRowMenu(b, e)}
                  title={b.description}
                  className={rowClass(activeFileName === b.fileName)}
                >
                  <BotAvatar name={b.name} displayName={b.displayName} size={12} />
                  <span className="flex-1 min-w-0 text-[13px] truncate group-hover:pr-5">
                    {b.displayName}
                  </span>
                  <RowMenuButton
                    className="absolute right-1.5 opacity-0 group-hover:opacity-100"
                    onOpen={(e) => openRowMenu(b, e)}
                  />
                </div>
                {/* 同名里没胜出的几份：紧跟胜出那行、划线变淡；点开照样是它自己的笔记，菜单只有按文件名删除 */}
                {scanned.shadowed
                  .filter((s) => s.name === b.name)
                  .map((s) => (
                    <div
                      key={s.fileName}
                      data-bot-shadowed-row={s.fileName}
                      onClick={() => openFile(s.fileName, s.displayName)}
                      onContextMenu={(e) => openInvalidMenu(s.fileName, e)}
                      title={t('settings.shadowedByFileHint', { file: s.shadowedBy })}
                      className={rowClass(activeFileName === s.fileName)}
                    >
                      <span className="flex-shrink-0 opacity-50">
                        <BotAvatar name={s.name} displayName={s.displayName} size={12} />
                      </span>
                      <span className="flex-1 min-w-0 text-[13px] truncate line-through opacity-60 group-hover:pr-5">
                        {s.displayName}
                      </span>
                      <span className="flex-shrink-0 px-1 rounded text-[9px] bg-bg-secondary text-text-tertiary group-hover:invisible">
                        {t('sidebar.botOverridden')}
                      </span>
                      <RowMenuButton
                        className="absolute right-1.5 opacity-0 group-hover:opacity-100"
                        onOpen={(e) => openInvalidMenu(s.fileName, e)}
                      />
                    </div>
                  ))}
              </Fragment>
            ))}
            {scanned.invalid.map((f) => (
              <div
                key={f.fileName}
                data-bot-invalid-row={f.fileName}
                onClick={() => openFile(f.fileName)}
                onContextMenu={(e) => openInvalidMenu(f.fileName, e)}
                title={f.error}
                className={rowClass(activeFileName === f.fileName)}
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
            ))}
          </>
        ))}
    </SessionGroup>
  )
}
