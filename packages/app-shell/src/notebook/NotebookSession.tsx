import { InputArea, useChatStore } from '@shuvix/chat-ui'
import { NotebookView, type NotebookViewProps } from './NotebookView'
import { useFocusDim } from '../sidebar/useFocusDim'

export type NotebookSessionProps = NotebookViewProps

/**
 * 笔记本会话中间区：live preview（NotebookView）+ 悬浮在底部的输入框（复用对话框 InputArea 的笔记本模式）。
 * 发送走 notebookPrompt：每次开启一次性子智能体，仅向其注入笔记本路径 + read 提示（正文由子代理自行读取）。
 * 顶栏复用对话框 ChatHeader（由宿主在本组件之上渲染）。模型/工具选择沿用 InputArea 的 Model/Tool Picker，
 * 写入会话配置 → 一次性子智能体继承（与普通会话子智能体一致）。
 */
export function NotebookSession({
  path,
  sessionId,
  caps
}: NotebookSessionProps): React.JSX.Element {
  // 专注模式：与普通会话输入框一致——淡化输入区，hover / 聚焦输入时点亮（同 Conversation 的包裹）
  const { dim } = useFocusDim()
  // 仅查看（WebUI 分享端）：笔记本只读，隐藏发送输入框（与普通会话一致）
  const viewOnly = useChatStore((s) => s.viewOnly)
  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <NotebookView path={path} sessionId={sessionId} caps={caps} />
      {/* 悬浮输入框：绝对贴底、背景透明不挡正文；发送走 notebookPrompt。仅查看下隐藏。 */}
      {!viewOnly && (
        <div
          className={`transition-opacity duration-200 ${
            dim ? 'opacity-30 hover:opacity-100 focus-within:opacity-100' : ''
          }`}
        >
          <InputArea notebook />
        </div>
      )}
    </div>
  )
}
