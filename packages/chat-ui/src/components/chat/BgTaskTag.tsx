/**
 * 后台任务的状态文案与标签 —— 对话内工具卡与右侧任务面板**共用同一份**。
 *
 * 同一个任务会在两处露面（对话里起它的那张工具卡、面板里的条目），状态说法不该有两版，
 * 所以措辞收敛到这里而不是各写各的。见 docs/background-tasks-design.md §5.3。
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BgTaskInfo } from '@shuvix/chat-protocol/types/bgTask'
import { useBgTask } from '../../stores/bgTaskStore'

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return `${m}m${String(s).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** 运行中才需要走字的秒表；结束后停掉，避免整棵对话树每秒重渲染 */
export function useNowTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

/**
 * 状态：**只体现现状，不做判断**。
 *
 * 早先这里区分过 已完成 / 失败 / 已停止，并按 exitCode 把失败染红 —— 撤掉了，原因有二：
 *  1. 判不准。回执给模型的 `kill -- -<pid>` 默认发 SIGTERM，是**主动停止**，却因为
 *     exitCode 非 0 被判成「失败」。要判对就得逐个信号讨论，而这些区分本身没人需要。
 *  2. 不需要。一个后台任务在对话行里要回答的问题只有一个：它还在跑吗。
 *
 * duration 单独返回，由调用方决定要不要显示 —— 对话行不显示（那里只要状态），
 * 面板显示（那是专门看任务的地方）。措辞两处同源，密度按场合给。
 */
export function useBgTaskStatus(
  task: BgTaskInfo,
  now: number
): { state: string; duration: string } {
  const { t } = useTranslation()
  const running = task.status === 'running'
  return {
    state: running ? t('panel.tasksStatusRunning') : t('panel.tasksStatusEnded'),
    duration: formatDuration((running ? now : (task.endedAt ?? task.startedAt)) - task.startedAt)
  }
}

/** 「后台」小标签 —— 询问卡与工具卡共用同一枚 */
export function BackgroundBadge(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <span className="flex-shrink-0 px-1.5 py-px rounded text-[10px] font-medium bg-warning/15 text-warning">
      {t('toolCall.backgroundTag')}
    </span>
  )
}

/**
 * 工具卡摘要行尾的后台任务状态（标签在行首，见 StepRow 的 badge 槽）。
 *
 * 工具卡的 details 是消息树里的静态数据、不会自更新，所以实时态按 toolCallId 从
 * bgTaskStore 取 —— 与子智能体卡片走同一套路子。重启应用或用户从面板清掉后取不到，
 * 此时整块不渲染（行首的标签仍在，它来自消息树）。
 */
export function BgTaskRowState({ toolCallId }: { toolCallId: string }): React.JSX.Element | null {
  const task = useBgTask(toolCallId)
  const now = useNowTicker(task?.status === 'running')
  if (!task) return null
  return <BgTaskStateText task={task} now={now} />
}

function BgTaskStateText({ task, now }: { task: BgTaskInfo; now: number }): React.JSX.Element {
  const { state } = useBgTaskStatus(task, now)
  return <span className="flex-shrink-0 text-text-tertiary">{state}</span>
}
