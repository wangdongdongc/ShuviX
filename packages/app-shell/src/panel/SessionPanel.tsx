import { useCallback, useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, Layers, Shapes } from 'lucide-react'
import { useChatStore, useBgTaskCount, useBgTaskRunningCount } from '@shuvix/chat-ui'
import { BgTaskPanel } from './BgTaskPanel'
import { ArtifactsPanel } from './ArtifactsPanel'
import { useSessionArtifactCount } from './sessionArtifacts'
import { useSessionPanelStore, type SessionPanelTool } from './sessionPanelStore'
import { startPanelDrag } from '../common/panelDrag'

/**
 * 会话面板（桌面 / 扩展共用）—— 经 ChatBody 的 sessionToolbar / sessionPanel 插槽注入：
 *
 *   - SessionToolbar：顶栏右侧按钮簇里的工具入口组（在窗口控制那一簇左侧、以竖线分隔），
 *     同时就是面板的标签栏。Files 常驻；任务仅当前会话有后台任务时出现（含数量徽标）；
 *     产物仅当前会话（或它的子会话）有产物时出现。点一个没开着的 → 展开并切到它；
 *     点开着的那个 → 收起面板。
 *     （文件预览不在面板里 —— 桌面统一开独立窗口。）
 *   - SessionPanel：正文区右侧的一列（与对话并排、对话收缩让位），外观同 app 级右侧面板：
 *     平铺到底、与正文同色，只靠左、上两道细线与对话和顶栏分开；没有圆角、投影、留白，
 *     也没有自己的收起按钮 —— 顶栏里那枚带下划线的标签就是它的开关。
 *     装载 Files / 后台任务 / 产物，展开期间各工具均保持挂载、visibility 切换
 *     （保住手风琴等临时 UI 态）；收起时整体卸载（避免后台文件扫描）。
 *
 * 注：运行时 Agent 快照（系统提示词 / 已装载工具 / 模型细节）不在这里 —— 它归桌面设置页的
 * 「监视器 → 智能体」，那页覆盖进程内**全部** agent（含派生），而不只是当前会话这一个。
 *
 * 宿主差异经 props / 外层注入：files 内容整体注入（filesContent —— 桌面为 FilesPanel + 桌面
 * caps，扩展为 FSA 权限门控包装）；媒体 URL 解析由宿主在外层包 MediaUrlProvider。
 * 状态在共享 useSessionPanelStore（按会话记忆）；宽度持久化由宿主在 store 外接。
 */

/**
 * 展示工具（含兜底）：停在后台任务但任务已清空（任务按钮随之隐藏）→ 回落到 Files；停在产物但
 * 一件都没有（还没取到，或产物随子会话一起删了）同样回落。
 * 'subagent' 是已并入 tasks 的旧值（按会话记忆的 store 里可能还留着）→ 一并接到 tasks。
 */
export function useSessionPanelTool(sessionId: string | null): SessionPanelTool | null {
  const openTool = useSessionPanelStore((s) =>
    sessionId ? (s.openBySession[sessionId] ?? null) : null
  )
  const taskCount = useBgTaskCount(sessionId)
  const artifactCount = useSessionArtifactCount(sessionId)
  const tool = openTool === 'subagent' ? 'tasks' : openTool
  if (tool === 'tasks' && taskCount === 0) return 'files'
  if (tool === 'artifacts' && artifactCount === 0) return 'files'
  return tool
}

/**
 * 揭示信号 → 会话面板（宿主常驻组件内调用一次；面板收起时内容未挂载，故须在此消费）。
 * （Sub-agent tab 不再自动揭示 —— 子会话经工具栏胶囊的数量徽标可见，由用户手动打开；
 * 文件预览也不进面板 —— 桌面统一开独立窗口。）
 * 信号含单调 nonce，重复触发同样生效。enabled=false 时忽略（如 WebUI / 悬浮占位态）。
 */
export function useSessionPanelReveal(enabled = true): void {
  // 任务揭示：对话流里那张工具卡的行尾状态被点了 —— 派生 agent 的转写在面板里，
  // 这是从卡片回到转写的唯一一条路，所以这一条**主动揭示**（与 Sub-agent 旧 tab 不同）
  const taskRevealRequest = useChatStore((s) => s.taskRevealRequest)
  useEffect(() => {
    if (!enabled || !taskRevealRequest) return
    const sid = useChatStore.getState().activeSessionId
    if (sid) useSessionPanelStore.getState().show(sid, 'tasks')
  }, [taskRevealRequest, enabled])

  // 产物揭示：对话里一个引用块上的「已有新版」被点了 —— 切到产物页，面板据它展开那一件
  const artifactRevealRequest = useChatStore((s) => s.artifactRevealRequest)
  useEffect(() => {
    if (!enabled || !artifactRevealRequest) return
    const sid = useChatStore.getState().activeSessionId
    if (sid) useSessionPanelStore.getState().show(sid, 'artifacts')
  }, [artifactRevealRequest, enabled])
}

