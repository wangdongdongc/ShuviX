import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings } from 'lucide-react'
import { getChatApi, useChatStore } from '@shuvix/chat-ui'
import { useFocusDim } from './useFocusDim'
import { ProjectSessionGroups, TEMP_GROUP_KEY } from './ProjectSessionGroups'
import { BotSessionDialog, type SidebarBotsAdapter } from './BotSessionDialog'
import type { ProjectMemoryAdapter } from './ProjectMemoryFolder'
import type { ProjectRef } from './useProjects'

export interface SidebarCaps {
  /** Electron 标题栏拖拽区 + macOS 顶部交通灯留白 */
  windowDrag?: boolean
  /** 会话项置顶（悬浮）徽标 */
  pin?: boolean
}

export interface SidebarProps {
  caps?: SidebarCaps
  /** 项目列表——由宿主经 useProjects() 提供，侧栏与日历视图共用同一份 */
  projects: ProjectRef[]
  /** 打开文件夹（宿主：选目录 → 建项目 → 新建会话；桌面 dialog，扩展 FSA）。建项目后经
   *  events 'project.changed' 自动刷新项目列表。入口：「项目」分节头的 ⋮ / 右键、空态提示、
   *  宿主菜单栏的「新建项目」—— 顶栏不再有那颗 + 按钮 */
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
  /** 已悬浮会话集合（caps.pin 时用于徽标 / 选中行为） */
  pinnedSessionIds?: Set<string>
  /** 标题行右侧额外按钮（桌面：视图切换） */
  titleActions?: React.ReactNode
  /** 底部设置栏右侧额外按钮（桌面：更新提示） */
  footerActions?: React.ReactNode
  /** 正文整体替换（桌面日历视图）；非空时不渲染分组列表与归档区 */
  bodyOverride?: React.ReactNode
  /** 分组列表前置插槽（桌面：知识库分组 WikiGroup，排在「项目」分节之上）；仅默认正文渲染，空态时也保留（功能入口） */
  groupsPrepend?: React.ReactNode
  /** 宿主弹窗插槽（项目编辑 / 会话配置 / 删除确认等） */
  overlays?: React.ReactNode
  /** 顶栏文案。不传则不渲染标题 —— 桌面端产品名 header 已退役（无实际用途）；
   *  扩展两种视图都显式传（sidebar.title / sidebar.viewCalendar） */
  title?: string
  /** 项目记忆能力（桌面注入；见 ProjectSessionGroupsProps.memory） */
  memory?: ProjectMemoryAdapter
  /** bots 能力（桌面注入 window.api.bot 的窄投影；扩展 v1 无 —— 缺省时 Bot 会话入口整体不渲染） */
  bots?: SidebarBotsAdapter
}

/**
 * 侧边栏（桌面/扩展共用）—— 按需顶栏（标题/宿主按钮/macOS 拖拽带）+ 知识库插槽 + 按项目分组的会话列表
 * （ProjectSessionGroups：「项目」与「临时对话」两个并列分节）+ 底部设置。
 * 项目/会话/事件经 getChatApi() 统一访问（宿主无关）；宿主差异走 caps + 注入回调/插槽：
 *   - 打开文件夹（dialog vs FSA）、打开设置、选中（悬浮聚焦）、右键菜单、删除项目均注入；
 *   - 视图切换 / 更新提示 / 弹窗经 titleActions / footerActions / overlays 插槽；
 *   - 日历视图经 bodyOverride 替换正文（桌面侧复用 ProjectSessionGroups 按天渲染）。
 */
