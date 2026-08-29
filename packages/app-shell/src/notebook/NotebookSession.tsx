import { useCallback, useRef } from 'react'
import {
  InputArea,
  PendingInputsDrawer,
  ThreadDrawer,
  useChatActions,
  useChatStore,
  selectPendingInputs
} from '@shuvix/chat-ui'
import { NotebookView, type NotebookViewProps } from './NotebookView'
import { useFocusDim } from '../sidebar/useFocusDim'

export type NotebookSessionProps = NotebookViewProps

/**
 * 笔记本会话中间区：live preview（NotebookView）为主界面 + 悬浮在底部的输入框卡片。
 *
 * 发送与普通会话同走 `agent.prompt` 主管线（根 Agent = notebook 基座档案）；对话不占满屏 ——
 * 经 InputArea 的 thread 插槽渲染成卡片顶部限高可折叠的对话抽屉（ThreadDrawer），
 * 待处理审批/询问经 accessory 插槽渲染在抽屉与输入区之间，且同样套可折叠外壳
 * （PendingInputsDrawer —— 两块限高区可分别折叠，不吃满屏）。
 * 顶栏复用对话框 ChatHeader（由宿主在本组件之上渲染）。
 */
export function NotebookSession({
  path,
  sessionId,
  caps
}: NotebookSessionProps): React.JSX.Element {
  // 专注模式：淡化输入区，hover / 聚焦时点亮；有待处理输入时不淡化（同 Conversation ——
  // Agent 正等用户回答，鼠标没悬浮也必须一眼看见）
  const { dim: focusDim } = useFocusDim()
  const hasPendingInputs = useChatStore((s) => selectPendingInputs(s).length > 0)
  const dim = focusDim && !hasPendingInputs
  const { handleInputResponse } = useChatActions(sessionId)
  // 悬浮输入卡片实高 → 根容器 CSS 变量：编辑器滚动区据此给文末让位（.cm-scroller 的
  // padding-bottom，见 atomic-panel.css）。直接写 DOM 变量而非 state —— 高度随抽屉
  // 展开/输入增长高频变化，不触发子树重渲染（与 Conversation 同一优化）
  const rootRef = useRef<HTMLDivElement>(null)
  const handleInputHeightChange = useCallback((h: number) => {
    rootRef.current?.style.setProperty('--chat-input-h', `${h}px`)
  }, [])
  return (
    <div ref={rootRef} className="relative flex-1 min-h-0 flex flex-col">
      <NotebookView path={path} sessionId={sessionId} caps={caps} />
      {/* 悬浮输入框：绝对贴底、背景透明不挡正文；对话抽屉与审批卡并入同一张卡片。
          relative z-20：输入卡片要盖住编辑器的浮动件（NotebookMinimap 是 z-10；
          零高度定位壳不改变 absolute 贴底的视觉落点） */}
      <div
        className={`relative z-20 transition-opacity duration-200 ${
          dim ? 'opacity-30 hover:opacity-100 focus-within:opacity-100' : ''
        }`}
      >
        <InputArea
          notebook
          thread={<ThreadDrawer sessionId={sessionId} />}
          accessory={<PendingInputsDrawer onResponse={handleInputResponse} />}
          onHeightChange={handleInputHeightChange}
        />
      </div>
    </div>
  )
}