interface SessionPanelToolItem {
  tool: SessionPanelTool
  Icon: typeof Folder
  label: string
  badge?: number
}

/**
 * 面板工具入口列表（工具栏胶囊与面板头部 tabs 共用同一来源）：Files 常驻；
 * 任务仅在本会话有任务时出现（含运行中数量徽标）；产物仅在本会话或它的子会话有产物时出现
 * （不挂数字：件数不是要你去处理的东西）。
 *
 * 原先并列的 Sub-agent 入口已并入任务 —— 派生 agent 是后台任务的一类，
 * 与 bash、子会话同列一张表（见 BgTaskPanel）。
 */
function useSessionPanelToolItems(sessionId: string | null): SessionPanelToolItem[] {
  const { t } = useTranslation()
  const taskCount = useBgTaskCount(sessionId)
  const runningTaskCount = useBgTaskRunningCount(sessionId)
  const artifactCount = useSessionArtifactCount(sessionId)
  return [
    { tool: 'files', Icon: Folder, label: t('panel.files') },
    // Shapes（几样图形）：产物多半是图，也有草稿、表格 —— 不用 Package（内置项的标记）也不用 FileText（太像 Files）
    ...(artifactCount > 0
      ? [{ tool: 'artifacts' as const, Icon: Shapes, label: t('panel.artifacts') }]
      : []),
    // 用 Layers（一摞后台任务）：Terminal 已被 ssh 的运行时指示器占用、Activity 是右侧面板 Agents 页签，同一窗口必须一眼分得开。
    // 徽标取「运行中」数而非总数 —— 全跑完之后 tab 仍在（用户还要看日志），但不该继续挂个数字
    ...(taskCount > 0
      ? [
          {
            tool: 'tasks' as const,
            Icon: Layers,
            label: t('panel.tasks'),
            badge: runningTaskCount
          }
        ]
      : [])
  ]
}

/**
 * 会话工具栏（顶栏右侧）—— 会话面板的标签栏，开、切、关都在这一处：
 *   - 面板收起：仅图标，点按展开并切到该工具；
 *   - 面板展开：当前工具带文字，底下一道 accent 下划线（与右侧面板 PanelTabBar 同一记号）；
 *     点别的工具切过去，再点当前这个收起面板。
 *
 * 下划线画在**顶栏的底边**上（根节点与按钮都撑满顶栏高度）：面板的上边线正从那里起，
 * 于是「标签 + 下划线 + 面板」读起来是一件东西，面板自己不必再长一个收起按钮。
 * 撑满靠 ChatHeader 的 rightActions 容器 self-stretch；宿主若把它放进别的不撑高的容器，
 * 下划线就贴在按钮自己的底边，仍然成立。
 *
 * 宿主把它放进 ChatHeader 的 rightActions（原先挂在状态横幅右侧，为它单占一行）；
 * 专注模式的淡化因此由顶栏整体负责 —— 这里再叠一层 opacity 会与顶栏相乘。
 */
