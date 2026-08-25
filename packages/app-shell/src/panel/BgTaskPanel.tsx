import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Send, Square, X } from 'lucide-react'
import {
  useBgTasks,
  useBgTaskStore,
  getSessionChannelApi,
  getHostApi,
  isImeComposing,
  TerminalView,
  useBgTaskStatus
} from '@shuvix/chat-ui'
import type { BgTaskInfo } from '@shuvix/chat-protocol/types/bgTask'

/**
 * 后台任务面板 —— SessionPanel 的 tasks 页
 *
 * 形态刻意贴近同类问题已经验证过的 SubAgentPanel（一组并发的、有状态的、可中断的运行）：
 * 手风琴列表、单条动作按钮状态唯一。差别在三处，都有理由：
 *
 *  - **标题用 description 而不是命令**。命令太长、前缀又常常雷同（一排
 *    `cd /Volumes/… && npm run …` 完全分不出谁是谁）；`description` 本来就是 bash 的必填参数。
 *  - **状态是纯文本 `Bash · 已完成 · 4m02s`，不是彩色状态点**。列表里五条各挂一个绿点红点，
 *    噪音大过信息量。只有失败破例染红。
 *  - **展开互斥**。多条同时展开会让定高输出块彼此挤压；这也是下面敢用轮询取日志的前提
 *    （同时只有一条在拉）。
 *
 * 输出不在 store 里 —— 子进程的 stdout/stderr 由 OS 直接写日志文件，这里按字节范围轮询
 * `bgTask.readLog` 自取，面板收起即停。见 docs/background-tasks-design.md。
 */

/** 日志轮询间隔；同时只有一条任务展开，所以峰值就是 1 次/秒 */
const POLL_MS = 1000
/** 首帧取日志尾部窗口 */
const TAIL_WINDOW_BYTES = 200 * 1024

/** 已结束（含失败与被停止）—— 分组与「清空」都按这个判定 */
function isFinished(task: BgTaskInfo): boolean {
  return task.status !== 'running'
}

/**
 * 单条动作按钮 —— 照搬 SubAgentPanel 的 HeaderAction：同一位置状态唯一，不叠按钮。
 * 运行中是中断方块；结束后静态显示，hover 变删除 ✕。
 */
