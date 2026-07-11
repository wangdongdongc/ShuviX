import type { ReactNode } from 'react'
import { Conversation, useChatStore } from '@shuvix/chat-ui'
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
  /** 点击顶栏「打开文件面板」按钮（宿主据此打开右侧 Files 面板）；配合 headerCaps.folder 显示 */
  onOpenFiles?: () => void
  /** 顶栏右侧按钮簇（宿主专属：pin/悬浮/浏览器/侧栏开关 …） */
  rightActions?: ReactNode
  /** 顶栏与正文之间的横幅插槽（为空不渲染） */
  banner?: ReactNode
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
  onOpenFiles,
  rightActions,
  banner,
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

  return (
    <div className={className}>
      <ChatHeader
        caps={headerCaps}
        heightClassName={headerHeightClassName}
        onOpenSessionConfig={onOpenSessionConfig}
        onOpenFiles={onOpenFiles}
        rightActions={rightActions}
      />
      {banner}
      {content}
      {overlays}
    </div>
  )
}
