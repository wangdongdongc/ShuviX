import {
  boundBotOf,
  isBotSessionSettings,
  projectContextIdOf,
  workProjectOf
} from '@shuvix/chat-protocol/botSession'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Timer } from 'lucide-react'
import {
  BotAvatar,
  useChatStore,
  selectAllPendingCounts,
  selectInterruptedSessions,
  selectStreamingSessions,
  type Session
} from '@shuvix/chat-ui'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import { isForkableSessionShape } from '@shuvix/chat-protocol/sessionFork'
import { REGISTRY_NOTE_PROJECT_IDS } from '@shuvix/chat-protocol/registryNotes'
import { SessionGroup } from './SessionGroup'
import { SessionItem } from './SessionItem'
import { AnimatedCollapse } from '../common/AnimatedCollapse'
import { parentsToAutoExpand } from './autoExpandSubs'
import { useFocusDim } from './useFocusDim'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'
import { useSessionExport } from './useSessionExport'
import { ProjectKnowledgeFolder } from './ProjectKnowledgeFolder'
import type { KnowledgeGroupAdapter } from './KnowledgeTreeView'
import { RowMenuButton } from './RowMenuButton'
import {
  useBotRegistry,
  type BotGroupAdapter,
  type BotGroupItem,
  type BotSessionLocation
} from './useBotRegistry'

export const TEMP_GROUP_KEY = '__no_project__'

/** bot 组的 key 前缀（项目组用项目 id、临时组用 TEMP_GROUP_KEY） */
export const BOT_GROUP_PREFIX = 'bot:'
export const botGroupKey = (name: string): string => `${BOT_GROUP_PREFIX}${name}`

/**
 * 一条**顶层**会话进不进 bot 组：bot 会话（只归属 bot，2026-10-31）→ 它绑定的 bot 名；别的 → undefined。
 * 子会话不看（跟着父行走）
 */
export function botGroupOf(session: Pick<Session, 'parentId' | 'settings'>): string | undefined {
  return session.parentId ? undefined : boundBotOf(session.settings)
}

/** 位置选择里直接列出的项目个数（最近用过的在前），其余收进「更多项目」 */
const PICKER_RECENT_PROJECTS = 8

/** 「Bots」分节能力（宿主注入；扩展没有 bot，不注入则整节不画，bot 会话照旧落在临时对话里） */
export interface BotsSectionCaps {
  adapter: BotGroupAdapter
  /**
   * 位置选择里的「打开文件夹…」：选目录、加成项目（同路径已有就复用），回项目 id；取消回 null。
   * 不给则没有这一项（没有目录选择框的宿主）
   */
  pickFolderAsProject?: () => Promise<string | null>
  /**
   * 归档了的项目（id + 名称）：bot 会话引用的项目被归档时行尾照样标它的名字 —— 项目还在，只是不在侧栏里，不该读成
   * 「项目已删除」。不给则按删除处理
   */
  archivedProjects?: Array<{ id: string; name: string }>
}

/** 每组先给几条（超出的折在「查看更多」后面）—— 侧栏一眼该看得完，旧会话按需再放 */
const GROUP_VISIBLE_LIMIT = 8
/** 每点一次「查看更多」再多放出的条数 */
const GROUP_PAGE_SIZE = 20

