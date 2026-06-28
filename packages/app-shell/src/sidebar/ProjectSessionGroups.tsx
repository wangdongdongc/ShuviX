import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore, selectAllPendingCounts, type Session } from '@shuvix/chat-ui'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import { SessionGroup } from './SessionGroup'
import { SessionItem } from './SessionItem'
import { useFocusDim } from './useFocusDim'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'

export const TEMP_GROUP_KEY = '__no_project__'

export interface ProjectSessionGroupsProps {
  /** 项目骨架（id + 名称）；分组以项目为骨架、会话填入，末尾追加临时对话组 */
  projects: Array<{ id: string; name: string }>
  /** 分组折叠集合 + 切换 */
  collapsed: Set<string>
  onToggleGroup: (key: string) => void
  /** 在某组下新建会话（临时组传 null） */
  onNewChat: (projectId: string | null) => void
  /** 选中会话（缺省用 chatStore.setActiveSessionId） */
  onSelect?: (id: string) => void
  onDelete?: (id: string) => void
  /** 编辑项目（项目组齿轮/右键）；临时组无 */
  onEditProject?: (projectId: string) => void
  /** 会话配置入口（桌面：双击/齿轮打开 SessionConfigDialog） */
  onConfigureSession?: (id: string) => void
  /** 能力开关 */
  caps?: {
    /** 显示置顶（悬浮）徽标 */
    pin?: boolean
    /** 显示分享 / Telegram 绑定徽标 */
    badges?: boolean
  }
  /** 已悬浮会话集合（caps.pin 时用于徽标） */
  pinnedSessionIds?: Set<string>
  /** 仅渲染传入会话子集（日历视图按天过滤）；缺省用 store 全量 */
  sessionsOverride?: Session[]
  /** 过滤掉无会话的项目组（日历视图用） */
  hideEmptyGroups?: boolean
}

/**
 * 按项目分组的会话列表（桌面/扩展共用）—— 项目为骨架，会话填入，末尾临时对话组。
 * 数据读 chat-ui 的 chatStore（sessions/active/streams/pending/shared/telegram），项目列表由宿主传入。
 * 宿主差异走 caps（pin/badges）+ 注入回调（右键菜单 / 编辑项目 / 会话配置 / 选中）。
 * 桌面日历视图按天复用本组件（sessionsOverride + hideEmptyGroups）。
 */
