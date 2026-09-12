import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Square, X } from 'lucide-react'
import {
  useBgTasks,
  useBgTaskStore,
  isTaskFinished,
  getSessionChannelApi,
  getHostApi,
  TerminalView,
  useBgTaskStatus,
  useChatStore,
  useSubSessionStore
} from '@shuvix/chat-ui'
import type { TaskInfo } from '@shuvix/chat-protocol/types/task'
import { SubSessionStream } from '../subagent/SubAgentStream'
import { usePanelCloseInset } from './panelCloseInset'

/**
 * 后台任务面板 —— SessionPanel 的 tasks 页，三类运行共用一张表：
 * bash 命令、派生 agent、子会话轮次。
 *
 * 它们此前各有各的位置（tasks 页 / 子代理页 / 只在侧边栏），但对用户而言是同一个问题：
 * **这个会话此刻在后台干什么、哪一件卡住了**。所以列表混排、行的形态一致，
 * 差别只落在展开后的详情渲染器上，因为三者的"内容"本就住在三个地方：
 *
 *  - **bash**：输出由 OS 直接写日志文件，这里按字节范围轮询自取（面板收起即停）；
 *  - **派生 agent**：转写是内存态事件流，住在 subSessionStore 里 —— 那份转写在界面上
 *    只此一处（对话流里的工具卡已退化为普通形态）；
 *  - **子会话**：它是一条真正的会话，转写在它自己的会话界面里，这里只给状态与入口，
 *    不再画第二份。
 *
 * 形态沿用原 tasks 页：手风琴列表、单条动作按钮状态唯一、展开互斥（多条同时展开会让
 * 定高输出块彼此挤压；这也是敢用轮询取日志的前提 —— 同时只有一条在拉）。
 * 见 docs/background-task-hub-design.md §6。
 */

/** 日志轮询间隔；同时只有一条任务展开，所以峰值就是 1 次/秒 */
const POLL_MS = 1000
/** 首帧取日志尾部窗口 */
const TAIL_WINDOW_BYTES = 200 * 1024

/** 类别文案 —— 行尾那句「Bash · 运行中 · 4m02s」的第一段 */
function useKindLabel(kind: TaskInfo['kind']): string {
  const { t } = useTranslation()
  if (kind === 'agent') return t('panel.tasksKindAgent')
  if (kind === 'sub-session') return t('panel.tasksKindSubSession')
  return t('panel.tasksKindBash')
}

/**
 * 单条动作按钮 —— 同一位置状态唯一，不叠按钮。
 * 运行中是中断方块；结束后静态显示，hover 变删除 ✕。
 *
 * 停止对三类都成立：枢纽持有每类各自的停止实现（杀进程组 / 软停止派生 agent /
 * 中止子会话当前轮），面板不需要知道是哪一种。
 */