export interface ProjectSessionGroupsProps {
  /** 项目骨架（id + 名称）；分组以项目为骨架、会话填入，末尾追加临时对话组 */
  projects: Array<{ id: string; name: string }>
  /** 分组折叠集合 + 切换（仅项目组：临时组是摊开的纯分节，不参与折叠） */
  collapsed: Set<string>
  onToggleGroup: (key: string) => void
  /** 在某组下新建会话（临时组传 null） */
  onNewChat: (projectId: string | null) => void
  /**
   * 「Bots」分节（2026-10-31：bot 会话只归属 bot，收拢在各自的 bot 名下，不再出现在项目组与临时对话里）。
   * 缺省不画，bot 会话照旧按项目 / 临时分组（扩展）
   */
  bots?: BotsSectionCaps
  /** 只画「Bots」分节（侧栏空态：一个会话、一个项目都没有时，下面换成「打开文件夹」的提示） */
  botsOnly?: boolean
  /** 选中会话（缺省用 chatStore.setActiveSessionId） */
  onSelect?: (id: string) => void
  onDelete?: (id: string) => void
  /** 项目配置（组头菜单里的一项）；临时组无 */
  onEditProject?: (projectId: string) => void
  /** 会话配置入口（桌面：行菜单里的一项，打开 SessionConfigDialog） */
  onConfigureSession?: (id: string) => void
  /**
   * 会话 fork（行菜单里的「分支会话」：复制整段当前对话成一条新会话）。只对形态给的会话出现（项目会话与
   * 临时会话，chat-protocol 的 isForkableSessionShape），在跑 / 被中断时置灰；宿主不注入则整项不出现
   */
  onForkSession?: (id: string) => void
  /**
   * 行菜单里的「复制链接」（日历按天渲染时传：复制的是指向这条会话选中那一天的链接，粘到哪里由用户定）；
   * 缺省整项不出现
   */
  onCopyLink?: (id: string) => void
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
   * 在项目组外面套一层「项目」分节标题（与临时对话组同一形态：无图标、无折叠、悬停一颗 ⋮）。
   * 侧栏传；日历视图按天渲染时不传 —— 那里一天里只有几条会话，多一层标题只是噪音。
   *   - `dividerAbove`：上方还有别的东西时才画那条线（桌面的知识库分组；扩展没有）
   *   - `onNewProject`：分节头菜单里的「打开文件夹」—— 它是新建项目**唯一**的常驻入口
   *     （顶栏那颗 + 已收进来），故有项目没项目都要把分节标题渲染出来
   */
  projectsSection?: { dividerAbove?: boolean; onNewProject?: () => void }
  /**
   * 知识库能力（宿主注入；桌面 window.api.knowledge，扩展无）。注入后每个项目组内多一层
   * 「项目知识库」子文件夹（ProjectKnowledgeFolder）—— 那个项目自己的库。
   */
  projectKnowledge?: KnowledgeGroupAdapter
}