function TaskAction({
  task,
  onStop,
  onDismiss
}: {
  task: BgTaskInfo
  onStop: (e: React.MouseEvent) => void
  onDismiss: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  if (task.status === 'running') {
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

/** 展开态内容：命令 + 实时输出 + stdin 干涉 + 通知开关 */
function TaskDetail({ task }: { task: BgTaskInfo }): React.JSX.Element {
  const { t } = useTranslation()
  const [log, setLog] = useState('')
  const [missing, setMissing] = useState(false)
  const [draft, setDraft] = useState('')
  // 续读游标：日志只增不减，拿到 nextByte 后每次只取新字节
  const cursorRef = useRef<number | null>(null)

  // 轮询日志 —— 只在本条展开期间跑（组件卸载即停），任务结束后再补一次收尾
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null

    const pull = async (): Promise<void> => {
      try {
        const chunk = await getSessionChannelApi().bgTask.readLog({
          toolCallId: task.toolCallId,
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
      if (alive && task.status === 'running') timer = setTimeout(pull, POLL_MS)
    }

    void pull()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [task.toolCallId, task.status])

  const send = useCallback(() => {
    const data = draft
    if (!data) return
    setDraft('')
    void getHostApi()
      ?.bgTask.write({ toolCallId: task.toolCallId, data: `${data}\n` })
      .catch(() => {})
    // 本地回显 —— 写进的是子进程的 fd，我们插不进那个日志文件，只能在视图里留痕
    setLog((prev) => `${prev}${prev.endsWith('\n') || !prev ? '' : '\n'}> ${data}\n`)
  }, [draft, task.toolCallId])

  const toggleNotify = useCallback(() => {
    const next = !task.notifyAgent
    useBgTaskStore.getState().upsert({ ...task, notifyAgent: next })
    void getHostApi()
      ?.bgTask.setNotify({ toolCallId: task.toolCallId, enabled: next })
      .catch(() => {})
  }, [task])

  return (
    <div className="px-2 pb-2 space-y-1.5">
      {task.logCapped && (
        <div className="text-[10px] text-warning">{t('panel.tasksLogCapped')}</div>
      )}
      <TerminalView
        command={task.command}
        cwd={task.cwd}
        output={
          missing
            ? t('panel.tasksLogMissing')
            : log || (task.status === 'running' ? undefined : t('panel.tasksNoOutput'))
        }
        running={task.status === 'running'}
        exitCode={task.status === 'running' ? undefined : (task.exitCode ?? undefined)}
        stickToBottom
        outputMaxHClass="max-h-56"
      />

      {task.status === 'running' && (
        <div className="flex items-center gap-1">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isImeComposing(e)) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={t('panel.tasksStdinPlaceholder')}
            className="flex-1 min-w-0 px-2 py-1 rounded-md bg-bg-primary border border-border-secondary/50 text-[11px] font-mono text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
          />
          <button
            onClick={send}
            disabled={!draft}
            className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
            title={t('panel.tasksStdinPlaceholder')}
          >
            <Send size={12} />
          </button>
        </div>
      )}

      <button
        onClick={toggleNotify}
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
    </div>
  )
}

/** 一个状态分组（运行中 / 已完成），组头可折叠 */
function TaskGroup({
  label,
  tasks,
  now,
  expandedId,
  onToggleExpand,
  onClear
}: {
  label: string
  tasks: BgTaskInfo[]
  now: number
  expandedId: string | null
  onToggleExpand: (toolCallId: string) => void
  onClear?: () => void
}): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false)
  const { t } = useTranslation()
  if (tasks.length === 0) return null

  return (
    <div className="mb-1.5 last:mb-0">
      <div className="flex items-center gap-1 px-1 py-1">
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
              key={task.toolCallId}
              task={task}
              now={now}
              expanded={expandedId === task.toolCallId}
              divided={idx > 0}
              onToggle={() => onToggleExpand(task.toolCallId)}
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
  task: BgTaskInfo
  now: number
  expanded: boolean
  divided: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { state, duration } = useBgTaskStatus(task, now)

  const handleStop = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      void getHostApi()
        ?.bgTask.stop({ toolCallId: task.toolCallId })
        .catch(() => {})
    },
    [task.toolCallId]
  )

  const handleDismiss = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      useBgTaskStore.getState().remove(task.toolCallId)
      void getHostApi()
        ?.bgTask.dismiss({ toolCallId: task.toolCallId })
        .catch(() => {})
    },
    [task.toolCallId]
  )

  return (
    <div className={divided ? 'border-t border-border-secondary/30' : ''}>
      <div
        onClick={onToggle}
        className="flex items-start gap-1.5 px-2 py-1.5 cursor-pointer hover:bg-bg-hover/30 transition-colors"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs text-text-primary" title={task.description}>
            {task.description}
          </div>
          <div className="mt-0.5 text-[10px] text-text-tertiary">
            Bash · {state} · {duration}
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
  const tasks = useBgTasks(sessionId)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // 运行中任务的时长要走字 —— 每秒一拍重渲染（面板收起时组件卸载，不空转）
  const [now, setNow] = useState(() => Date.now())
  const hasRunning = tasks.some((task) => task.status === 'running')
  useEffect(() => {
    if (!hasRunning) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [hasRunning])

  const { running, finished } = useMemo(
    () => ({
      running: tasks.filter((task) => !isFinished(task)),
      finished: tasks.filter(isFinished)
    }),
    [tasks]
  )

  // 展开互斥：点已展开的收起，否则独占展开
  const toggleExpand = useCallback(
    (toolCallId: string) => setExpandedId((prev) => (prev === toolCallId ? null : toolCallId)),
    []
  )

  const clearFinished = useCallback(() => {
    if (!sessionId) return
    if (expandedId && finished.some((task) => task.toolCallId === expandedId)) setExpandedId(null)
    useBgTaskStore.getState().removeFinished(sessionId)
    void getHostApi()
      ?.bgTask.clearDone({ sessionId })
      .catch(() => {})
  }, [sessionId, expandedId, finished])

  return (
    <div className="h-full overflow-y-auto no-scrollbar p-1.5 bg-bg-secondary">
      <TaskGroup
        label={t('panel.tasksRunning')}
        tasks={running}
        now={now}
        expandedId={expandedId}
        onToggleExpand={toggleExpand}
      />
      <TaskGroup
        label={t('panel.tasksFinished')}
        tasks={finished}
        now={now}
        expandedId={expandedId}
        onToggleExpand={toggleExpand}
        onClear={clearFinished}
      />
    </div>
  )
}