function TaskAction({
  task,
  onStop,
  onDismiss
}: {
  task: TaskInfo
  onStop: (e: React.MouseEvent) => void
  onDismiss: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  if (!isTaskFinished(task)) {
    return (
      <button
        onClick={onStop}
        className="ml-0.5 p-0.5 rounded bg-error/20 text-error hover:bg-error/30 transition-colors"
        title={t('panel.tasksStop')}
      >
        <Square size={9} fill="currentColor" />
      </button>
    )
  }
  return (
    <button
      onClick={onDismiss}
      className="ml-0.5 p-0.5 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
      title={t('panel.tasksDismiss')}
    >
      <X size={11} />
    </button>
  )
}

/** 「完成时通知 AI」开关 —— 只有会回报的那两类有意义（派生 agent 恒为同步等待） */
function NotifyToggle({ task }: { task: TaskInfo }): React.JSX.Element {
  const { t } = useTranslation()
  const toggle = useCallback(() => {
    const next = !task.notifyAgent
    useBgTaskStore.getState().upsert({ ...task, notifyAgent: next })
    void getHostApi()
      ?.bgTask.setNotify({ toolCallId: task.taskId, enabled: next })
      .catch(() => {})
  }, [task])

  return (
    <button
      onClick={toggle}
      className="flex items-center gap-1.5 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
    >
      <span
        className={`w-3 h-3 rounded-sm border flex items-center justify-center ${
          task.notifyAgent ? 'bg-accent border-accent' : 'border-border-secondary'
        }`}
      >
        {task.notifyAgent && <span className="w-1.5 h-1.5 rounded-[1px] bg-bg-primary" />}
      </span>
      {t('panel.tasksNotify')}
    </button>
  )
}

/** bash 详情：命令 + 实时输出（后台任务没有输入通道，见 bgTaskService 文件头） */
function BashDetail({ task }: { task: TaskInfo }): React.JSX.Element | null {
  const { t } = useTranslation()
  const [log, setLog] = useState('')
  const [missing, setMissing] = useState(false)
  // 续读游标：日志只增不减，拿到 nextByte 后每次只取新字节
  const cursorRef = useRef<number | null>(null)
  const running = !isTaskFinished(task)

  // 轮询日志 —— 只在本条展开期间跑（组件卸载即停），任务结束后再补一次收尾
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const pull = async (): Promise<void> => {
      try {
        const chunk = await getSessionChannelApi().bgTask.readLog({
          toolCallId: task.taskId,
          fromByte: cursorRef.current ?? undefined,
          maxBytes: TAIL_WINDOW_BYTES
        })
        if (!alive) return
        // 文件不存在（用户手动清了 tool_results）与「还没有输出」是两回事，靠 exists 区分
        setMissing(!chunk.exists)
        if (chunk.text)
          setLog((prev) => (cursorRef.current === null ? chunk.text : prev + chunk.text))
        cursorRef.current = chunk.nextByte
      } catch {
        /* 读失败不打断轮询 —— 下一拍再试 */
      }
      if (alive && running) timer = setTimeout(pull, POLL_MS)
    }

    void pull()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [task.taskId, running])

  if (task.subject.kind !== 'bash') return null
  const { command, cwd, exitCode, logCapped } = task.subject

  return (
    <div className="px-2 pb-2 space-y-1.5">
      {logCapped && <div className="text-[10px] text-warning">{t('panel.tasksLogCapped')}</div>}
      <TerminalView
        command={command}
        cwd={cwd}
        output={
          missing
            ? t('panel.tasksLogMissing')
            : log || (running ? undefined : t('panel.tasksNoOutput'))
        }
        running={running}
        exitCode={running ? undefined : (exitCode ?? undefined)}
        stickToBottom
        outputMaxHClass="max-h-56"
      />

      {running && (
        <div className="text-[10px] text-text-tertiary leading-relaxed">
          {t('panel.tasksStdinClosed')}
        </div>
      )}

      <NotifyToggle task={task} />
    </div>
  )
}

/**
 * 派生 agent 详情：它的转写。
 *
 * 转写是内存态（事件流累积在 subSessionStore 里），重启应用或用户关掉这条就没了 ——
 * 与面板整体「只记录本次运行期间」的口径一致。取不到时说清楚，不装作还在。
 */
function AgentDetail({ task }: { task: TaskInfo }): React.JSX.Element {
  const { t } = useTranslation()
  const sub = useSubSessionStore((s) => s.subSessions[task.taskId])
  if (!sub) {
    return (
      <div className="px-3 pb-2 text-[10px] text-text-tertiary">{t('panel.tasksAgentGone')}</div>
    )
  }
  return <SubSessionStream sub={sub} focusLast={false} />
}

/**
 * 子会话详情：状态 + 入口。
 *
 * **刻意不画转写** —— 子会话是一条真正的会话，它的转写在会话界面里（侧边栏也挂着它）。
 * 在这里再画一份既重复又永远差一截（那边能发消息、能改模型、能看历史）。
 */
function SubSessionDetail({ task }: { task: TaskInfo }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (task.subject.kind !== 'sub-session') return null
  const { childSessionId, blockedOn } = task.subject
  return (
    <div className="px-2 pb-2 space-y-1.5">
      {task.status === 'waiting-input' && blockedOn?.length ? (
        <div className="text-[10px] text-warning leading-relaxed">
          {t('panel.tasksBlockedOn')} {blockedOn.join(' | ')}
        </div>
      ) : null}
      <button
        onClick={() => useChatStore.getState().setActiveSessionId(childSessionId)}
        className="text-[10px] text-accent hover:underline"
      >
        {t('panel.tasksOpenSession')}
      </button>
      <NotifyToggle task={task} />
    </div>
  )
}

function TaskDetail({ task }: { task: TaskInfo }): React.JSX.Element | null {
  if (task.kind === 'agent') return <AgentDetail task={task} />
  if (task.kind === 'sub-session') return <SubSessionDetail task={task} />
  return <BashDetail task={task} />
}