/**
 * 按项目分组的会话列表（桌面/扩展共用）—— 项目为骨架，会话填入，末尾临时对话组
 * （摊开的纯分节：无图标无折叠，见 SessionGroup 的 temp 形态；仍受每组 20 条的
 * 「查看全部」限额约束）。侧栏再经 projectsSection 给项目组套一层同形态的「项目」分节
 * 标题 —— 于是「项目」与「临时对话」是两个并列的分节（各自上方一条分隔线），而不再是
 * 顶栏标题与它下面的一切。
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
  bots,
  botsOnly = false,
  onSelect,
  onDelete,
  onEditProject,
  onConfigureSession,
  onForkSession,
  onCopyLink,
  caps = {},
  pinnedSessionIds,
  sessionsOverride,
  hideEmptyGroups,
  projectsSection,
  projectKnowledge
}: ProjectSessionGroupsProps): React.JSX.Element {
  const { t } = useTranslation()
  const showContextMenu = useContextMenu()
  const storeSessions = useChatStore((s) => s.sessions)
  // sessionsOverride 只定「哪几条」，每条的内容仍以 store 为准：日历的当日列表是一次性快照，
  // 之后的改名（自动标题经 session.titleChanged、手动改名都只写 store）不会回到快照里
  const sessions = useMemo(() => {
    if (!sessionsOverride) return storeSessions
    const byId = new Map(storeSessions.map((s) => [s.id, s]))
    return sessionsOverride.map((s) => byId.get(s.id) ?? s)
  }, [sessionsOverride, storeSessions])
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const setActiveSessionId = useChatStore((s) => s.setActiveSessionId)
  const streamingSessions = useChatStore(selectStreamingSessions)
  const pendingCounts = useChatStore(selectAllPendingCounts)
  const interruptedSessions = useChatStore(selectInterruptedSessions)
  const { dim } = useFocusDim()
  const handleSelect = onSelect ?? setActiveSessionId

  // 各组经「查看更多」额外放出的条数（每点一次加一页），组内会话很多时不至于一下全铺开
  const [extraVisible, setExtraVisible] = useState<Record<string, number>>({})

  // 项目名快查表（用于排序/标签）
  const projectNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const p of projects) map[p.id] = p.name
    return map
  }, [projects])

  const { registry: botRegistry, rescan: rescanBots } = useBotRegistry(bots?.adapter)

  // 一条会话落在哪个组：bot 会话 → 它的 bot 组（注入了 bots 时）；子会话随父会话；其余按项目 / 临时
  const groupKeyOf = (s: Session | undefined): string | null => {
    if (!s) return null
    const root = s.parentId ? (storeSessions.find((x) => x.id === s.parentId) ?? s) : s
    const bot = bots ? botGroupOf(root) : undefined
    if (bot) return botGroupKey(bot)
    return root.projectId || TEMP_GROUP_KEY
  }

  // 当前活动会话所属组 key（用于专注模式整组淡化）—— 始终基于 store 全量
  const activeGroupKey = useMemo(
    () =>
      activeSessionId ? groupKeyOf(storeSessions.find((x) => x.id === activeSessionId)) : null,
    // groupKeyOf 只读 storeSessions 与 bots（都在依赖里）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSessionId, storeSessions, bots]
  )

  // 子会话（agent 经 session 工具自建）按父会话归拢，从平铺列表里摘出去。父级不在列表里
  // （已删/被过滤）的子会话**退回平铺**：宁可让它以顶层会话出现，也不能让一条真实会话在
  // 侧栏里凭空消失
  const childrenByParent = useMemo(() => {
    const ids = new Set(sessions.map((s) => s.id))
    const map = new Map<string, Session[]>()
    for (const s of sessions) {
      if (!s.parentId || !ids.has(s.parentId)) continue
      const list = map.get(s.parentId)
      if (list) list.push(s)
      else map.set(s.parentId, [s])
    }
    // 创建序：一组子会话每跑完一轮就按 lastActiveAt 重排会让人找不到刚才那条
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

  // 按项目分组：先为每个项目建空组，再分配会话，末尾追加临时对话组；项目按名称排序。
  // 注入了 bots 时 bot 会话另收进 botSessions（按 bot 名），不进项目组也不进临时组
  const { groups, botSessions } = useMemo(() => {
    const map = new Map<string, Session[]>()
    for (const p of projects) map.set(p.id, [])
    const temp: Session[] = []
    const byBot = new Map<string, Session[]>()
    for (const s of sessions) {
      // 子会话跟着父行渲染（父级不在列表里时 childrenByParent 也没收它，照常平铺）
      if (s.parentId && childrenByParent.has(s.parentId)) continue
      const bot = bots ? botGroupOf(s) : undefined
      if (bot) {
        const list = byBot.get(bot)
        if (list) list.push(s)
        else byBot.set(bot, [s])
        continue
      }
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
    return { groups: out, botSessions: byBot }
  }, [projects, sessions, projectNames, childrenByParent, bots])

  const visible = hideEmptyGroups ? groups.filter(([, s]) => s.length > 0) : groups

  // 会话行菜单（右键整行 / 点行尾的 ⋮ 是同一份）：
  // 复制链接（日历注入）/ 配置（回调注入）/ 导出（内置能力；笔记本会话不提供）/ 删除（回调注入）
  const exportSession = useSessionExport()
  // 空菜单不该长出一颗点了没反应的 ⋮ —— 逐项唯一的变数是「笔记本不提供导出」
  const hasSessionMenu = (isNotebook: boolean): boolean =>
    !!onConfigureSession || !!onDelete || !!onCopyLink || !isNotebook
  const openSessionMenu = (id: string, e: React.MouseEvent): void => {
    const session = sessions.find((s) => s.id === id)
    const isNotebook = !!session?.settings.notebookPath
    const items: ContextMenuItem[] = []
    if (onCopyLink) items.push({ id: 'copy-link', label: t('sidebar.copySessionLink') })
    if (onConfigureSession) items.push({ id: 'session-config', label: t('sessionConfig.title') })
    if (!isNotebook) items.push({ id: 'export-session', label: t('sidebar.exportSession') })
    // 拷贝要等它停下：在跑 / 被中断时置灰（后台还有派生 agent 在跑这一种这里看不出来，由宿主拒绝）
    if (onForkSession && session && isForkableSessionShape(session)) {
      const idle = !streamingSessions[id] && !interruptedSessions[id]
      items.push({ id: 'fork-session', label: t('sidebar.forkSession'), enabled: idle })
    }
    if (onDelete) {
      if (items.length > 0) items.push({ type: 'separator' })
      items.push({ id: 'delete-session', label: t('sidebar.deleteSession') })
    }
    if (items.length === 0) return
    void showContextMenu(e, items, (action) => {
      if (action === 'copy-link') onCopyLink?.(id)
      if (action === 'session-config') onConfigureSession?.(id)
      if (action === 'export-session') void exportSession(id)
      if (action === 'fork-session') onForkSession?.(id)
      if (action === 'delete-session') onDelete?.(id)
    })
  }

  // 分组头菜单（右键组头 / 点 ⋮ 是同一份）：新建对话 /（项目组）项目配置。bot 会话不再从项目里开（2026-10-31）：
  // 它们只归属 bot，入口在「Bots」分节的 bot 组上
  const openGroupMenu = (key: string, isTemp: boolean, e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [{ id: 'new-chat', label: t('sidebar.newChat') }]
    if (!isTemp && onEditProject)
      items.push({ id: 'edit-project', label: t('sidebar.editProject') })
    void showContextMenu(e, items, (action) => {
      if (action === 'new-chat') onNewChat(isTemp ? null : key)
      if (action === 'edit-project') onEditProject?.(key)
    })
  }

  // 「项目」分节头菜单：只有「打开文件夹」一项（新建项目从顶栏那颗 + 收进来的）
  const openProjectsMenu = (e: React.MouseEvent): void => {
    const onNewProject = projectsSection?.onNewProject
    if (!onNewProject) return
    void showContextMenu(e, [{ id: 'new-project', label: t('sidebar.newProject') }], (action) => {
      if (action === 'new-project') onNewProject()
    })
  }

  // ─── bot 组 ────────────────────────────────────

  // bot 组的折叠：侧栏缺省收起（与项目组一样，一个 bot 的会话可以很多）；日历按天渲染时缺省摊开（一天就几条，
  // 收起来就看不见了）。存的是「和缺省反着的那几组」
  const [botToggled, setBotToggled] = useState<Set<string>>(() => new Set())
  const botCollapsed = (key: string): boolean =>
    hideEmptyGroups ? botToggled.has(key) : !botToggled.has(key)
  const toggleBot = (key: string): void =>
    setBotToggled((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })
  const expandBot = (key: string): void => {
    if (botCollapsed(key)) toggleBot(key)
  }
  // 组里那一行「定时运行」的展开：侧栏缺省收起（日记 bot 一天一条，摊开就淹掉用户自己开的对话），日历缺省摊开
  const [runsToggled, setRunsToggled] = useState<Set<string>>(() => new Set())
  const runsOpen = (key: string): boolean =>
    hideEmptyGroups ? !runsToggled.has(key) : runsToggled.has(key)
  const toggleRuns = (key: string): void =>
    setRunsToggled((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  /**
   * 「在哪里工作？」—— 开一条 bot 会话前必须先选位置（用户 2026-10-30：不给缺省）：最近用过的项目在前，其余收进
   * 「更多项目」；「打开文件夹…」把一个文件夹加成项目再选它；「临时」是临时工作区。关掉菜单就什么都不建
   */
  const openLocationPicker = (bot: BotGroupItem, e: React.MouseEvent): void => {
    if (!bots) return
    // 项目的「最近」：它名下的会话与引用它的 bot 会话里最近的一次
    const recency = new Map<string, number>()
    for (const s of storeSessions) {
      const pid = projectContextIdOf(s)
      if (pid) recency.set(pid, Math.max(recency.get(pid) ?? 0, s.lastActiveAt))
    }
    const byRecent = [...projects].sort(
      (a, b) =>
        (recency.get(b.id) ?? 0) - (recency.get(a.id) ?? 0) || a.name.localeCompare(b.name, 'zh-CN')
    )
    const projectItem = (p: { id: string; name: string }): ContextMenuItem => ({
      id: `project:${p.id}`,
      label: p.name || t('sidebar.unnamedProject')
    })
    const items: ContextMenuItem[] = [
      { id: 'where', label: t('sidebar.botWhere'), enabled: false },
      ...byRecent.slice(0, PICKER_RECENT_PROJECTS).map(projectItem)
    ]
    const rest = byRecent.slice(PICKER_RECENT_PROJECTS)
    if (rest.length > 0) {
      items.push({
        id: 'more-projects',
        label: t('sidebar.botMoreProjects'),
        submenu: [...rest].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).map(projectItem)
      })
    }
    items.push({ type: 'separator' })
    if (bots.pickFolderAsProject)
      items.push({ id: 'open-folder', label: t('sidebar.botOpenFolder') })
    items.push({ id: 'temp', label: t('sidebar.botTempLocation') })
    const create = (location: BotSessionLocation): void => {
      expandBot(botGroupKey(bot.name))
      void bots.adapter.newSession(bot.name, location)
    }
    void showContextMenu(e, items, (action) => {
      if (action.startsWith('project:')) create({ workProject: action.slice('project:'.length) })
      if (action === 'temp') create({ temp: true })
      if (action === 'open-folder') {
        void bots.pickFolderAsProject?.().then((pid) => {
          if (pid) create({ workProject: pid })
        })
      }
    })
  }

  // bot 组头菜单：新对话 / 编辑 bot（打开 bot 文件的笔记本）/ 归档（与项目一样：删除在 设置 → 已归档 里，连同会话）
  const openBotMenu = (bot: BotGroupItem, e: React.MouseEvent): void => {
    if (!bots) return
    const items: ContextMenuItem[] = [
      { id: 'new-bot-chat', label: t('sidebar.newChat') },
      { id: 'edit-bot', label: t('sidebar.editBot') },
      { type: 'separator' },
      { id: 'archive-bot', label: t('sidebar.archiveBot') }
    ]
    void showContextMenu(e, items, (action) => {
      if (action === 'new-bot-chat') openLocationPicker(bot, e)
      if (action === 'edit-bot') void bots.adapter.open(bot.fileName, bot.displayName)
      if (action === 'archive-bot') bots.adapter.archive(bot)
    })
  }

  // 找不到 bot 文件的那一组：只能把它的会话一起删掉
  const openMissingBotMenu = (name: string, count: number, e: React.MouseEvent): void => {
    const deleteSessions = bots?.adapter.deleteSessions
    if (!deleteSessions) return
    void showContextMenu(
      e,
      [{ id: 'delete-sessions', label: t('sidebar.botDeleteSessions') }],
      (action) => {
        if (action === 'delete-sessions') deleteSessions(name, count)
      }
    )
  }

  // 「Bots」分节头菜单：新建 bot（按模板落一份文件并打开它的笔记本）/ 打开 Bots 文件夹 / 刷新
  const openBotsSectionMenu = (e: React.MouseEvent): void => {
    if (!bots) return
    const items: ContextMenuItem[] = [
      { id: 'new-bot', label: t('sidebar.newBot') },
      { id: 'open-folder', label: t('bot.dialogOpenFolder') },
      { type: 'separator' },
      { id: 'refresh', label: t('panel.filesRefresh') }
    ]
    void showContextMenu(e, items, (action) => {
      if (action === 'new-bot') void bots.adapter.create()
      if (action === 'open-folder') void bots.adapter.openFolder()
      if (action === 'refresh') rescanBots()
    })
  }

  /** 被同名遮蔽的与解析不过的 bot 文件：都只能按文件名删 */
  const openBotFileMenu = (fileName: string, e: React.MouseEvent): void => {
    if (!bots) return
    void showContextMenu(e, [{ id: 'delete-bot-file', label: t('common.delete') }], (action) => {
      if (action === 'delete-bot-file') bots.adapter.deleteFile(fileName)
    })
  }

  // 正打开着的那份 bot 文件（笔记本会话）：被遮蔽 / 解析不过的行据此高亮
  const activeBotFile = useMemo(() => {
    const active = storeSessions.find((x) => x.id === activeSessionId)
    return active?.projectId === REGISTRY_NOTE_PROJECT_IDS.bot
      ? (active.settings.notebookPath ?? null)
      : null
  }, [activeSessionId, storeSessions])

  /** bot 会话行尾标的位置：引用的项目名（归档了的也是）；项目已删 → 「项目已删除」；临时 → 「临时」 */
  const locationOf = (s: Session): string => {
    const pid = workProjectOf(s.settings)
    if (!pid) return t('sidebar.botTempLocation')
    // 项目在（侧栏里的或归档了的）：标它的名字，没起名字就是「未命名项目」；都不在才是「项目已删除」
    const known =
      pid in projectNames
        ? projectNames[pid]
        : bots?.archivedProjects?.find((p) => p.id === pid)?.name
    if (known === undefined) return t('sidebar.botProjectGone')
    return known || t('sidebar.unnamedProject')
  }

  /** 一组的会话行（项目组、临时组、bot 组共用）：子会话折在父行下面，超出的收进「查看更多」 */
  const renderRows = (
    groupKey: string,
    groupSessions: Session[],
    location?: (s: Session) => string
  ): React.JSX.Element => {
    const limit = GROUP_VISIBLE_LIMIT + (extraVisible[groupKey] ?? 0)
    const shownSessions =
      groupSessions.length <= limit ? groupSessions : groupSessions.slice(0, limit)
    return (
      <>
        {shownSessions.map((s) => {
          const children = childrenByParent.get(s.id) ?? []
          const subCollapsed = !expandedParents.has(s.id)
          const row = (item: Session, isSub: boolean): React.JSX.Element => (
            <SessionItem
              key={item.id}
              session={item}
              active={activeSessionId === item.id}
              isStreaming={streamingSessions[item.id]}
              interrupted={interruptedSessions[item.id]}
              pendingCount={pendingCounts[item.id]}
              dim={dim && activeGroupKey === groupKey && activeSessionId !== item.id}
              isNotebook={!!item.settings.notebookPath}
              isBot={isBotSessionSettings(item.settings)}
              isPinned={caps.pin ? pinnedSessionIds?.has(item.id) : undefined}
              isSub={isSub}
              subCount={isSub ? 0 : children.length}
              subCollapsed={subCollapsed}
              onToggleSubs={toggleSubs}
              onSelect={handleSelect}
              onMenu={hasSessionMenu(!!item.settings.notebookPath) ? openSessionMenu : undefined}
              location={!isSub && location ? location(item) : undefined}
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
              setExtraVisible((prev) => ({
                ...prev,
                [groupKey]: (prev[groupKey] ?? 0) + GROUP_PAGE_SIZE
              }))
            }
            // 与同组会话项一致：活动组内逐项淡化（本行永不是选中项，故恒淡）；
            // 非活动组由 SessionGroup 整组淡化，这里不再叠加，否则 0.3×0.3 几乎不可见
            data-view-more=""
            className={`sb-row cursor-pointer text-text-tertiary hover:bg-bg-hover/60 hover:text-text-primary transition-opacity duration-200 ${
              dim && activeGroupKey === groupKey ? 'opacity-30 hover:opacity-100' : ''
            }`}
          >
            <span className="sb-icon" />
            <span className="truncate">
              {t('sidebar.viewMore')}
              <span className="ml-1.5 tabular-nums text-text-tertiary/70">
                {groupSessions.length - shownSessions.length}
              </span>
            </span>
          </div>
        )}
      </>
    )
  }

  /**
   * 单个分组的渲染。项目组与临时组的组装完全一样，差别只在外层：项目组被套进「项目」
   * 分节，临时组自己就是一个分节（见下面 return）。
   */
  const renderGroup = (
    [groupKey, groupSessions]: [string, Session[]],
    dividerAbove = false
  ): React.JSX.Element => {
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
        collapsed={isTemp ? undefined : collapsed.has(groupKey)}
        onToggle={isTemp ? undefined : () => onToggleGroup(groupKey)}
        active={activeGroupKey === groupKey}
        dim={groupDim}
        showDividerAbove={dividerAbove}
        onMenu={(e) => openGroupMenu(groupKey, isTemp, e)}
      >
        {projectKnowledge && !isTemp && (
          <ProjectKnowledgeFolder
            projectId={groupKey}
            adapter={projectKnowledge}
            // 折叠的项目组不扫盘（侧栏可能有几十个项目）
            enabled={!collapsed.has(groupKey)}
            dim={dim && activeGroupKey === groupKey}
          />
        )}
        {renderRows(groupKey, groupSessions)}
      </SessionGroup>
    )
  }

  /**
   * 一组 bot 会话的正文：用户自己开的在前；触发器开出来的运行会话（settings.triggerRun）折进末尾一行「定时运行 · N」，
   * 最近一次在跑时那一行带一个运行点
   */
  const renderBotRows = (key: string, groupSessions: Session[]): React.JSX.Element => {
    const own = groupSessions.filter((s) => !s.settings.triggerRun)
    const runs = groupSessions.filter((s) => s.settings.triggerRun)
    const open = runsOpen(key)
    const running = runs.some((s) => streamingSessions[s.id])
    return (
      <>
        {renderRows(key, own, locationOf)}
        {runs.length > 0 && (
          <div data-bot-runs="">
            <div
              data-bot-runs-toggle={open ? 'expanded' : 'collapsed'}
              onClick={() => toggleRuns(key)}
              className="sb-row cursor-pointer text-text-tertiary hover:bg-bg-hover/60 hover:text-text-primary"
            >
              <Timer className={`sb-icon ${running ? 'animate-pulse text-accent' : ''}`} />
              <span className="truncate">{t('sidebar.botTriggerRuns')}</span>
              <span className="text-[0.8em] tabular-nums text-text-tertiary/70">{runs.length}</span>
            </div>
            <AnimatedCollapse open={open}>
              {/* 再进一级：这几行挂在「定时运行」下面 */}
              <div style={{ ['--sb-base' as string]: 'calc(var(--sb-indent) * 2)' }}>
                {renderRows(`${key}:runs`, runs, locationOf)}
              </div>
            </AnimatedCollapse>
          </div>
        )}
      </>
    )
  }

  /** 一个 bot 组：头像 + 显示名，正文是它的会话（行尾标位置）；还没有会话时是一行「新对话」 */
  const renderBotGroup = (bot: BotGroupItem): React.JSX.Element | null => {
    const key = botGroupKey(bot.name)
    const groupSessions = botSessions.get(bot.name) ?? []
    if (hideEmptyGroups && groupSessions.length === 0) return null
    return (
      <div key={key} data-bot-group={bot.name}>
        <SessionGroup
          label={bot.displayName}
          variant="bot"
          icon={<BotAvatar name={bot.name} displayName={bot.displayName} size={15} />}
          collapsed={botCollapsed(key)}
          onToggle={() => toggleBot(key)}
          active={activeGroupKey === key}
          dim={dim && activeGroupKey !== key}
          onMenu={hideEmptyGroups ? undefined : (e) => openBotMenu(bot, e)}
          onAdd={hideEmptyGroups ? undefined : (e) => openLocationPicker(bot, e)}
          addLabel={t('sidebar.newChat')}
        >
          {groupSessions.length === 0 ? (
            <div
              data-bot-new-chat=""
              onClick={(e) => openLocationPicker(bot, e)}
              className="sb-row cursor-pointer text-text-tertiary hover:bg-bg-hover/60 hover:text-text-primary"
            >
              <span className="sb-icon" />
              <span className="truncate">{t('sidebar.newChat')}</span>
            </div>
          ) : (
            renderBotRows(key, groupSessions)
          )}
        </SessionGroup>
      </div>
    )
  }

  /**
   * 「Bots」分节：生效的 bot 各一组（按显示名），同名里没胜出的与解析不过的文件缀在后面（只能打开或按文件名删），
   * 最后是找不到 bot 文件的那几组会话（文件在 ShuviX 之外被删了 —— 同名的文件回来就自动归位）
   */
  const renderBotsSection = (): React.JSX.Element | null => {
    if (!bots) return null
    const registry = botRegistry ?? { bots: [], shadowed: [], invalid: [] }
    const known = new Set(registry.bots.map((b) => b.name))
    // 归档了的 bot：它的会话一起藏起来（与归档项目一样），既不画组也不当成「找不到」
    const archived = new Set(registry.archived ?? [])
    // 还没扫回来时不算「找不到」：那只是还不知道
    const missing =
      botRegistry === null
        ? []
        : [...botSessions.keys()]
            .filter((name) => !known.has(name) && !archived.has(name))
            .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    const sorted = [...registry.bots].sort((a, b) =>
      a.displayName.localeCompare(b.displayName, 'zh-CN')
    )
    // 日历：只画当天有会话的 bot；一个都没有就整节不画（清单还没回来时按会话里有没有 bot 会话算）
    if (
      hideEmptyGroups &&
      !sorted.some((b) => botSessions.has(b.name)) &&
      missing.length === 0 &&
      (botRegistry !== null || botSessions.size === 0)
    ) {
      return null
    }
    const fileRowClass = (active: boolean): string =>
      `group relative sb-row cursor-pointer transition-opacity duration-200 ${
        active ? 'bg-bg-active/80 text-text-primary' : 'text-text-primary hover:bg-bg-hover/60'
      }`
    // 清单还没扫回来（或一次都没扫成）：先按会话里的 bot 名把组列出来 —— 会话不能因为扫描慢 / 失败就从侧栏里消失；
    // 这时不知道它们的文件在哪，组上没有菜单、没有「+」
    const unknown =
      botRegistry === null
        ? [...botSessions.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'))
        : []
    return (
      <SessionGroup
        label={t('sidebar.botsGroup')}
        variant="section"
        experimental="bots"
        showDividerAbove={projectsSection?.dividerAbove}
        onMenu={hideEmptyGroups ? undefined : openBotsSectionMenu}
      >
        <div data-sidebar-section="bots">
          {sorted.map(renderBotGroup)}
          {unknown.map((name) => {
            const key = botGroupKey(name)
            return (
              <div key={key} data-bot-group={name} data-bot-group-pending="">
                <SessionGroup
                  label={name}
                  variant="bot"
                  icon={<BotAvatar name={name} displayName={name} size={15} />}
                  collapsed={botCollapsed(key)}
                  onToggle={() => toggleBot(key)}
                  active={activeGroupKey === key}
                  dim={dim && activeGroupKey !== key}
                >
                  {renderBotRows(key, botSessions.get(name) ?? [])}
                </SessionGroup>
              </div>
            )
          })}
          {!hideEmptyGroups && (
            <>
              {registry.shadowed.map((s) => (
                <div
                  key={s.fileName}
                  data-bot-shadowed-row={s.fileName}
                  onClick={() => void bots.adapter.open(s.fileName, s.displayName)}
                  onContextMenu={(e) => openBotFileMenu(s.fileName, e)}
                  title={t('settings.shadowedByFileHint', { file: s.shadowedBy })}
                  className={fileRowClass(activeBotFile === s.fileName)}
                >
                  <span className="sb-icon opacity-50">
                    <BotAvatar name={s.name} displayName={s.displayName} size={15} />
                  </span>
                  <span className="flex-1 min-w-0 truncate line-through opacity-60 group-hover:pr-5">
                    {s.displayName}
                  </span>
                  <span className="flex-shrink-0 px-1 rounded text-[9px] bg-bg-secondary text-text-tertiary group-hover:invisible">
                    {t('sidebar.botOverridden')}
                  </span>
                  <RowMenuButton
                    className="absolute right-1.5 opacity-0 group-hover:opacity-100"
                    onOpen={(e) => openBotFileMenu(s.fileName, e)}
                  />
                </div>
              ))}
              {registry.invalid.map((f) => (
                <div
                  key={f.fileName}
                  data-bot-invalid-row={f.fileName}
                  onClick={() => void bots.adapter.open(f.fileName)}
                  onContextMenu={(e) => openBotFileMenu(f.fileName, e)}
                  title={f.error}
                  className={fileRowClass(activeBotFile === f.fileName)}
                >
                  <span className="sb-icon">
                    <AlertTriangle size={12} className="text-amber-500" />
                  </span>
                  <span className="flex-1 min-w-0 font-mono text-[0.9em] truncate group-hover:pr-5">
                    {f.fileName}
                  </span>
                  <RowMenuButton
                    className="absolute right-1.5 opacity-0 group-hover:opacity-100"
                    onOpen={(e) => openBotFileMenu(f.fileName, e)}
                  />
                </div>
              ))}
              {botRegistry !== null &&
                sorted.length === 0 &&
                registry.invalid.length === 0 &&
                missing.length === 0 && (
                  <div
                    data-bots-empty=""
                    className="sb-hint cursor-pointer hover:text-text-secondary"
                    onClick={() => void bots.adapter.create()}
                  >
                    {t('sidebar.botsEmpty')}
                  </div>
                )}
            </>
          )}
          {missing.map((name) => {
            const key = botGroupKey(name)
            const orphans = botSessions.get(name) ?? []
            return (
              <div key={key} data-bot-missing-group={name}>
                <SessionGroup
                  label={name}
                  variant="bot"
                  icon={<BotAvatar name={name} displayName={name} size={15} />}
                  muted
                  collapsed={botCollapsed(key)}
                  onToggle={() => toggleBot(key)}
                  active={activeGroupKey === key}
                  dim={dim && activeGroupKey !== key}
                  onMenu={
                    hideEmptyGroups || !bots.adapter.deleteSessions
                      ? undefined
                      : (e) => openMissingBotMenu(name, orphans.length, e)
                  }
                >
                  <div className="sb-hint">{t('sidebar.botFileMissing')}</div>
                  {renderBotRows(key, orphans)}
                </SessionGroup>
              </div>
            )
          })}
        </div>
      </SessionGroup>
    )
  }

  // 项目组套进「项目」分节，临时组自己就是并列的另一个分节 ——
  // 资料库那几组由宿主经 groupsPrepend 插在最上面；「Bots」分节在资料库与项目之间
  const projectGroups = visible.filter(([key]) => key !== TEMP_GROUP_KEY)
  const tempGroup = visible.find(([key]) => key === TEMP_GROUP_KEY)
  const botsSection = renderBotsSection()
  if (botsOnly) return <>{botsSection}</>

  return (
    <>
      {botsSection}
      {projectsSection ? (
        // 一个项目都没有时也照样渲染：它的 ⋮ 是「打开文件夹」现在唯一的常驻入口
        <SessionGroup
          label={t('sidebar.projects')}
          variant="section"
          showDividerAbove={projectsSection.dividerAbove || !!botsSection}
          onMenu={projectsSection.onNewProject ? openProjectsMenu : undefined}
        >
          {projectGroups.map((group) => renderGroup(group))}
        </SessionGroup>
      ) : (
        projectGroups.map((group) => renderGroup(group))
      )}
      {tempGroup && renderGroup(tempGroup, projectGroups.length > 0 || !!botsSection)}
    </>
  )
}