export function Sidebar({
  caps = {},
  projects,
  onOpenFolder,
  onOpenSettings,
  onSelectSession,
  onDeleteSession,
  onConfigureSession,
  onEditProject,
  pinnedSessionIds,
  titleActions,
  footerActions,
  bodyOverride,
  groupsPrepend,
  overlays,
  title,
  memory,
  bots
}: SidebarProps): React.JSX.Element {
  const { t } = useTranslation()
  const { dim } = useFocusDim()
  const sessions = useChatStore((s) => s.sessions)

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const initialCollapseApplied = useRef(false)

  // 首次加载项目后默认折叠所有项目组；临时对话组保持展开 —— 它是最常用的落点
  useEffect(() => {
    if (initialCollapseApplied.current || projects.length === 0) return
    initialCollapseApplied.current = true
    const initial = new Set<string>(projects.map((p) => p.id))
    // 项目首次异步加载后只跑一次（initialCollapseApplied 守卫），非每渲染同步级联
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsedGroups(initial)
  }, [projects])

  // 建会话后的统一收尾：刷新列表、选中新会话、自动展开所在组
  const afterCreate = async (sessionId: string, projectId: string | null): Promise<void> => {
    useChatStore.getState().setSessions(await getChatApi().session.list())
    useChatStore.getState().setActiveSessionId(sessionId)
    const groupKey = projectId ?? TEMP_GROUP_KEY
    setCollapsedGroups((prev) => {
      if (!prev.has(groupKey)) return prev
      const next = new Set(prev)
      next.delete(groupKey)
      return next
    })
  }

  // 在指定项目下新建会话（统一经 getChatApi）
  const handleNewChat = async (projectId: string | null): Promise<void> => {
    const session = await getChatApi().session.create({ projectId: projectId ?? null })
    await afterCreate(session.id, projectId)
  }

  // Bot 会话：先弹成员多选（BotSessionDialog），确认后带 bots 创建
  const [botDialogFor, setBotDialogFor] = useState<{ projectId: string | null } | null>(null)

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

  const projectNamesEmpty = projects.length === 0
  const isEmpty = sessions.length === 0 && projectNamesEmpty
  const platform = getChatApi().app.platform
  // 拖拽带只在 macOS 有意义（hiddenInset 交通灯留白 + app-region: drag）；
  // Windows 是原生标题栏，app-region 惰性，留条空带纯属占位
  const needDragStrip = !!caps.windowDrag && platform === 'darwin'
  const drag = needDragStrip ? 'titlebar-drag' : ''
  const noDrag = needDragStrip ? 'titlebar-no-drag' : ''
  const topPad = needDragStrip ? 'pt-10' : 'pt-3'
  // 顶栏按需渲染：标题 / 宿主按钮 / 拖拽带任一存在才占位。
  // 桌面不传 title（产品名 header 退役）—— Windows 上整行消失；macOS 只留交通灯拖拽带
  const showHeader = title !== undefined || !!titleActions || needDragStrip

  return (
    <div className="flex flex-col h-full bg-bg-secondary/50">
      {/* 标题行（可选窗口拖拽区）+ 宿主额外按钮；打开文件夹在「项目」分节头的菜单里 */}
      {showHeader && (
        <div
          className={`${drag} flex items-center pl-3 pr-2 pb-2 ${topPad} transition-opacity duration-200 ${dim ? 'opacity-30 hover:opacity-100' : ''}`}
        >
          {/* 分节标题之下重一档的产品名/视图名；不 uppercase（"ShuviX" 不是全大写） */}
          {title !== undefined && (
            <h1 className="text-[13px] font-semibold text-text-secondary tracking-wide">{title}</h1>
          )}
          <div className={`${noDrag} ml-auto flex items-center`}>{titleActions}</div>
        </div>
      )}

      {/* 会话列表（或宿主正文替换，如日历视图） */}
      <div className="flex-1 overflow-y-auto pl-2 pr-1 py-1 no-scrollbar">
        {bodyOverride ? (
          bodyOverride
        ) : (
          <>
            {groupsPrepend}
            {isEmpty ? (
              // 空态提示本身就是那句「打开一个文件夹作为项目」—— 点它即打开文件夹
              // （此时分组列表整个不渲染，分节头那份菜单也就不在）
              <button
                onClick={() => void onOpenFolder()}
                className="w-full px-3 py-8 text-center text-text-tertiary hover:text-text-secondary text-xs transition-colors"
              >
                {t('sidebar.emptyHint')}
              </button>
            ) : (
              <ProjectSessionGroups
                projects={projects}
                collapsed={collapsedGroups}
                onToggleGroup={toggleGroup}
                onNewChat={(pid) => void handleNewChat(pid)}
                onNewBotChat={bots ? (pid) => setBotDialogFor({ projectId: pid }) : undefined}
                onSelect={onSelectSession}
                onDelete={onDeleteSession}
                onEditProject={onEditProject}
                onConfigureSession={onConfigureSession}
                projectsSection={{
                  // 上方有知识库插槽时才画分隔线（扩展没有插槽，线会贴在列表最顶上）
                  dividerAbove: !!groupsPrepend,
                  onNewProject: () => void onOpenFolder()
                }}
                caps={{ pin: caps.pin }}
                pinnedSessionIds={pinnedSessionIds}
                memory={memory}
              />
            )}
          </>
        )}
      </div>

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

      {bots && botDialogFor && (
        <BotSessionDialog
          projectId={botDialogFor.projectId}
          projectName={
            botDialogFor.projectId
              ? projects.find((p) => p.id === botDialogFor.projectId)?.name
              : undefined
          }
          bots={bots}
          onSubmit={async (names) => {
            const session = await getChatApi().session.create({
              projectId: botDialogFor.projectId,
              bots: names
            })
            await afterCreate(session.id, botDialogFor.projectId)
            return null
          }}
          onClose={() => setBotDialogFor(null)}
        />
      )}
    </div>
  )
}