/** 一个状态分组（运行中 / 已完成），组头可折叠 */
function TaskGroup({
  label,
  tasks,
  now,
  expandedId,
  onToggleExpand,
  onClear,
  reserveTopRight = false
}: {
  label: string
  tasks: TaskInfo[]
  now: number
  expandedId: string | null
  onToggleExpand: (taskId: string) => void
  onClear?: () => void
  /** 本组是面板首个可见分组：组头右侧给会话面板悬在卡片右上角的收起按钮让位 */
  reserveTopRight?: boolean
}): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false)
  const { t } = useTranslation()
  if (tasks.length === 0) return null

  return (
    <div className="mb-1.5 last:mb-0">
      <div className={`flex items-center gap-1 px-1 py-1${reserveTopRight ? ' pr-6' : ''}`}>
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-1 min-w-0 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors"
        >
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          <span>{label}</span>
          <span className="tabular-nums">{tasks.length}</span>
        </button>
        <div className="flex-1" />
        {onClear && (
          <button
            onClick={onClear}
            className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
          >
            {t('panel.tasksClear')}
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="rounded-lg border border-border-secondary/40 bg-bg-primary overflow-hidden">
          {tasks.map((task, idx) => (
            <TaskRow
              key={task.taskId}
              task={task}
              now={now}
              expanded={expandedId === task.taskId}
              divided={idx > 0}
              onToggle={() => onToggleExpand(task.taskId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function TaskRow({
  task,
  now,
  expanded,
  divided,
  onToggle
}: {
  task: TaskInfo
  now: number
  expanded: boolean
  divided: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { state, duration } = useBgTaskStatus(task, now)
  const kindLabel = useKindLabel(task.kind)

  const handleStop = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      void getHostApi()
        ?.bgTask.stop({ toolCallId: task.taskId })
        .catch(() => {})
    },
    [task.taskId]
  )

  const handleDismiss = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      useBgTaskStore.getState().remove(task.taskId)
      void getHostApi()
        ?.bgTask.dismiss({ toolCallId: task.taskId })
        .catch(() => {})
    },
    [task.taskId]
  )

  // 派生 agent 的行保留原子代理面板的 DOM 锚点（e2e 按它认行，换名字只会让断言失明）
  const agentAnchor =
    task.subject.kind === 'agent'
      ? {
          'data-subagent-run': task.subject.profileName,
          'data-subagent-expanded': expanded ? 'true' : 'false'
        }
      : {}

  return (
    <div className={divided ? 'border-t border-border-secondary/30' : ''} {...agentAnchor}>
      <div
        onClick={onToggle}
        className="flex items-start gap-1.5 px-2 py-1.5 cursor-pointer hover:bg-bg-hover/30 transition-colors"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs text-text-primary" title={task.title}>
            {task.title}
          </div>
          <div className="mt-0.5 text-[10px] text-text-tertiary">
            {kindLabel} · {state} · {duration}
          </div>
        </div>
        <TaskAction task={task} onStop={handleStop} onDismiss={handleDismiss} />
      </div>
      {expanded && <TaskDetail task={task} />}
    </div>
  )
}

export function BgTaskPanel({ sessionId }: { sessionId: string | null }): React.JSX.Element {
  const { t } = useTranslation()
  const closeInset = usePanelCloseInset()
  const tasks = useBgTasks(sessionId)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // 运行中任务的时长要走字 —— 每秒一拍重渲染（面板收起时组件卸载，不空转）
  const [now, setNow] = useState(() => Date.now())
  const hasRunning = tasks.some((task) => !isTaskFinished(task))
  useEffect(() => {
    if (!hasRunning) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [hasRunning])

  const { running, finished } = useMemo(
    () => ({
      running: tasks.filter((task) => !isTaskFinished(task)),
      finished: tasks.filter(isTaskFinished)
    }),
    [tasks]
  )

  // 展开互斥：点已展开的收起，否则独占展开
  const toggleExpand = useCallback(
    (taskId: string) => setExpandedId((prev) => (prev === taskId ? null : taskId)),
    []
  )

  const clearFinished = useCallback(() => {
    if (!sessionId) return
    if (expandedId && finished.some((task) => task.taskId === expandedId)) setExpandedId(null)
    useBgTaskStore.getState().removeFinished(sessionId)
    void getHostApi()
      ?.bgTask.clearDone({ sessionId })
      .catch(() => {})
  }, [sessionId, expandedId, finished])

  return (
    <div className="h-full overflow-y-auto no-scrollbar p-1.5 bg-bg-secondary">
      {/* 让位只给**首个可见**分组：空组渲染成 null，运行中为空时首行就是「已完成」那条 */}
      <TaskGroup
        label={t('panel.tasksRunning')}
        tasks={running}
        now={now}
        expandedId={expandedId}
        onToggleExpand={toggleExpand}
        reserveTopRight={closeInset && running.length > 0}
      />
      <TaskGroup
        label={t('panel.tasksFinished')}
        tasks={finished}
        now={now}
        expandedId={expandedId}
        onToggleExpand={toggleExpand}
        onClear={clearFinished}
        reserveTopRight={closeInset && running.length === 0}
      />
    </div>
  )
}
