import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Eye, FolderTree, ListTodo, X, Gavel } from 'lucide-react'
import {
  useChatStore,
  useSubAgentCount,
  useBgTaskCount,
  useBgTaskRunningCount
} from '@shuvix/chat-ui'
import { useFocusDim } from '../sidebar/useFocusDim'
import { SubAgentPanel } from '../subagent/SubAgentPanel'
import { usePreviewPanelStore } from '../preview/previewPanelStore'
import { BgTaskPanel } from './BgTaskPanel'
import { useSessionPanelStore, type SessionPanelTool } from './sessionPanelStore'

/**
 * 会话面板（桌面 / 扩展共用）—— 经 ChatBody 的 sessionToolbar / sessionPanel 插槽注入：
 *
 *   - SessionToolbar：状态横幅右侧的工具入口组，仅面板收起时显示（展开后隐藏，
 *     切换/收起入口移交面板头部 tabs）。Files 常驻；Preview 仅在宿主注入（showPreview）
 *     **且存在预览目标**时出现（与 Sub-agent 同款「有内容才显示」语义）；Sub-agent 仅当前
 *     会话有子会话时出现（含数量徽标）。点按展开面板并切到该工具。
 *   - SessionPanel：正文区右侧的悬浮卡片（四周留白 + 圆角 + 边框 + 投影，布局上与对话并排、
 *     对话收缩让位）。头部为工具 tabs（与工具栏同一入口列表），点按切换、X 收起。
 *     装载 Files / Preview / Sub-agent / 后台任务，展开期间各工具均保持挂载、visibility 切换
 *     （保住预览/手风琴等临时 UI 态）；收起时整体卸载（避免后台文件扫描）。
 *
 * 注：运行时 Agent 快照（系统提示词 / 已装载工具 / 模型细节）不在这里 —— 它归桌面设置页的
 * 「监视器 → 智能体」，那页覆盖进程内**全部** agent（含派生），而不只是当前会话这一个。
 *
 * 宿主差异经 props / 外层注入：files 内容整体注入（filesContent —— 桌面为 FilesPanel + 桌面
 * caps，扩展为 FSA 权限门控包装）；preview 内容可选注入（previewContent —— 无 app 级右侧
 * 面板的宿主（桌面悬浮窗 / 扩展）注入共享 PreviewPanel；桌面主窗预览在右侧面板，不注入）；
 * 媒体 URL 解析由宿主在外层包 MediaUrlProvider。
 * 状态在共享 useSessionPanelStore（按会话记忆）；宽度持久化由宿主在 store 外接。
 */

/**
 * 展示工具（含兜底）：面板停在 Sub-agent 但子会话已清空（Bot 按钮随之隐藏）→ 回落到 Files；
 * 停在 Preview 但预览目标已关闭（Eye 按钮随之隐藏）→ 同样回落到 Files；
 * 停在后台任务但任务已清空（ListTodo 按钮随之隐藏）→ 同样回落到 Files。
 */
export function useSessionPanelTool(sessionId: string | null): SessionPanelTool | null {
  const openTool = useSessionPanelStore((s) =>
    sessionId ? (s.openBySession[sessionId] ?? null) : null
  )
  const subAgentCount = useSubAgentCount(sessionId)
  const hasPreviewTarget = usePreviewPanelStore((s) => s.target !== null)
  const taskCount = useBgTaskCount(sessionId)
  if (openTool === 'subagent' && subAgentCount === 0) return 'files'
  if (openTool === 'preview' && !hasPreviewTarget) return 'files'
  if (openTool === 'tasks' && taskCount === 0) return 'files'
  return openTool
}

/**
 * 揭示信号 → 会话面板（宿主常驻组件内调用一次；面板收起时内容未挂载，故须在此消费）：
 *   - filePreviewRequest（仅 previewInPanel=true 的宿主）→ 展开并切到 Preview ——
 *     预览目标本身由宿主经 usePreviewRequestBridge 落入共享 usePreviewPanelStore；
 *     桌面主窗预览在 app 级右侧面板（useRightPanelBridge 揭示），不传此标志。
 * （Sub-agent tab 不再自动揭示 —— 子会话经工具栏胶囊的数量徽标可见，由用户手动打开。）
 * 信号含单调 nonce，重复触发同样生效。enabled=false 时忽略（如 WebUI / 悬浮占位态）。
 */
