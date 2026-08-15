import type { ReactNode } from 'react'
import { Conversation, useChatStore } from '@shuvix/chat-ui'
import { useSessionPanelTool } from '../panel/SessionPanel'
import { ChatHeader, type ChatHeaderCaps } from './ChatHeader'

/**
 * ChatBody —— 聊天主视图正文外壳（桌面/WebUI/扩展共用）。
 *
 * 组合 ChatHeader + 横幅插槽 + 「欢迎 / 笔记本 / 对话」三态切换 + 浮层插槽，
 * 由 store 单一来源派生 activeSessionId / notebookPath（杜绝各宿主各自派生导致的漂移）。
 * notebookPath 为相对路径，交宿主 renderNotebook 注入媒体解析/caps 后渲染；
 * 后端按 sessionId 解析工作目录，故切换项目时不依赖全局 projectPath（避免路径解析竞态）。
 *
 * 宿主差异全部走 props / 插槽：
 *   - headerCaps / rightActions / onOpenSessionConfig —— 顶栏能力与右侧按钮簇
 *   - banner —— 顶栏与正文间横幅（桌面 StatusBanner；为空不渲染）
 *   - sessionToolbar —— 会话工具栏（悬浮于正文右上角；有活跃会话且未被 contentOverride 替换时渲染）
 *   - sessionPanel —— 会话面板（正文区右侧悬浮卡片列，顶栏/横幅之下；渲染条件同 sessionToolbar）
 *   - overlays —— 正文之后的浮层（桌面 SessionConfigDialog 等）
 *   - contentOverride —— 整体替换正文（桌面悬浮窗 placeholder 占位）
 *   - welcome —— 无活跃会话时的欢迎视图
 *   - renderNotebook —— 笔记本会话正文（宿主注入媒体解析器/caps）
 *   - conversationEmptyState —— 普通会话空态（可选）
 */
export interface ChatBodyProps {
  /** 顶栏能力开关（窗口拖拽 / 改名 / 工作目录 / 会话设置齿轮） */
  headerCaps?: ChatHeaderCaps
  /** 顶栏高度类（桌面 macOS 为交通灯留高传 h-10；默认 h-8） */
  headerHeightClassName?: string
  /** 点击会话设置齿轮（宿主据此打开自己的弹窗） */
  onOpenSessionConfig?: () => void
  /** 顶栏右侧按钮簇（宿主专属：pin/悬浮/浏览器/侧栏开关 …） */
  rightActions?: ReactNode
  /** 顶栏与正文之间的横幅插槽（为空不渲染） */
  banner?: ReactNode
  /** 会话工具栏 —— 与当前会话绑定的工具入口，悬浮于正文右上角（横幅之下）。
   *  仅在有活跃会话且正文未被 contentOverride 替换时渲染 */
  sessionToolbar?: ReactNode
  /** 会话面板 —— 正文区右侧的悬浮卡片列（顶栏/横幅之下，与对话并排、对话收缩让位），
   *  如桌面会话 Files 面板。渲染条件同 sessionToolbar；开关/宽度状态由宿主拥有 */
  sessionPanel?: ReactNode
  /** 正文之后的浮层插槽（宿主弹窗，如会话配置对话框） */
  overlays?: ReactNode
  /** 正文整体替换（如桌面悬浮窗 placeholder）；非空时不渲染欢迎/笔记本/对话 */
  contentOverride?: ReactNode
  /** 无活跃会话时的欢迎视图 */
  welcome: ReactNode
  /** 笔记本会话正文渲染（宿主注入媒体解析/caps）；入参为相对 notebookPath + sessionId */
  renderNotebook: (notebookPath: string, sessionId: string) => ReactNode
  /** 普通会话空态（如桌面 EmptySessionHint）；缺省用 Conversation 内置提示 */
  conversationEmptyState?: (sessionId: string) => ReactNode
  /** 根容器类（宿主按布局上下文传：桌面 h-full；扩展 flex-1 min-w-0 …） */
  className?: string
}

export function ChatBody({
  headerCaps,
  headerHeightClassName,
  onOpenSessionConfig,
  rightActions,
  banner,
  sessionToolbar,
  sessionPanel,
  overlays,
  contentOverride,
  welcome,
  renderNotebook,
  conversationEmptyState,
  className = 'relative flex flex-col h-full'
}: ChatBodyProps): React.JSX.Element {
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const sessions = useChatStore((s) => s.sessions)
  // 笔记本会话：绑定 md 的相对路径（非空即渲染 live-preview 而非对话）
  const notebookPath = sessions.find((s) => s.id === activeSessionId)?.settings.notebookPath ?? null

  const content =
    contentOverride ??
    (!activeSessionId ? (
      welcome
    ) : notebookPath ? (
      renderNotebook(notebookPath, activeSessionId)
    ) : (
      <Conversation
        sessionId={activeSessionId}
        emptyState={conversationEmptyState?.(activeSessionId)}
      />
    ))

  // 会话工具栏 / 会话侧栏只在「有活跃会话且正文未被替换」时出现（欢迎页 / 悬浮占位不渲染）
  const sessionUiVisible = !!activeSessionId && !contentOverride
  // 面板展开时对话列滚动条紧贴面板左缘 → 给对话列挂 chat-scroll-inset，把滚动条轨道
  // 按卡片的上下留白内缩（见 base.css），避免滑块滚到两端探出卡片圆角
  const panelOpen = useSessionPanelTool(activeSessionId) !== null
  const scrollInset = sessionUiVisible && !!sessionPanel && panelOpen

  return (
    <div className={className}>
      <ChatHeader
        caps={headerCaps}
        heightClassName={headerHeightClassName}
        onOpenSessionConfig={onOpenSessionConfig}
        rightActions={rightActions}
      />
      {banner}
      {/* 正文行：左为正文列，右为可选会话面板（悬浮卡片）列 —— 顶栏/横幅保持整宽横贯。
          两列均不设 relative：压缩遮罩 absolute inset-0 仍锚定根容器、罩住整个正文外壳 */}
      <div className="flex flex-1 min-h-0">
        <div className={`flex flex-col flex-1 min-w-0${scrollInset ? ' chat-scroll-inset' : ''}`}>
          {sessionUiVisible && sessionToolbar && (
            // 零高锚点：不占布局空间，工具栏悬浮于其下方正文的右上角
            <div className="relative z-30 h-0 flex-shrink-0">
              <div className="absolute right-4 top-2">{sessionToolbar}</div>
            </div>
          )}
          {content}
        </div>
        {sessionUiVisible ? sessionPanel : null}
      </div>
      {overlays}
    </div>
  )
}
