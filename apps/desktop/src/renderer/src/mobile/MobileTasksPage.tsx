/**
 * 手机布局的后台任务页 —— 从对话页的「⋯」整屏推入（2026-11-16，取代底部抽屉里那张手风琴表）。
 *
 * 列表页：「运行中」「已完成」两张卡片（顺序与桌面面板同一份 `orderTasks`：等你回答的最前、每组最新的在上；已完成
 * 只露最近几条）。一行两排：标题（命令 / 智能体名 / 子会话标题），下面是「类别 · 状态 · 时长」；行首一个点 ——
 * 智能体在跑是强调色、只剩命令在跑是绿色、等你回答是琥珀色、出错是红色、其余结束的是灰色。点命令或智能体的一行
 * 推入详情页；子会话没有详情（它是一条真正的会话），点它就打开那条会话。
 *
 * 详情页：命令是它的输出（桌面面板展开的那一块，放高），智能体是它的对话；右上角运行中是「停止」，结束后是「移除」
 * （移除后退回列表）。任务不在了（被清空）也退回列表。
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import {
  getHostApi,
  isTaskFinished,
  useBgTaskStatus,
  useBgTaskStore,
  useBgTasks,
  useChatStore
} from '@shuvix/chat-ui'
import {
  BgTaskDetail,
  FINISHED_PREVIEW,
  endedAgo,
  orderTasks,
  useBlockedTaskIds,
  useTaskKindLabel
} from '@shuvix/app-shell'
import type { TaskInfo } from '@shuvix/chat-protocol/types/task'
import { MobilePage, pageCard, pageSectionLabel } from './MobilePage'
import { taskDotState, type TaskDotState } from './panelPure'

const DOT_TONE: Record<TaskDotState, string> = {
  blocked: 'bg-warning',
  agent: 'bg-accent animate-pulse motion-reduce:animate-none',
  resident: 'bg-success',
  error: 'bg-error',
  ended: 'bg-text-tertiary/40'
}

/** 运行中每秒走一次字；只剩已完成的半分钟一次 */
function useTaskClock(running: number, finished: number): number {
  const [now, setNow] = useState(() => Date.now())
  const tickMs = running > 0 ? 1000 : finished > 0 ? 30_000 : null
  useEffect(() => {
    if (tickMs === null) return
    const tick = (): void => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const id = setInterval(tick, tickMs)
    return () => {
      clearTimeout(first)
      clearInterval(id)
    }
  }, [tickMs])
  return now
}