export function ProjectSessionGroups({
  projects,
  collapsed,
  onToggleGroup,
  onNewChat,
  onSelect,
  onDelete,
  onEditProject,
  onConfigureSession,
  caps = {},
  pinnedSessionIds,
  sessionsOverride,
  hideEmptyGroups
}: ProjectSessionGroupsProps): React.JSX.Element {
  const { t } = useTranslation()
  const showContextMenu = useContextMenu()
  const storeSessions = useChatStore((s) => s.sessions)
  const sessions = sessionsOverride ?? storeSessions
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const setActiveSessionId = useChatStore((s) => s.setActiveSessionId)
  const sessionStreams = useChatStore((s) => s.sessionStreams)
  const sharedSessionIds = useChatStore((s) => s.sharedSessionIds)
  const telegramBindings = useChatStore((s) => s.telegramBindings)
  const pendingCounts = useChatStore(selectAllPendingCounts)
  const { dim } = useFocusDim()
  const handleSelect = onSelect ?? setActiveSessionId

  // 项目名快查表（用于排序/标签）
  const projectNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const p of projects) map[p.id] = p.name
    return map
  }, [projects])

  // 当前活动会话所属组 key（用于专注模式整组淡化）—— 始终基于 store 全量
  const activeGroupKey = useMemo(() => {
    if (!activeSessionId) return null
    const s = storeSessions.find((x) => x.id === activeSessionId)
    return s?.projectId || TEMP_GROUP_KEY
  }, [activeSessionId, storeSessions])

  // 按项目分组：先为每个项目建空组，再分配会话，末尾追加临时对话组；项目按名称排序
  const groups = useMemo(() => {
    const map = new Map<string, Session[]>()
    for (const p of projects) map.set(p.id, [])
    const temp: Session[] = []
    for (const s of sessions) {
      if (s.projectId && map.has(s.projectId)) map.get(s.projectId)!.push(s)
      else if (!s.projectId) temp.push(s)
    }
    const sorted = Array.from(map.entries()).sort(([a], [b]) =>
      (projectNames[a] || '')
        .toLowerCase()
        .localeCompare((projectNames[b] || '').toLowerCase(), 'zh-CN')
    )
    const out: Array<[string, Session[]]> = sorted
    if (temp.length > 0) out.push([TEMP_GROUP_KEY, temp])
    return out
  }, [projects, sessions, projectNames])

  const visible = hideEmptyGroups ? groups.filter(([, s]) => s.length > 0) : groups

  // 会话右键菜单：配置 / 删除（按提供的回调有条件出现）
  const sessionMenuEnabled = !!(onConfigureSession || onDelete)
  const openSessionMenu = (id: string, e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = []
    if (onConfigureSession) items.push({ id: 'session-config', label: t('sessionConfig.title') })
    if (onConfigureSession && onDelete) items.push({ type: 'separator' })
    if (onDelete) items.push({ id: 'delete-session', label: t('sidebar.deleteSession') })
    void showContextMenu(e, items, (action) => {
      if (action === 'session-config') onConfigureSession?.(id)
      if (action === 'delete-session') onDelete?.(id)
    })
  }

  // 分组右键菜单：新建对话 /（项目组）编辑项目
  const openGroupMenu = (key: string, isTemp: boolean, e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [{ id: 'new-chat', label: t('sidebar.newChat') }]
    if (!isTemp && onEditProject)
      items.push({ id: 'edit-project', label: t('sidebar.editProject') })
    void showContextMenu(e, items, (action) => {
      if (action === 'new-chat') onNewChat(isTemp ? null : key)
      if (action === 'edit-project') onEditProject?.(key)
    })
  }

  return (
    <>
      {visible.map(([groupKey, groupSessions], idx) => {
        const isTemp = groupKey === TEMP_GROUP_KEY
        const label = isTemp
          ? t('sidebar.tempChats')
          : projectNames[groupKey] || t('sidebar.unnamedProject')
        // 非活动项目组在专注模式下整组淡化；活动组由逐项 dim 处理非选中会话
        const groupDim = dim && activeGroupKey !== groupKey
        return (
          <SessionGroup
            key={groupKey}
            label={label}
            variant={isTemp ? 'temp' : 'project'}
            collapsed={collapsed.has(groupKey)}
            onToggle={() => onToggleGroup(groupKey)}
            onNewChat={() => onNewChat(isTemp ? null : groupKey)}
            active={activeGroupKey === groupKey}
            dim={groupDim}
            showDividerAbove={isTemp && idx > 0}
            onEdit={isTemp || !onEditProject ? undefined : () => onEditProject(groupKey)}
            onHeaderContextMenu={(e) => openGroupMenu(groupKey, isTemp, e)}
          >
            {groupSessions.map((s) => (
              <SessionItem
                key={s.id}
                session={s}
                active={activeSessionId === s.id}
                isStreaming={sessionStreams[s.id]?.isStreaming}
                pendingCount={pendingCounts[s.id]}
                dim={dim && activeGroupKey === groupKey && activeSessionId !== s.id}
                isNotebook={!!s.settings.notebookPath}
                isPinned={caps.pin ? pinnedSessionIds?.has(s.id) : undefined}
                isShared={caps.badges ? sharedSessionIds.has(s.id) : undefined}
                isTelegramBound={caps.badges ? telegramBindings.has(s.id) : undefined}
                onSelect={handleSelect}
                onDelete={onDelete}
                onConfigure={onConfigureSession}
                onContextMenu={sessionMenuEnabled ? openSessionMenu : undefined}
              />
            ))}
          </SessionGroup>
        )
      })}
    </>
  )
}