export function useSessionPanelReveal(enabled = true, previewInPanel = false): void {
  const filePreviewRequest = useChatStore((s) => s.filePreviewRequest)
  useEffect(() => {
    if (!enabled || !previewInPanel || !filePreviewRequest) return
    const sid = useChatStore.getState().activeSessionId
    if (sid) useSessionPanelStore.getState().show(sid, 'preview')
  }, [filePreviewRequest, enabled, previewInPanel])
}

interface SessionPanelToolItem {
  tool: SessionPanelTool
  Icon: typeof FolderTree
  label: string
  badge?: number
}

/**
 * 面板工具入口列表（工具栏胶囊与面板头部 tabs 共用同一来源）：Files 常驻；
 * Preview 仅宿主注入且存在预览目标时出现；Sub-agent 仅有子会话时出现（含数量徽标）。
 */
function useSessionPanelToolItems(
  sessionId: string | null,
  includePreview: boolean,
  includeBotDecisions = false
): SessionPanelToolItem[] {
  const { t } = useTranslation()
  const subAgentCount = useSubAgentCount(sessionId)
  const hasPreviewTarget = usePreviewPanelStore((s) => s.target !== null)
  const taskCount = useBgTaskCount(sessionId)
  const runningTaskCount = useBgTaskRunningCount(sessionId)
  return [
    { tool: 'files', Icon: FolderTree, label: t('panel.files') },
    ...(includePreview && hasPreviewTarget
      ? [{ tool: 'preview' as const, Icon: Eye, label: t('panel.previewTab') }]
      : []),
    ...(subAgentCount > 0
      ? [{ tool: 'subagent' as const, Icon: Bot, label: t('panel.subAgent'), badge: subAgentCount }]
      : []),
    // 聊天会话专属（宿主注入内容才出现）：「这个 bot 为什么没说话」的用户侧出口（设计 §9）
    ...(includeBotDecisions
      ? [{ tool: 'botDecisions' as const, Icon: Gavel, label: t('panel.botDecisions') }]
      : []),
    // 用 ListTodo：Terminal 已被 ssh 的运行时指示器占用，Bot 是 Sub-agent 的，同栏必须一眼分得开。
    // 徽标取「运行中」数而非总数 —— 全跑完之后 tab 仍在（用户还要看日志），但不该继续挂个数字
    ...(taskCount > 0
      ? [
          {
            tool: 'tasks' as const,
            Icon: ListTodo,
            label: t('panel.tasks'),
            badge: runningTaskCount
          }
        ]
      : [])
  ]
}

/**
 * 会话工具栏（状态横幅右侧）—— 面板收起与展开时**同一处**的工具入口：
 *   - 收起：仅图标，点按展开并切到该工具；
 *   - 展开：即面板的 tabs（当前工具带文字）+ 收起按钮 —— 面板卡片自身不再有头部，
 *     开合面板时这排控件原地变形，而不是从卡片头部跳到横幅、或反过来。
 */