function TaskRow({
  task,
  now,
  blocked,
  onOpen
}: {
  task: TaskInfo
  now: number
  blocked: boolean
  onOpen: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { state, duration } = useBgTaskStatus(task, now)
  const kind = useTaskKindLabel(task)
  const finished = isTaskFinished(task)
  const stateText = blocked
    ? t('panel.tasksBlockedOn')
    : finished
      ? endedAgo(task.endedAt ?? task.startedAt, now, t)
      : state
  const dot = taskDotState(task, blocked)
  return (
    <button
      type="button"
      data-mobile-task-row={task.kind}
      data-task-id={task.taskId}
      data-task-status={task.status}
      onClick={onOpen}
      className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2 text-left active:bg-bg-hover"
    >
      <span
        aria-hidden="true"
        data-task-dot={dot}
        className={`h-2 w-2 flex-shrink-0 rounded-full ${DOT_TONE[dot]}`}
      />
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-[16px] ${
            finished ? 'text-text-secondary' : 'text-text-primary'
          }`}
        >
          {task.title}
        </span>
        <span
          data-task-meta=""
          className={`block truncate text-[13px] ${blocked ? 'text-warning' : 'text-text-tertiary'}`}
        >
          {kind} · {stateText} · {duration}
        </span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-text-tertiary" aria-hidden="true" />
    </button>
  )
}

export interface MobileTasksPageProps {
  sessionId: string
  onBack: () => void
  /** 点了一条命令 / 智能体：推入它的详情页 */
  onOpenTask: (taskId: string) => void
}

export function MobileTasksPage({
  sessionId,
  onBack,
  onOpenTask
}: MobileTasksPageProps): React.JSX.Element {
  const { t } = useTranslation()
  const tasks = useBgTasks(sessionId)
  const blockedIds = useBlockedTaskIds(tasks)
  const { running, finished } = useMemo(
    () => orderTasks(tasks, (task) => blockedIds.has(task.taskId)),
    [tasks, blockedIds]
  )
  const now = useTaskClock(running.length, finished.length)
  const [showAll, setShowAll] = useState(false)
  const shownFinished = showAll ? finished : finished.slice(0, FINISHED_PREVIEW)
  const older = finished.length - FINISHED_PREVIEW

  const open = (task: TaskInfo): void => {
    // 子会话是一条真正的会话：过去看，不在这里再画一份
    if (task.subject.kind === 'sub-session') {
      useChatStore.getState().setActiveSessionId(task.subject.childSessionId)
      return
    }
    onOpenTask(task.taskId)
  }

  const clearFinished = (): void => {
    setShowAll(false)
    useBgTaskStore.getState().removeFinished(sessionId)
    void getHostApi()
      ?.bgTask.clearDone({ sessionId })
      .catch(() => {})
  }

  const group = (
    key: 'running' | 'finished',
    label: string,
    rows: TaskInfo[],
    total: number
  ): React.ReactNode =>
    total > 0 && (
      <section data-mobile-task-group={key}>
        <div className={`flex items-baseline ${pageSectionLabel}`}>
          <span className="flex-1">{label}</span>
          {key === 'finished' && (
            <button
              type="button"
              data-mobile-tasks-clear=""
              onClick={clearFinished}
              className="text-[13px] text-accent"
            >
              {t('panel.tasksClear')}
            </button>
          )}
        </div>
        <div className={pageCard}>
          {rows.map((task) => (
            <TaskRow
              key={task.taskId}
              task={task}
              now={now}
              blocked={blockedIds.has(task.taskId)}
              onOpen={() => open(task)}
            />
          ))}
          {key === 'finished' && older > 0 && (
            <button
              type="button"
              data-mobile-tasks-older=""
              onClick={() => setShowAll((v) => !v)}
              className="flex min-h-[44px] w-full items-center px-4 text-left text-[15px] text-accent active:bg-bg-hover"
            >
              {showAll
                ? t('panel.tasksShowRecent', { count: FINISHED_PREVIEW })
                : t('panel.tasksShowOlder', { count: older })}
            </button>
          )}
        </div>
      </section>
    )

  return (
    <MobilePage
      kind="tasks"
      backLabel={t('mobile.detailsBack')}
      onBack={onBack}
      title={t('mobile.backgroundTasks')}
      toolbar={
        <span data-mobile-tasks-count="">
          {tasks.length === 0
            ? ''
            : [
                t('mobile.tasksCount', { count: tasks.length }),
                running.length > 0 ? t('mobile.tasksRunningCount', { count: running.length }) : ''
              ]
                .filter(Boolean)
                .join(' · ')}
        </span>
      }
      bodyClassName="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-6 pt-1"
    >
      {tasks.length === 0 ? (
        <div
          data-mobile-tasks-empty=""
          className="px-4 py-10 text-center text-[14px] text-text-tertiary"
        >
          {t('mobile.noTasks')}
        </div>
      ) : (
        <>
          {group('running', t('panel.tasksRunning'), running, running.length)}
          {group('finished', t('panel.tasksFinished'), shownFinished, finished.length)}
        </>
      )}
    </MobilePage>
  )
}

export interface MobileTaskDetailPageProps {
  sessionId: string
  taskId: string
  onBack: () => void
}

/** 一条任务的详情页。任务不在了（列表被清空、从别处移除）→ 自己退回列表 */
export function MobileTaskDetailPage({
  sessionId,
  taskId,
  onBack
}: MobileTaskDetailPageProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const task = useBgTasks(sessionId).find((x) => x.taskId === taskId)
  const gone = !task
  useEffect(() => {
    if (gone) onBack()
  }, [gone, onBack])
  if (!task) return null
  return <TaskDetailBody task={task} onBack={onBack} backLabel={t('mobile.backgroundTasks')} />
}

function TaskDetailBody({
  task,
  onBack,
  backLabel
}: {
  task: TaskInfo
  onBack: () => void
  backLabel: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const blocked = useBlockedTaskIds(useMemo(() => [task], [task])).has(task.taskId)
  const finished = isTaskFinished(task)
  const now = useTaskClock(finished ? 0 : 1, finished ? 1 : 0)
  const { state, duration } = useBgTaskStatus(task, now)
  const kind = useTaskKindLabel(task)
  const stateText = blocked
    ? t('panel.tasksBlockedOn')
    : finished
      ? endedAgo(task.endedAt ?? task.startedAt, now, t)
      : state

  const stop = (): void => {
    void getHostApi()
      ?.bgTask.stop({ toolCallId: task.taskId })
      .catch(() => {})
  }
  const dismiss = (): void => {
    useBgTaskStore.getState().remove(task.taskId)
    void getHostApi()
      ?.bgTask.dismiss({ toolCallId: task.taskId })
      .catch(() => {})
  }

  return (
    <MobilePage
      kind="task"
      backLabel={backLabel}
      onBack={onBack}
      title={task.title}
      subtitle={
        <span data-mobile-task-state={taskDotState(task, blocked)}>
          {kind} · {stateText} · {duration}
        </span>
      }
      actions={
        finished ? (
          <button
            type="button"
            data-mobile-task-dismiss=""
            onClick={dismiss}
            className="flex h-9 items-center rounded-full px-3 text-[16px] text-accent active:bg-bg-hover"
          >
            {t('mobile.taskRemove')}
          </button>
        ) : (
          <button
            type="button"
            data-mobile-task-stop=""
            onClick={stop}
            className="flex h-9 items-center rounded-full px-3 text-[16px] text-error active:bg-bg-hover"
          >
            {t('mobile.taskStop')}
          </button>
        )
      }
      bodyClassName="min-h-0 flex-1 overflow-y-auto pb-6 pt-1"
    >
      <div data-mobile-task-detail={task.kind} data-task-id={task.taskId}>
        <BgTaskDetail task={task} page />
      </div>
    </MobilePage>
  )
}
