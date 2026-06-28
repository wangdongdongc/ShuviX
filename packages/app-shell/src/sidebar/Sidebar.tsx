import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Settings,
  FolderPlus,
  FolderClosed,
  RotateCcw,
  Trash2,
  Archive,
  ChevronUp
} from 'lucide-react'
import { getChatApi, useChatStore } from '@shuvix/chat-ui'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import { AnimatedCollapse } from '../common/AnimatedCollapse'
import { useFocusDim } from './useFocusDim'
import { ProjectSessionGroups, TEMP_GROUP_KEY } from './ProjectSessionGroups'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'
import type { ProjectRef } from './useProjects'

const ARCHIVED_GROUP_KEY = '__archived_projects__'

export interface SidebarCaps {
  /** Electron 标题栏拖拽区 + macOS 顶部交通灯留白 */
  windowDrag?: boolean
  /** 会话项置顶（悬浮）徽标 */
  pin?: boolean
  /** 会话项分享 / Telegram 绑定徽标 */
  badges?: boolean
}

export interface SidebarProps {
  caps?: SidebarCaps
  /** 项目列表（活动 + 归档）——由宿主经 useProjects() 提供，侧栏与日历视图共用同一份 */
  projects: ProjectRef[]
  archivedProjects: ProjectRef[]
  /** 打开文件夹（宿主：选目录 → 建项目 → 新建会话；桌面 dialog，扩展 FSA）。建项目后经
   *  events 'project.changed' 自动刷新项目列表 */
  onOpenFolder: () => void | Promise<void>
  /** 打开设置（桌面开独立窗口，扩展切 hash） */
  onOpenSettings: (tab?: string) => void
  /** 选中会话覆盖（桌面：若已悬浮则聚焦悬浮窗）；缺省 chatStore.setActiveSessionId */
  onSelectSession?: (id: string) => void
  onDeleteSession?: (id: string) => void
  /** 会话配置入口（桌面打开 SessionConfigDialog） */
  onConfigureSession?: (id: string) => void
  /** 编辑项目（宿主经 overlays 自渲染对话框） */
  onEditProject?: (projectId: string) => void
  /** 删除归档项目（宿主自处理确认 + 级联）；缺省隐藏删除按钮 */
  onDeleteProject?: (projectId: string, name: string) => void
  /** 已悬浮会话集合（caps.pin 时用于徽标 / 选中行为） */
  pinnedSessionIds?: Set<string>
  /** 标题行右侧额外按钮（桌面：视图切换） */
  titleActions?: React.ReactNode
  /** 底部设置栏右侧额外按钮（桌面：更新提示） */
  footerActions?: React.ReactNode
  /** 正文整体替换（桌面日历视图）；非空时不渲染分组列表与归档区 */
  bodyOverride?: React.ReactNode
  /** 宿主弹窗插槽（项目编辑 / 会话配置 / 删除确认等） */
  overlays?: React.ReactNode
  /** 标题文案（默认 sidebar.title；桌面日历模式可传 sidebar.viewCalendar） */
  title?: string
}

/**
 * 侧边栏（桌面/扩展共用）—— 标题行 + 按项目分组的会话列表（ProjectSessionGroups）+ 归档区 + 底部设置。
 * 项目/会话/事件经 getChatApi() 统一访问（宿主无关）；宿主差异走 caps + 注入回调/插槽：
 *   - 打开文件夹（dialog vs FSA）、打开设置、选中（悬浮聚焦）、右键菜单、删除项目均注入；
 *   - 视图切换 / 更新提示 / 弹窗经 titleActions / footerActions / overlays 插槽；
 *   - 日历视图经 bodyOverride 替换正文（桌面侧复用 ProjectSessionGroups 按天渲染）。
 */
