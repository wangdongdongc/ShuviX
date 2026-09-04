import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore, selectAllPendingCounts, type Session } from '@shuvix/chat-ui'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import { SessionGroup } from './SessionGroup'
import { SessionItem } from './SessionItem'
import { ProjectMemoryFolder, type ProjectMemoryAdapter } from './ProjectMemoryFolder'
import { AnimatedCollapse } from '../common/AnimatedCollapse'
import { parentsToAutoExpand } from './autoExpandSubs'
import { useFocusDim } from './useFocusDim'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'
import { useSessionExport } from './useSessionExport'

export const TEMP_GROUP_KEY = '__no_project__'

/** 每组默认最多渲染的会话数，超出部分折叠到「查看全部」后面 */
const GROUP_VISIBLE_LIMIT = 20

export interface ProjectSessionGroupsProps {
  /** 项目骨架（id + 名称）；分组以项目为骨架、会话填入，末尾追加临时对话组 */
  projects: Array<{ id: string; name: string }>
  /** 分组折叠集合 + 切换（仅项目组：临时组是摊开的纯分节，不参与折叠） */
  collapsed: Set<string>
  onToggleGroup: (key: string) => void
  /** 在某组下新建会话（临时组传 null） */
  onNewChat: (projectId: string | null) => void
  /** 在某组下新建 Bot 会话（打开成员多选）；宿主未注入 bots 能力时缺省，入口整体不渲染 */
  onNewBotChat?: (projectId: string | null) => void
  /** 选中会话（缺省用 chatStore.setActiveSessionId） */
  onSelect?: (id: string) => void
  onDelete?: (id: string) => void
  /** 项目配置（组头菜单里的一项）；临时组无 */
  onEditProject?: (projectId: string) => void
  /** 会话配置入口（桌面：行菜单里的一项，打开 SessionConfigDialog） */
  onConfigureSession?: (id: string) => void
  /** 能力开关 */
  caps?: {
    /** 显示置顶（悬浮）徽标 */
    pin?: boolean
  }
  /** 已悬浮会话集合（caps.pin 时用于徽标） */
  pinnedSessionIds?: Set<string>
  /** 仅渲染传入会话子集（日历视图按天过滤）；缺省用 store 全量 */
  sessionsOverride?: Session[]
  /** 过滤掉无会话的项目组（日历视图用） */
  hideEmptyGroups?: boolean
  /**
   * 项目记忆能力（宿主注入；桌面 window.api.memory，扩展无）。注入后每个项目组内多一层
   * 「项目记忆」子文件夹，绑定记忆的笔记本会话也随之从会话列表里移出去（避免同一条记忆
   * 在同一个组里出现两次）。未注入则两者都不发生 —— 那些会话仍按普通笔记本会话列出。
   */
  memory?: ProjectMemoryAdapter
}

/**
 * 按项目分组的会话列表（桌面/扩展共用）—— 项目为骨架，会话填入，末尾临时对话组
 * （摊开的纯分节：无图标无折叠，见 SessionGroup 的 temp 形态；仍受每组 20 条的
 * 「查看全部」限额约束）。
 * 数据读 chat-ui 的 chatStore（sessions/active/streams/pending/shared/telegram），项目列表由宿主传入。
 * 宿主差异走 caps（pin）+ 注入回调（编辑项目 / 会话配置 / 删除 / 选中）—— 行与组头的动作
 * 都在这里组装成菜单，SessionItem / SessionGroup 只负责把它挂到右键与 ⋮ 上。
 * 桌面日历视图按天复用本组件（sessionsOverride + hideEmptyGroups）。
 */
