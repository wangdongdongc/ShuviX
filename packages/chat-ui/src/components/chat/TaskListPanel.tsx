/**
 * TaskListPanel — 任务列表（内置能力服务器 `plan`，docs/task-list-design.md §3.4，实验）
 *
 * 读的是投影出来的消息（`taskListOfMessages`）：当前请求里成功的 `mcp__plan__update` 调用按顺序折叠出来的
 * 列表，不存任何状态。只有逐行的步骤：没有标题行，也不折叠（2026-11-10 用户要求简化）。三种样子只体现在图标上：
 *  - **进行中**（会话在跑）：各步照实，进行中那一步转圈；
 *  - **已完成**（会话空闲，请求以一条最终回复收尾）：剩下的步骤一律算完成 —— 收尾归宿主，模型不用发收尾调用；
 *  - **已停止**（会话空闲，但请求没有最终回复：中止、出错、中途退出）：未完成的步骤保持原样，进行中那一步换成暂停。
 * 下一条「用户发起一轮」的消息出现（含乐观占位）时整块消失；插话不算新请求。
 *
 * 两个位置（`placement`，同 PendingInputsPanel）：
 *  - `conversation`（普通会话）：对话流末尾、最新一条消息之下（Conversation 的 Footer），自带一圈圆角描边，
 *    排在等人回答的询问卡片之上 —— 那张更急，要紧挨着输入框；
 *  - `composer`（笔记本）：对话本身就在输入框卡片里（ThreadDrawer），列表跟着待在卡片里，形态与 QueuePanel
 *    同源：自身无边框 / 圆角 / 阴影，只用一条 border-b 与下方分隔。
 * 长列表自身封顶滚动：输入框里不把输入区顶出屏幕，对话里不让一张长列表占满一屏。
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Circle, CircleCheck, CirclePause, Loader2 } from 'lucide-react'
import { taskListOfMessages, type TaskListItem } from '@shuvix/chat-protocol/taskList'
import { useChatStore, selectPendingPrompt, selectSessionRun } from '../../stores/chatStore'
import { useChatDensity } from '../../host/chatHostContext'

type Phase = 'running' | 'done' | 'stopped'

/** 一行步骤的图标：进行中转圈；已停止时进行中那一步换成暂停 */
function StepIcon({ item, phase }: { item: TaskListItem; phase: Phase }): React.JSX.Element {
  if (item.status === 'completed') {
    return <CircleCheck size={13} className="flex-shrink-0 text-success" />
  }
  if (item.status === 'in_progress') {
    return phase === 'running' ? (
      <Loader2 size={13} className="flex-shrink-0 text-accent animate-spin" />
    ) : (
      <CirclePause size={13} className="flex-shrink-0 text-warning" />
    )
  }
  return <Circle size={13} className="flex-shrink-0 text-text-tertiary" />
}

export function TaskListPanel({
  placement = 'conversation'
}: {
  placement?: 'conversation' | 'composer'
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const messages = useChatStore((s) => s.messages)
  const run = useChatStore(selectSessionRun)
  const pendingPrompt = useChatStore(selectPendingPrompt)
  const touch = useChatDensity() === 'touch'
  const snapshot = useMemo(() => taskListOfMessages(messages), [messages])

  // 一条新的请求正在发出：旧请求的列表让位
  if (!snapshot || pendingPrompt) return null

  const phase: Phase =
    run.state === 'busy' ? 'running' : snapshot.endedWithAnswer ? 'done' : 'stopped'
  const items =
    phase === 'done'
      ? snapshot.items.map((item) => ({ ...item, status: 'completed' as const }))
      : snapshot.items
  const inComposer = placement === 'composer'

  const panel = (
    <ol
      aria-label={t('taskList.title')}
      className={`space-y-0.5 max-h-[30vh] overflow-y-auto thin-scrollbar px-3.5 py-1.5 ${
        inComposer
          ? 'border-b border-border-secondary/40'
          : 'rounded-xl border border-border-secondary/40 bg-bg-primary'
      }`}
      data-task-list=""
      data-task-list-placement={placement}
      data-task-list-phase={phase}
    >
      {items.map((item, i) => (
        <li
          key={i}
          className={`flex items-center gap-2 ${touch ? 'py-1.5' : 'py-0.5'}`}
          data-task-step={i + 1}
          data-status={item.status}
        >
          <StepIcon item={item} phase={phase} />
          <span
            className={`flex-1 min-w-0 truncate ${touch ? 'text-[14px]' : 'text-[12px]'} ${
              item.status === 'completed'
                ? 'text-text-tertiary line-through'
                : item.status === 'in_progress'
                  ? 'text-text-primary'
                  : 'text-text-secondary'
            }`}
          >
            {item.content}
          </span>
        </li>
      ))}
    </ol>
  )

  if (inComposer) return panel
  return <div className="relative max-w-[784px] mx-auto px-4 pt-1.5 pb-1.5">{panel}</div>
}