export function SessionToolbar({
  sessionId
}: {
  sessionId: string | null
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const activeTool = useSessionPanelTool(sessionId)
  const tools = useSessionPanelToolItems(sessionId)
  if (!sessionId) return null

  return (
    <div className="flex items-stretch self-stretch gap-0.5">
      {tools.map(({ tool, Icon, label, badge }) => {
        const active = tool === activeTool
        return (
          <button
            key={tool}
            data-session-tool={tool}
            data-active={active ? '' : undefined}
            aria-pressed={active}
            // 关按「展示出来的工具」判，而不是 store 里记的那个：停在任务页但任务清空后展示的是
            // Files（见 useSessionPanelTool 的兜底），此时点 Files 应当收起，而不是先「切到 Files」空转一次
            onClick={() =>
              active
                ? useSessionPanelStore.getState().close(sessionId)
                : useSessionPanelStore.getState().show(sessionId, tool)
            }
            className="group relative flex items-center min-w-0"
            title={active ? t('panel.sessionPanelCollapse', { name: label }) : label}
          >
            <span
              className={`flex items-center gap-1 min-w-0 px-1 h-6 rounded-md text-xs font-medium transition-colors ${
                active
                  ? 'text-text-primary group-hover:bg-bg-hover/50'
                  : 'text-text-tertiary group-hover:text-text-secondary group-hover:bg-bg-hover/50'
              }`}
            >
              <Icon size={14} className="flex-shrink-0" />
              {active && <span className="truncate">{label}</span>}
              {badge !== undefined && badge > 0 && (
                <span className="text-[10px] tabular-nums">{badge}</span>
              )}
            </span>
            {active && (
              <span
                data-session-tool-underline=""
                className="absolute bottom-0 left-1 right-1 h-[2px] bg-accent rounded-t"
              />
            )}
          </button>
        )
      })}
    </div>
  )
}

export interface SessionPanelProps {
  sessionId: string | null
  /** Files 工具的内容（宿主装配：桌面 FilesPanel + 桌面 caps；扩展 FSA 权限门控 + FilesPanel） */
  filesContent: ReactNode
}

/** 会话面板本体 —— 收起（或无会话）时渲染 null */
export function SessionPanel({
  sessionId,
  filesContent
}: SessionPanelProps): React.JSX.Element | null {
  const tool = useSessionPanelTool(sessionId)
  const width = useSessionPanelStore((s) => s.width)
  if (!sessionId || !tool) return null

  return (
    /*
      平铺的一列：宽度参与 flex 布局，贴着顶栏底边、一直到正文区底，四周不留白。
      左、上两道线与 app 级右侧面板同一把尺：左线 = 它与对话之间那条分隔（border-secondary/50，
      对话列的滚动条就贴在这条线左边），上线 = 它标签栏的底线（border-secondary/30）——
      顶栏里当前工具的下划线正压在这条上线上。

      底色对齐对话正文：面板内**整个子树**把 bg-primary / bg-secondary 两个 token 对调 ——
      各工具页一直用 bg-bg-secondary 当底、bg-bg-primary 当其上的凸起面（卡片/输入框/代码块），
      这里换掉变量即可让「底 = 主窗口色（theme-bg-primary）、凸起面 = 原来的灰（theme-bg-secondary）」，
      层级关系与透明度变体（/40、/60…经 color-mix 解析同一变量）全部自动跟随，改一处即可整体回退。
      注意：本子树内读 bg-bg-secondary 拿到的是主窗口色，bg-bg-primary 才是凸起面。
    */
    <div
      data-session-panel=""
      className="session-panel relative flex flex-col flex-shrink-0 min-w-[200px] max-w-[calc(100%-320px)] border-l border-t border-l-border-secondary/50 border-t-border-secondary/30 bg-bg-secondary"
      style={
        {
          width,
          '--color-bg-primary': 'var(--theme-bg-secondary)',
          '--color-bg-secondary': 'var(--theme-bg-primary)'
        } as React.CSSProperties
      }
    >
      <ResizeHandle />
      {/* 内容区 —— 各工具共存，visibility 切换 */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        <div
          className="absolute inset-0"
          style={tool === 'files' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
        >
          {filesContent}
        </div>
        <div
          className="absolute inset-0"
          style={tool === 'tasks' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
        >
          {/* 按会话重挂：展开哪条、折叠与否都是那个会话的事，不该带到下一个会话里 */}
          <BgTaskPanel key={sessionId} sessionId={sessionId} />
        </div>
        <div
          className="absolute inset-0"
          style={tool === 'artifacts' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
        >
          <ArtifactsPanel key={sessionId} sessionId={sessionId} />
        </div>
      </div>
    </div>
  )
}

/**
 * 面板左缘拖拽条 —— 向左拖增宽（面板贴对话区右侧）。与右侧面板的分隔条同一手感：
 * 命中区从左边线起往面板内 6px，悬停 / 拖动时那条 1px 的线亮成 accent。
 * 刻意不外扩到面板之外，否则会盖住紧邻的对话列滚动条、抢走拖动。
 * 宽度经共享 store 钳制；持久化由宿主外接。拖动手势见 startPanelDrag（往左拖会经过对话里的 iframe）。
 */
function ResizeHandle(): React.JSX.Element {
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const startW = useSessionPanelStore.getState().width
    startPanelDrag(e, {
      axis: 'x',
      onMove: (delta) => useSessionPanelStore.getState().setWidth(startW - delta)
    })
  }, [])

  return (
    // -left-px：命中区盖住左边线本身（那 1px 是面板的，不是对话列的）
    <div
      className="group absolute inset-y-0 -left-px w-[7px] cursor-col-resize z-20"
      onMouseDown={onMouseDown}
    >
      <div className="absolute inset-y-0 left-0 w-px group-hover:bg-accent/40 group-active:bg-accent/60 transition-colors" />
    </div>
  )
}