export function ProjectSessionGroups({
  projects,
  collapsed,
  onToggleGroup,
  onNewChat,
  onNewBotChat,
  onSelect,
  onDelete,
  onEditProject,
  onConfigureSession,
  caps = {},
  pinnedSessionIds,
  sessionsOverride,
  hideEmptyGroups,
  memory
}: ProjectSessionGroupsProps): React.JSX.Element {
  const { t } = useTranslation()
  const showContextMenu = useContextMenu()
  const storeSessions = useChatStore((s) => s.sessions)
  const sessions = sessionsOverride ?? storeSessions
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const setActiveSessionId = useChatStore((s) => s.setActiveSessionId)
  const sessionStreams = useChatStore((s) => s.sessionStreams)
  const pendingCounts = useChatStore(selectAllPendingCounts)
  const { dim } = useFocusDim()
  const handleSelect = onSelect ?? setActiveSessionId

  // 已点过「查看全部」的组（展开后渲染该组全部会话）
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())

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

  // 当前活动会话若绑定的是一条项目记忆 —— 记忆子文件夹据此高亮那一行
  const activeMemory = useMemo(() => {
    const s = storeSessions.find((x) => x.id === activeSessionId)
    const slug = s?.settings.memorySlug
    return slug ? { projectId: s.projectId, slug } : null
  }, [activeSessionId, storeSessions])

  // 子会话（agent 经 session 工具自建）按父会话归拢，从平铺列表里摘出去 —— 与「绑定项目
  // 记忆的笔记本会话不进列表」同一手法。父级不在列表里（已删/被过滤）的子会话**退回平铺**：
  // 宁可让它以顶层会话出现，也不能让一条真实会话在侧栏里凭空消失
  const childrenByParent = useMemo(() => {
    const ids = new Set(sessions.map((s) => s.id))
    const map = new Map<string, Session[]>()
    for (const s of sessions) {
      if (!s.parentId || !ids.has(s.parentId)) continue
      const list = map.get(s.parentId)
      if (list) list.push(s)
      else map.set(s.parentId, [s])
    }
    // 创建序：一组子会话每跑完一轮就按 updatedAt 重排会让人找不到刚才那条
    for (const list of map.values()) list.sort((a, b) => a.createdAt - b.createdAt)
    return map
  }, [sessions])

  // 展开了子会话的父会话（本地 UI 状态，与知识库目录的展开集同形）。**缺省折叠** ——
  // 侧栏的骨架是会话列表，一条会话带出来的几条子会话默认摊开会把它挤没。
  const [expandedParents, setExpandedParents] = useState<Set<string>>(() => new Set())
  const toggleSubs = (id: string): void =>
    setExpandedParents((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  // 新建的子会话自动展开它的父会话：agent 刚开出来的那条要立刻可见，否则「它到底建了没有」
  // 只能靠数字。判据见 parentsToAutoExpand —— 关键是它**不会**在新窗口第一次拿到列表时
  // 把整棵树摊开（缺省折叠）。
  const seenSessions = useRef<Set<string>>(new Set())
  const seenChildren = useRef<Set<string>>(new Set())
  useEffect(() => {
    const fresh = parentsToAutoExpand({
      childrenByParent,
      seenChildren: seenChildren.current,
      seenSessions: seenSessions.current
    })
    seenChildren.current = new Set([...childrenByParent.values()].flat().map((c) => c.id))
    seenSessions.current = new Set(sessions.map((s) => s.id))
    if (fresh.length === 0) return
    setExpandedParents((prev) => new Set([...prev, ...fresh]))
  }, [childrenByParent, sessions])

  // 按项目分组：先为每个项目建空组，再分配会话，末尾追加临时对话组；项目按名称排序
  // 绑定项目记忆的笔记本会话不进列表 —— 它们由组内的「项目记忆」子文件夹按磁盘条目呈现
  const groups = useMemo(() => {
    const map = new Map<string, Session[]>()
    for (const p of projects) map.set(p.id, [])
    const temp: Session[] = []
    for (const s of sessions) {
      if (memory && s.settings.memorySlug) continue
      // 子会话跟着父行渲染（父级不在列表里时 childrenByParent 也没收它，照常平铺）
      if (s.parentId && childrenByParent.has(s.parentId)) continue
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
  }, [projects, sessions, projectNames, memory, childrenByParent])

  const visible = hideEmptyGroups ? groups.filter(([, s]) => s.length > 0) : groups

  // 会话行菜单（右键整行 / 点行尾的 ⋮ 是同一份）：
  // 配置（回调注入）/ 导出（内置能力；笔记本会话不提供）/ 删除（回调注入）
  const exportSession = useSessionExport()
  // 空菜单不该长出一颗点了没反应的 ⋮ —— 逐项唯一的变数是「笔记本不提供导出」
  const hasSessionMenu = (isNotebook: boolean): boolean =>
    !!onConfigureSession || !!onDelete || !isNotebook
  const openSessionMenu = (id: string, e: React.MouseEvent): void => {
    const isNotebook = !!sessions.find((s) => s.id === id)?.settings.notebookPath
    const items: ContextMenuItem[] = []
    if (onConfigureSession) items.push({ id: 'session-config', label: t('sessionConfig.title') })
    if (!isNotebook) items.push({ id: 'export-session', label: t('sidebar.exportSession') })
    if (onDelete) {
      if (items.length > 0) items.push({ type: 'separator' })
      items.push({ id: 'delete-session', label: t('sidebar.deleteSession') })
    }
    if (items.length === 0) return
    void showContextMenu(e, items, (action) => {
      if (action === 'session-config') onConfigureSession?.(id)
      if (action === 'export-session') void exportSession(id)
      if (action === 'delete-session') onDelete?.(id)
    })
  }

  // 分组头菜单（右键组头 / 点 ⋮ 是同一份）：新建对话 / 新建 Bot 会话（能力注入时）/（项目组）项目配置
  const openGroupMenu = (key: string, isTemp: boolean, e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [{ id: 'new-chat', label: t('sidebar.newChat') }]
    if (onNewBotChat) items.push({ id: 'new-bot-chat', label: t('sidebar.newBotChat') })
    if (!isTemp && onEditProject)
      items.push({ id: 'edit-project', label: t('sidebar.editProject') })
    void showContextMenu(e, items, (action) => {
      if (action === 'new-chat') onNewChat(isTemp ? null : key)
      if (action === 'new-bot-chat') onNewBotChat?.(isTemp ? null : key)
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
        const expanded = expandedGroups.has(groupKey)
        const shownSessions =
          expanded || groupSessions.length <= GROUP_VISIBLE_LIMIT
            ? groupSessions
            : groupSessions.slice(0, GROUP_VISIBLE_LIMIT)
        return (
          <SessionGroup
            key={groupKey}
            label={label}
            variant={isTemp ? 'temp' : 'project'}
            collapsed={isTemp ? undefined : collapsed.has(groupKey)}
            onToggle={isTemp ? undefined : () => onToggleGroup(groupKey)}
            active={activeGroupKey === groupKey}
            dim={groupDim}
            showDividerAbove={isTemp && idx > 0}
            onMenu={(e) => openGroupMenu(groupKey, isTemp, e)}
          >
            {memory && !isTemp && (
              <ProjectMemoryFolder
                projectId={groupKey}
                adapter={memory}
                // 折叠的项目组不扫盘（侧栏可能有几十个项目）
                enabled={!collapsed.has(groupKey)}
                activeSlug={activeMemory?.projectId === groupKey ? activeMemory.slug : null}
                dim={dim && activeGroupKey === groupKey}
              />
            )}
            {shownSessions.map((s) => {
              const children = childrenByParent.get(s.id) ?? []
              const subCollapsed = !expandedParents.has(s.id)
              const row = (item: Session, isSub: boolean): React.JSX.Element => (
                <SessionItem
                  key={item.id}
                  session={item}
                  active={activeSessionId === item.id}
                  isStreaming={sessionStreams[item.id]?.isStreaming}
                  pendingCount={pendingCounts[item.id]}
                  dim={dim && activeGroupKey === groupKey && activeSessionId !== item.id}
                  isNotebook={!!item.settings.notebookPath}
                  isBot={!!item.settings.bots?.length}
                  unreadCount={item.settings.unreadCount}
                  isPinned={caps.pin ? pinnedSessionIds?.has(item.id) : undefined}
                  isSub={isSub}
                  subCount={isSub ? 0 : children.length}
                  subCollapsed={subCollapsed}
                  onToggleSubs={toggleSubs}
                  onSelect={handleSelect}
                  onMenu={
                    hasSessionMenu(!!item.settings.notebookPath) ? openSessionMenu : undefined
                  }
                />
              )
              if (children.length === 0) return row(s, false)
              return (
                <div key={s.id}>
                  {row(s, false)}
                  {/* 折叠动画与知识库目录同一个容器 */}
                  <AnimatedCollapse open={!subCollapsed}>
                    {children.map((c) => row(c, true))}
                  </AnimatedCollapse>
                </div>
              )
            })}
            {shownSessions.length < groupSessions.length && (
              <div
                onClick={() =>
                  setExpandedGroups((prev) => {
                    const next = new Set(prev)
                    next.add(groupKey)
                    return next
                  })
                }
                // 与同组会话项一致：活动组内逐项淡化（本行永不是选中项，故恒淡）；
                // 非活动组由 SessionGroup 整组淡化，这里不再叠加，否则 0.3×0.3 几乎不可见
                className={`flex items-center gap-1.5 pl-2.5 pr-1.5 py-0.5 cursor-pointer text-text-tertiary hover:bg-bg-hover/50 hover:text-text-primary transition-opacity duration-200 ${
                  dim && activeGroupKey === groupKey ? 'opacity-30 hover:opacity-100' : ''
                }`}
              >
                <span className="w-[11px] flex-shrink-0" />
                <span className="text-[13px] truncate">{t('sidebar.viewAll')}</span>
              </div>
            )}
          </SessionGroup>
        )
      })}
    </>
  )
}
