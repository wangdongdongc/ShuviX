/**
 * 收件箱一行下面的任务列表（2026-11-14 用户要求：收件箱里的会话额外显示它的任务列表，有的话）。
 *
 * 与对话末尾的那张列表画的是同一份东西（chat-ui `TaskListSteps` + chat-protocol `taskListDisplay`），只是没有外框：
 * 步骤行挂在标题与预览下面，整张都列出来（用户选的是「全部步骤」，不是只露当前一步）。
 *
 * 两种来源：
 *  - **agent 在跑的行**（`InboxLiveTaskList`）：订阅那条会话的视图（`useSessionView`，与别处共用一个订阅），列表随
 *    agent 推进实时变；会话在跑 → 进行中。
 *  - **新回复的行**（`InboxReplyTaskList`）：读的是摘录那次已经取回来的消息（InboxUnreadRow 的 `useReplyExcerpts`），
 *    不另外取；会话停着，所以是已完成 / 已停止。
 * 这个请求里没有成功的列表调用 → 什么都不画。
 */
import { useMemo } from 'react'
import {
  taskListDisplay,
  taskListOfMessages,
  type TaskListSnapshot
} from '@shuvix/chat-protocol/taskList'
import { TaskListSteps, useChatStore, useSessionView } from '@shuvix/chat-ui'

const STEPS_CLASS = 'mb-1.5 -mt-0.5 max-h-[40vh] overflow-y-auto thin-scrollbar'

function Steps({
  sessionId,
  snapshot,
  running
}: {
  sessionId: string
  snapshot: TaskListSnapshot
  running: boolean
}): React.JSX.Element {
  const { phase, items } = taskListDisplay(snapshot, running)
  return (
    <TaskListSteps
      items={items}
      phase={phase}
      className={STEPS_CLASS}
      attrs={{ 'data-inbox-task-list': sessionId }}
    />
  )
}

/** agent 在跑的那条会话：订它的视图，列表实时变 */
export function InboxLiveTaskList({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  useSessionView(sessionId)
  const view = useChatStore((s) => s.sessionViews[sessionId])
  const snapshot = useMemo(() => (view ? taskListOfMessages(view.messages) : undefined), [view])
  if (!view || !snapshot) return null
  return <Steps sessionId={sessionId} snapshot={snapshot} running={view.run.state === 'busy'} />
}

/** 新回复的那条会话：摘录那次取回来的列表，会话停着 */
export function InboxReplyTaskList({
  sessionId,
  snapshot
}: {
  sessionId: string
  snapshot: TaskListSnapshot | undefined
}): React.JSX.Element | null {
  if (!snapshot) return null
  return <Steps sessionId={sessionId} snapshot={snapshot} running={false} />
}