export function Sidebar({
  caps = {},
  projects,
  archivedProjects,
  onOpenFolder,
  onOpenSettings,
  onSelectSession,
  onDeleteSession,
  onConfigureSession,
  onEditProject,
  onDeleteProject,
  pinnedSessionIds,
  titleActions,
  footerActions,
  bodyOverride,
  overlays,
  title
}: SidebarProps): React.JSX.Element {
  const { t } = useTranslation()
  const { dim } = useFocusDim()
  const showContextMenu = useContextMenu()
  const sessions = useChatStore((s) => s.sessions)

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set([TEMP_GROUP_KEY])
  )
  const initialCollapseApplied = useRef(false)

  // 首次加载项目后默认折叠所有项目组（与桌面一致）
  useEffect(() => {
    if (initialCollapseApplied.current || projects.length === 0) return
    initialCollapseApplied.current = true
    const initial = new Set<string>(projects.map((p) => p.id))
    initial.add(TEMP_GROUP_KEY)
    if (archivedProjects.length > 0) initial.add(ARCHIVED_GROUP_KEY)
    // 项目首次异步加载后只跑一次（initialCollapseApplied 守卫），非每渲染同步级联
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsedGroups(initial)
  }, [projects, archivedProjects])

  // 在指定项目下新建会话（统一经 getChatApi），并自动展开所在组
  const handleNewChat = async (projectId: string | null): Promise<void> => {
    const session = await getChatApi().session.create({ projectId: projectId ?? null })
    useChatStore.getState().setSessions(await getChatApi().session.list())
    useChatStore.getState().setActiveSessionId(session.id)
    const groupKey = projectId ?? TEMP_GROUP_KEY
    setCollapsedGroups((prev) => {
      if (!prev.has(groupKey)) return prev
      const next = new Set(prev)
      next.delete(groupKey)
      return next
    })
  }

  // 菜单栏「新建对话 / 新建项目」（桌面原生菜单；扩展适配器为 no-op）
  useEffect(() => {
    const offChat = getChatApi().app.onNewChat(() => {
      const store = useChatStore.getState()
      const active = store.sessions.find((s) => s.id === store.activeSessionId)
      void handleNewChat(active?.projectId ?? null)
    })
    const offProject = getChatApi().app.onNewProject(() => void onOpenFolder())
    return () => {
      offChat()
      offProject()
    }
  })

  const toggleGroup = (key: string): void =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const handleRestoreProject = async (id: string): Promise<void> => {
    // 项目列表经 useProjects() 订阅 'project.changed' 自动刷新
    await getChatApi().project.update({ id, archived: false })
  }

  // 归档项目右键菜单：恢复 /（如可删）删除
  const openArchivedMenu = (id: string, name: string, e: React.MouseEvent): void => {
    const items: ContextMenuItem[] = [{ id: 'restore-project', label: t('sidebar.restoreProject') }]
    if (onDeleteProject) {
      items.push({ type: 'separator' })
      items.push({ id: 'delete-project', label: t('sidebar.deleteProject') })
    }
    void showContextMenu(e, items, (action) => {
      if (action === 'restore-project') void handleRestoreProject(id)
      if (action === 'delete-project') onDeleteProject?.(id, name)
    })
  }

  const projectNamesEmpty = projects.length === 0
  const isEmpty = sessions.length === 0 && projectNamesEmpty && archivedProjects.length === 0
  const platform = getChatApi().app.platform
  const drag = caps.windowDrag ? 'titlebar-drag' : ''
  const noDrag = caps.windowDrag ? 'titlebar-no-drag' : ''
  const topPad = caps.windowDrag && platform === 'darwin' ? 'pt-10' : 'pt-3'

  return (
    <div className="flex flex-col h-full bg-bg-secondary/50">
      {/* 标题行（可选窗口拖拽区）+ 打开文件夹 + 宿主额外按钮 */}
      <div
        className={`${drag} flex items-center pl-3 pr-2 pb-2 ${topPad} transition-opacity duration-200 ${dim ? 'opacity-30 hover:opacity-100' : ''}`}
      >
        <h1 className="text-[13px] font-medium text-text-tertiary tracking-wide uppercase">
          {title ?? t('sidebar.title')}
        </h1>
        <div className={`${noDrag} ml-auto flex items-center`}>
          <button
            onClick={() => void onOpenFolder()}
            title={t('sidebar.newProject')}
            className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
          >
            <FolderPlus size={14} />
          </button>
          {titleActions}
        </div>
      </div>

      {/* 会话列表（或宿主正文替换，如日历视图） */}
      <div className="flex-1 overflow-y-auto pl-2 pr-1 py-1 no-scrollbar">
        {bodyOverride ? (
          bodyOverride
        ) : isEmpty ? (
          <div className="px-3 py-8 text-center text-text-tertiary text-xs">
            {t('sidebar.emptyHint')}
          </div>
        ) : (
          <ProjectSessionGroups
            projects={projects}
            collapsed={collapsedGroups}
            onToggleGroup={toggleGroup}
            onNewChat={(pid) => void handleNewChat(pid)}
            onSelect={onSelectSession}
            onDelete={onDeleteSession}
            onEditProject={onEditProject}
            onConfigureSession={onConfigureSession}
            caps={{ pin: caps.pin, badges: caps.badges }}
            pinnedSessionIds={pinnedSessionIds}
          />
        )}
      </div>

      {/* 归档项目（恢复 / 删除）：固定底部，列表在上、标题在下 → 自下而上展开 */}
      {!bodyOverride && archivedProjects.length > 0 && (
        <div
          className={`flex-shrink-0 border-t border-border-secondary/30 px-2 pt-1 transition-opacity duration-200 ${dim ? 'opacity-30 hover:opacity-100' : ''}`}
        >
          <AnimatedCollapse open={!collapsedGroups.has(ARCHIVED_GROUP_KEY)}>
            <div className="ml-1.5 pl-0.5 max-h-48 overflow-y-auto no-scrollbar">
              {archivedProjects.map((p) => (
                <div
                  key={p.id}
                  className="group relative flex items-center gap-1.5 pl-2.5 pr-1.5 py-0.5 text-text-secondary"
                  onContextMenu={(e) => openArchivedMenu(p.id, p.name, e)}
                >
                  <FolderClosed size={11} className="flex-shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-[13px] group-hover:pr-12">
                    {p.name}
                  </span>
                  <div className="absolute right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => void handleRestoreProject(p.id)}
                      className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary/60 hover:text-text-secondary"
                      title={t('sidebar.restoreProject')}
                    >
                      <RotateCcw size={11} className="text-green-400/70" />
                    </button>
                    {onDeleteProject && (
                      <button
                        onClick={() => onDeleteProject(p.id, p.name)}
                        className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary/60 hover:text-red-400"
                        title={t('sidebar.deleteProject')}
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </AnimatedCollapse>
          <div className="flex items-center w-full px-1.5 py-0.5 text-[12px]">
            <button
              onClick={() => toggleGroup(ARCHIVED_GROUP_KEY)}
              className="flex items-center gap-1.5 flex-1 min-w-0 text-text-secondary hover:text-text-primary transition-colors"
            >
              <Archive size={11} className="flex-shrink-0" />
              <span className="truncate font-medium uppercase tracking-wider">
                {t('sidebar.archivedProjects')}
              </span>
              <ChevronUp
                size={11}
                className={`ml-auto flex-shrink-0 text-text-tertiary/60 transition-transform ${collapsedGroups.has(ARCHIVED_GROUP_KEY) ? '' : 'rotate-180'}`}
              />
            </button>
          </div>
        </div>
      )}

      {/* 底部设置栏 + 宿主额外按钮（桌面更新提示） */}
      <div
        className={`flex items-center gap-1 px-2 py-1 border-t border-border-secondary/30 transition-opacity duration-200 ${dim ? 'opacity-30 hover:opacity-100' : ''}`}
      >
        <button
          onClick={() => onOpenSettings()}
          className="flex items-center gap-2 flex-1 pl-3 pr-2 py-1.5 rounded-md text-[13px] text-text-tertiary hover:bg-bg-hover/60 hover:text-text-secondary transition-colors"
        >
          <Settings size={14} className="text-text-tertiary/70" />
          <span>{t('sidebar.settings')}</span>
        </button>
        {footerActions}
      </div>

      {overlays}
    </div>
  )
}