export function SessionToolbar({
  sessionId,
  showPreview = false,
  showBotDecisions = false
}: {
  sessionId: string | null
  /** 是否显示 Preview 工具入口（与 SessionPanel 的 previewContent 注入配套） */
  showPreview?: boolean
  /** 是否显示 Bot 决策工具入口（与 SessionPanel 的 botDecisionsContent 注入配套；聊天会话专属） */
  showBotDecisions?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const openTool = useSessionPanelTool(sessionId)
  const tools = useSessionPanelToolItems(sessionId, showPreview, showBotDecisions)
  // 专注模式淡化：与顶栏/侧栏/面板页签同一套判定与手感（悬浮即恢复不透明）。
  // 注意 hook 必须在下面的早退之前调用。
  const { dim } = useFocusDim()
  if (!sessionId) return null

  // 与 SessionPanel 同款兜底：停在 Preview 但宿主没注入 previewContent → 实际显示的是 Files
  const activeTool = openTool === 'preview' && !showPreview ? 'files' : openTool

  return (
    <div
      className={`flex items-center gap-0.5 transition-opacity duration-200 ${
        dim ? 'opacity-30 hover:opacity-100' : ''
      }`}
    >
      {tools.map(({ tool, Icon, label, badge }) => {
        const active = tool === activeTool
        return (
          <button
            key={tool}
            data-session-tool={tool}
            onClick={() =>
              openTool
                ? useSessionPanelStore.getState().show(sessionId, tool)
                : useSessionPanelStore.getState().toggle(sessionId, tool)
            }
            className={`flex items-center gap-1 min-w-0 px-1 h-6 rounded-md text-xs font-medium transition-colors ${
              active
                ? 'text-accent bg-accent/10'
                : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50'
            }`}
            title={label}
          >
            <Icon size={14} className="flex-shrink-0" />
            {active && <span className="truncate">{label}</span>}
            {badge !== undefined && badge > 0 && (
              <span className="text-[10px] tabular-nums">{badge}</span>
            )}
          </button>
        )
      })}
      {openTool && (
        <button
          onClick={() => useSessionPanelStore.getState().close(sessionId)}
          className="flex items-center p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors flex-shrink-0"
          title={t('common.close')}
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
}

export interface SessionPanelProps {
  sessionId: string | null
  /** Files 工具的内容（宿主装配：桌面 FilesPanel + 桌面 caps；扩展 FSA 权限门控 + FilesPanel） */
  filesContent: ReactNode
  /** Preview 工具的内容（可选注入：桌面悬浮窗 / 扩展传共享 PreviewPanel；桌面主窗不传 —— 预览在右侧面板） */
  previewContent?: ReactNode
  /** Bot 决策工具的内容（可选注入：桌面对聊天会话传；缺省该工具页不出现） */
  botDecisionsContent?: ReactNode
}

/** 会话面板卡片本体 —— 收起（或无会话）时渲染 null */
export function SessionPanel({
  sessionId,
  filesContent,
  previewContent,
  botDecisionsContent
}: SessionPanelProps): React.JSX.Element | null {
  const rawTool = useSessionPanelTool(sessionId)
  const width = useSessionPanelStore((s) => s.width)
  if (!sessionId || !rawTool) return null

  // 兜底：面板停在宿主未注入内容的工具页（不该发生 / 切到了非聊天会话）→ 回落到 Files
  const tool =
    (rawTool === 'preview' && !previewContent) ||
    (rawTool === 'botDecisions' && !botDecisionsContent)
      ? 'files'
      : rawTool

  return (
    // 外层：占位列（宽度参与 flex 布局），右/下留白让卡片「悬浮」；上留白略小使其贴近顶栏工具区。
    // 左侧刻意不留白：那道缝会把对话列的滚动条卡在「正文与面板之间」悬空一条，
    // 卡片左缘直接贴住对话列右缘后，滚动条紧靠面板描边（与面板收起时贴窗口右缘同一观感）。
    // 下留白 pb-2 = 8px，与输入框悬浮卡片的容器留白（InputArea 的 p-2）一致 —— 两张卡片底边齐平。
    <div
      className="relative flex-shrink-0 min-w-[200px] max-w-[calc(100%-320px)] pr-2.5 pt-1 pb-2"
      style={{ width }}
    >
      <ResizeHandle />
      {/*
        卡片本体：圆角 + 边框 + 投影；overflow-hidden 让内部内容随圆角裁切。

        底色对齐对话正文：面板内**整个子树**把 bg-primary / bg-secondary 两个 token 对调 ——
        各工具页一直用 bg-bg-secondary 当底、bg-bg-primary 当其上的凸起面（卡片/输入框/代码块），
        这里换掉变量即可让「底 = 主窗口色（theme-bg-primary）、凸起面 = 原来的灰（theme-bg-secondary）」，
        层级关系与透明度变体（/40、/60…经 color-mix 解析同一变量）全部自动跟随，改一处即可整体回退。
        注意：本子树内读 bg-bg-secondary 拿到的是主窗口色，bg-bg-primary 才是凸起面。
      */}
      <div
        // 底色与正文同色后，卡片边界全靠这圈描边：border-secondary/60 在 one-dark 下与底只差
        // 4.8/255（几乎看不见），故提到 border-primary/60 —— 最弱主题也有 18/255，与浅色主题原先的观感齐平
        // 投影与输入框悬浮卡片同款 shadow-md；向左的弥散（会糊在紧贴的滚动条上把滑块压深）
        // 由 clipPath 在左缘一刀切干净（见 style），使滑块底色与面板收起时逐字节相同。
        // 左描边单独降到 /40 —— 与对话列滑块同一色同一透明度（.thin-scrollbar 也是
        // border-primary 40%），两者紧贴时合成一条粗细均匀的淡边，而不是「淡滑块 + 深描边」
        // 叠出一条更重的线（那正是面板一开滚动条就显得变粗变深的原因）。
        // -ml-px：左描边压在滚动条槽最右 1px 上（卡片是后序兄弟，画在对话列之上），
        // 于是「滑块 + 描边」合起来仍是 4px —— 与面板收起时的滚动条等宽，开面板不再让它变粗
        className="session-panel-card -ml-px flex flex-col h-full rounded-xl border border-border-primary/60 border-l-border-primary/40 bg-bg-secondary shadow-md overflow-hidden"
        style={
          {
            '--color-bg-primary': 'var(--theme-bg-secondary)',
            '--color-bg-secondary': 'var(--theme-bg-primary)',
            // 左缘齐切、其余三边放开 40px：位移+负 spread 只能压住投影的实心部分，
            // 高斯尾巴仍会往左扫出十几像素的 1~3/255 灰，正好落在紧贴的滚动条上把它压深。
            // clip-path 按边框盒裁切（含 box-shadow），右/上/下的浮起感原样保留。
            clipPath: 'inset(-40px -40px -40px 0)'
          } as React.CSSProperties
        }
      >
        {/* 内容区 —— 各工具共存，visibility 切换（tabs / 收起在状态横幅右侧，卡片自身无头部） */}
        <div className="flex-1 min-h-0 relative">
          <div
            className="absolute inset-0"
            style={tool === 'files' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
          >
            {filesContent}
          </div>
          {previewContent !== undefined && (
            <div
              className="absolute inset-0"
              style={
                tool === 'preview' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
              }
            >
              {previewContent}
            </div>
          )}
          <div
            className="absolute inset-0"
            style={
              tool === 'subagent' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
            }
          >
            <SubAgentPanel />
          </div>
          {botDecisionsContent !== undefined && (
            <div
              className="absolute inset-0"
              style={
                tool === 'botDecisions'
                  ? undefined
                  : { visibility: 'hidden', pointerEvents: 'none' }
              }
            >
              {botDecisionsContent}
            </div>
          )}
          <div
            className="absolute inset-0"
            style={tool === 'tasks' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
          >
            <BgTaskPanel sessionId={sessionId} />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 占位列左缘拖拽条 —— 向左拖增宽（面板贴对话区右侧）。
 * 命中区贴着卡片左缘往内 6px（无可见高亮，仅 col-resize 光标提示）：
 * 刻意不外扩到卡片之外，否则会盖住紧邻的对话列滚动条、抢走拖动。
 * 宽度经共享 store 钳制；持久化由宿主外接。
 */
function ResizeHandle(): React.JSX.Element {
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: useSessionPanelStore.getState().width }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent): void => {
      if (!dragRef.current) return
      const delta = dragRef.current.startX - ev.clientX
      useSessionPanelStore.getState().setWidth(dragRef.current.startW + delta)
    }
    const onUp = (): void => {
      dragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  return (
    <div
      className="absolute inset-y-2 left-0 w-[6px] cursor-col-resize z-20"
      onMouseDown={onMouseDown}
    />
  )
}
