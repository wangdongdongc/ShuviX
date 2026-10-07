import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  selectSessionAskCount,
  useSubSessionStore,
  useAgentView,
  deriveAgentViewFields,
  type SubSessionState
} from '@shuvix/chat-ui'
import type { TaskInfo } from '@shuvix/chat-protocol/types/task'
import type { AgentView } from '@shuvix/chat-protocol/types/sessionView'
import { SubSessionStream } from '../subagent/SubAgentStream'
import { usePanelCloseInset } from './panelCloseInset'
import { FINISHED_PREVIEW, endedAgo, orderTasks } from './bgTaskOrder'

/**
 * 后台任务面板 —— SessionPanel 的 tasks 页，三类运行共用一张表：
 * bash 命令、派生 agent、子会话轮次。
 *
 * 它们此前各有各的位置（tasks 页 / 子代理页 / 只在侧边栏），但对用户而言是同一个问题：
 * **这个会话此刻在后台干什么、哪一件卡住了**。所以列表混排、行的形态一致，
 * 差别只落在展开后的详情渲染器上，因为三者的"内容"本就住在三个地方：
 *
 *  - **bash**：输出由 OS 直接写日志文件，这里按字节范围轮询自取（面板收起即停）；
 *  - **派生 agent**：转写在它的 agent 视图里（展开时订阅，镜像进 subSessionStore）—— 那份转写在界面上
 *    只此一处（对话流里的工具卡已退化为普通形态）；
 *  - **子会话**：它是一条真正的会话，转写在它自己的会话界面里，这里只给状态与入口，
 *    不再画第二份。
 *
 * 形态沿用原 tasks 页：手风琴列表、单条动作按钮状态唯一、展开互斥（多条同时展开会让
 * 定高输出块彼此挤压；这也是敢用轮询取日志的前提 —— 同时只有一条在拉）。
 * 见 docs/background-task-hub-design.md §6。
 *
 * **重点先看得见**：每组最新的在最上面（等你回答的再往前，见 `bgTaskOrder.ts`）；已完成组只露最近
 * {@link FINISHED_PREVIEW} 条，更早的折起来；行首一枚状态点、已完成行压暗并写「多久前结束」——
 * 任务一多，运行中的和刚落定的不该被一长串旧条目淹掉。
 */

/** 日志轮询间隔；同时只有一条任务展开，所以峰值就是 1 次/秒 */
const POLL_MS = 1000
/** 首帧取日志尾部窗口 */
const TAIL_WINDOW_BYTES = 200 * 1024

type ChatState = ReturnType<typeof useChatStore.getState>

/**
 * 这条任务此刻是不是卡在等用户批准。
 *
 * 子会话问渲染端自己：待答询问的条数按会话 id 记在 chatStore 里（会话列表上那个标记同一个源：订阅着视图的
 * 会话看视图，其余看 `ask_count` 余项，P3-08 PIN-01）；其余类别看枢纽的 `waiting-input`（契约里它是
 * 所有 kind 的一等状态）。
 * 这是**面板存在的一个主要理由** —— 一个卡在询问上的后台活不会自己好起来，
 * 而在此之前它只在那条子会话自己的界面里才看得见。
 */
function isBlockedIn(s: ChatState, task: TaskInfo): boolean {
  if (task.status === 'waiting-input') return true
  return task.subject.kind === 'sub-session'
    ? selectSessionAskCount(task.subject.childSessionId)(s) > 0
    : false
}

/**
 * 会话里卡在等用户的那些**运行中**任务（排序与行的色调同用这一份；已结束的不会再等谁）。
 * selector 交回拼好的字符串而不是数组 —— 原始值才比得出「没变」，数组每次都是新引用，
 * 等于每次 chatStore 变动都重渲染整张面板。
 */
function useBlockedTaskIds(tasks: TaskInfo[]): Set<string> {
  const key = useChatStore((s) =>
    tasks
      .filter((task) => !isTaskFinished(task) && isBlockedIn(s, task))
      .map((task) => task.taskId)
      .join('\n')
  )
  return useMemo(() => new Set(key ? key.split('\n') : []), [key])
}

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
    </div>
  )
}

/**
 * 没有登记条目时，从视图拼出详情要的那份状态（PIN-13：重建过的渲染端 —— 主进程活着、窗口关了又开 / Cmd+R ——
 * 任务行还在、subSessionStore 是空的）。元信息只有任务行给得出的那些（标题、档案）：没有起始指令气泡，视图
 * 的第一条用户条目照常显示。视图不在 live（不可用 / 订阅失败）→ 留着最后画出来的消息、不再流式（P3-14-20）。
 */
function detachedSubOf(task: TaskInfo, view: AgentView, live: boolean): SubSessionState {
  const shown: AgentView = live
    ? view
    : {
        ...view,
        live: null,
        run: { ...view.run, state: view.run.state === 'busy' ? 'idle' : view.run.state }
      }
  const fields = deriveAgentViewFields(undefined, shown)
  const profileName = task.subject.kind === 'agent' ? task.subject.profileName : ''
  return {
    subSessionId: task.taskId,
    parentSessionId: task.sessionId,
    subAgentName: profileName,
    displayName: task.title,
    description: '',
    systemPrompt: '',
    prompt: '',
    status: shown.run.state === 'busy' ? 'running' : task.status === 'error' ? 'error' : 'done',
    startedAt: task.startedAt,
    ...fields
  }
}

/**
 * 派生 agent 详情：它的转写。
 *
 * 展开即订阅它的 agent 视图（`useAgentView`，收起 = 卸载 = 放手；展开互斥，所以同时只有一条订阅，P3-14）：
 * 登记过的（本次运行里见过它的 register）镜像进 subSessionStore，详情读那份条目（带起始指令、内联 Token
 * 标签）；没登记过的（重建过的渲染端）直接从视图渲染（PIN-13）。订阅失败 `service_not_found`（agent 被销毁 /
 * 主进程认不出它）→ 说清楚「不在了」，不装作还在。
 */
function AgentDetail({ task }: { task: TaskInfo }): React.JSX.Element {
  const { t } = useTranslation()
  const sub = useSubSessionStore((s) => s.subSessions[task.taskId])
  const binding = useAgentView(task.taskId)
  const live = binding.status === 'live'
  const detached = useMemo(
    () => (sub || !binding.view ? undefined : detachedSubOf(task, binding.view, live)),
    [sub, binding.view, live, task]
  )
  const gone = binding.status === 'error' && binding.code === 'service_not_found'
  const goneNote = (
    <div className="px-3 pb-2 text-[10px] text-text-tertiary" data-subagent-gone="">
      {t('panel.tasksAgentGone')}
    </div>
  )
  const shown = sub ?? detached
  if (!shown) {
    // 还在订：什么都不画（订到就有）；订不到 / 不可用：说清楚
    return binding.status === 'loading' ? <></> : goneNote
  }
  return (
    <>
      <SubSessionStream sub={shown} focusLast={false} />
      {gone && goneNote}
    </>
  )
}

/**
 * 展开详情。
 *
 * **子会话没有详情** —— 它是一条真正的会话，转写在会话界面里（侧边栏也挂着它），
 * 在这里再画一份既重复又永远差一截（那边能发消息、能改模型、能看历史）。
 * 它需要的只是一个入口，而入口长在标题行上（见 TaskRow 的「打开」），
 * 所以这类行干脆不可展开 —— 点开一个空抽屉比没有抽屉更糟。
 */
function TaskDetail({ task }: { task: TaskInfo }): React.JSX.Element | null {
  if (task.kind === 'agent') return <AgentDetail task={task} />
  if (task.kind === 'sub-session') return null
  return <BashDetail task={task} />
}

/** 一个状态分组（运行中 / 已完成），组头可折叠 */
function TaskGroup({
  label,
  tasks,
  total,
  now,
  expandedId,
  blockedIds,
  onToggleExpand,
  collapsed,
  onToggleCollapsed,
  onClear,
  footer,
  reserveTopRight = false
}: {
  label: string
  /** 本组此刻画出来的行（已完成组可能只是最近几条） */
  tasks: TaskInfo[]
  /** 组头的计数 —— 本组的全部条数，不因折起更早的而变少 */
  total: number
  now: number
  expandedId: string | null
  blockedIds: Set<string>
  onToggleExpand: (taskId: string) => void
  /** 组头折叠由面板持有 —— 揭示一条折起来的组里的任务时得能把它打开 */
  collapsed: boolean
  onToggleCollapsed: () => void
  onClear?: () => void
  /** 卡片底部（已完成组的「显示更早的 N 条」） */
  footer?: ReactNode
  /** 本组是面板首个可见分组：组头右侧给会话面板悬在卡片右上角的收起按钮让位 */
  reserveTopRight?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (total === 0) return null

  return (
    <div className="mb-1.5 last:mb-0">
      <div className={`flex items-center gap-1 px-1 py-1${reserveTopRight ? ' pr-6' : ''}`}>
        <button
          onClick={onToggleCollapsed}
          className="flex items-center gap-1 min-w-0 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors"
        >
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          <span>{label}</span>
          <span className="tabular-nums">{total}</span>
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
              blocked={blockedIds.has(task.taskId)}
              divided={idx > 0}
              onToggle={() => onToggleExpand(task.taskId)}
            />
          ))}
          {footer}
        </div>
      )}
    </div>
  )
}

/**
 * 行首的状态点：运行中（脉动）/ 等你回答 / 已结束。
 * 分组已经说了「运行中 / 已完成」，点是给扫一眼用的 —— 尤其让等你回答的那条在一列运行中里跳出来。
 */
function StatusDot({
  finished,
  blocked
}: {
  finished: boolean
  blocked: boolean
}): React.JSX.Element {
  const state = finished ? 'ended' : blocked ? 'blocked' : 'running'
  const tone = {
    ended: 'bg-text-tertiary/40',
    blocked: 'bg-warning',
    running: 'bg-accent animate-pulse'
  }[state]
  return (
    <span
      aria-hidden
      data-task-dot={state}
      className={`mt-[5px] h-1.5 w-1.5 flex-shrink-0 rounded-full ${tone}`}
    />
  )
}

function TaskRow({
  task,
  now,
  expanded,
  blocked,
  divided,
  onToggle
}: {
  task: TaskInfo
  now: number
  expanded: boolean
  /** 卡在等人回答 —— 它不会自己好起来，是这张表里唯一需要用户动手的状态，要一眼看得出来 */
  blocked: boolean
  divided: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { state, duration } = useBgTaskStatus(task, now)
  const kindLabel = useKindLabel(task.kind)
  const finished = isTaskFinished(task)
  // 子会话没有可展开的详情（转写在它自己的会话里），标题行上给一个「打开」直接过去
  const openTarget = task.subject.kind === 'sub-session' ? task.subject.childSessionId : null
  // 已结束的行把「已结束」换成「多久前结束」：分组头已经说了它结束了，要紧的是哪条是刚刚那条
  const stateText = blocked
    ? t('panel.tasksBlockedOn')
    : finished
      ? endedAgo(task.endedAt ?? task.startedAt, now, t)
      : state

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

  // 派生 agent 的行保留原子代理面板的 DOM 锚点（e2e 按它认行，换名字只会让断言失明）；每一行另有
  // `data-task-row`（类别）/ `data-task-status`（枢纽的状态，不随语言变）—— e2e 认子会话行与它的落定靠它们；
  // `data-task-id` 是揭示时滚到这一行用的
  const agentAnchor =
    task.subject.kind === 'agent'
      ? {
          'data-subagent-run': task.subject.profileName,
          'data-subagent-expanded': expanded ? 'true' : 'false'
        }
      : {}

  return (
    <div
      className={`${divided ? 'border-t border-border-secondary/30' : ''}${blocked ? ' bg-warning/5' : ''}`}
      data-task-row={task.kind}
      data-task-status={task.status}
      data-task-id={task.taskId}
      {...agentAnchor}
    >
      <div
        onClick={openTarget ? undefined : onToggle}
        className={`flex items-start gap-1.5 px-2 py-1.5 transition-colors ${
          openTarget ? '' : 'cursor-pointer hover:bg-bg-hover/30'
        }`}
      >
        <StatusDot finished={finished} blocked={blocked} />
        <div className="min-w-0 flex-1">
          <div
            className={`truncate text-xs ${finished ? 'text-text-secondary' : 'text-text-primary'}`}
            title={task.title}
          >
            {task.title}
          </div>
          <div className={`mt-0.5 text-[10px] ${blocked ? 'text-warning' : 'text-text-tertiary'}`}>
            {kindLabel} · {stateText} · {duration}
          </div>
        </div>
        {openTarget && (
          <button
            data-task-open=""
            onClick={(e) => {
              e.stopPropagation()
              useChatStore.getState().setActiveSessionId(openTarget)
            }}
            className="flex-shrink-0 px-1 py-0.5 rounded text-[10px] text-accent hover:bg-bg-hover/60 transition-colors"
          >
            {t('panel.tasksOpen')}
          </button>
        )}
        <TaskAction task={task} onStop={handleStop} onDismiss={handleDismiss} />
      </div>
      {expanded && <TaskDetail task={task} />}
    </div>
  )
}

type RevealRequest = NonNullable<ChatState['taskRevealRequest']>

/**
 * 已经有面板处理过的那条揭示请求（按对象认，nonce 只在同一个 store 里单调）。
 *
 * 面板收起时会话面板整块不渲染，点对话卡上的状态是「先发请求、再把面板打开」—— 本组件挂载时
 * 请求已经在那儿了，订阅只看得到之后的变化。所以挂载时补处理一次还没人处理过的请求；
 * 处理过的不再处理，否则收起再打开会把很久以前点过的那条又展开一遍。
 */
let handledReveal: RevealRequest | null = null

function pendingReveal(): RevealRequest | null {
  const req = useChatStore.getState().taskRevealRequest
  return req && req !== handledReveal ? req : null
}

/** 运行中每秒走一次字（时长）；只剩已完成的时半分钟一次就够（「多久前结束」精度到分钟） */
const TICK_RUNNING_MS = 1000
const TICK_FINISHED_MS = 30_000

/**
 * 揭示时把那一行滚进视野 —— 只动面板自己的滚动容器。`scrollIntoView` 会连带滚动所有祖先
 * （包括 overflow-hidden 的布局容器），在这里会把整个窗口的布局推歪。
 * 行比容器高（展开着长转写）时让行首对齐容器顶，不把它推到看不见行首的位置。
 */
function scrollRowIntoView(box: HTMLElement, taskId: string): void {
  const row = [...box.querySelectorAll<HTMLElement>('[data-task-id]')].find(
    (el) => el.getAttribute('data-task-id') === taskId
  )
  if (!row) return
  const r = row.getBoundingClientRect()
  const b = box.getBoundingClientRect()
  if (r.top < b.top) box.scrollTop -= b.top - r.top
  else if (r.bottom > b.bottom) box.scrollTop += Math.min(r.bottom - b.bottom, r.top - b.top)
}

export function BgTaskPanel({ sessionId }: { sessionId: string | null }): React.JSX.Element {
  const { t } = useTranslation()
  const closeInset = usePanelCloseInset()
  const tasks = useBgTasks(sessionId)
  // 最近一次揭示请求：既驱动「滚到那一行」，也让被揭示的那条在已完成组里哪怕排在折叠线以下也画出来。
  // 初值是挂载前就发出、还没人处理的那条（见 handledReveal）
  const [reveal, setReveal] = useState<RevealRequest | null>(pendingReveal)
  const [expandedId, setExpandedId] = useState<string | null>(() => reveal?.taskId ?? null)
  const [showAllFinished, setShowAllFinished] = useState(false)
  const [collapsed, setCollapsed] = useState({ running: false, finished: false })
  const scrollRef = useRef<HTMLDivElement>(null)

  const blockedIds = useBlockedTaskIds(tasks)
  const { running, finished } = useMemo(
    () => orderTasks(tasks, (task) => blockedIds.has(task.taskId)),
    [tasks, blockedIds]
  )

  // 运行中任务的时长要走字、已完成的「多久前结束」也要跟着变（面板收起时组件卸载，不空转）
  const [now, setNow] = useState(() => Date.now())
  const tickMs =
    running.length > 0 ? TICK_RUNNING_MS : finished.length > 0 ? TICK_FINISHED_MS : null
  useEffect(() => {
    if (tickMs === null) return
    const tick = (): void => setNow(Date.now())
    // 先补一拍：停表期间（没有任务 / 只剩已完成的那半分钟）到来的任务不该拿旧时钟算「多久前」
    const first = setTimeout(tick, 0)
    const id = setInterval(tick, tickMs)
    return () => {
      clearTimeout(first)
      clearInterval(id)
    }
  }, [tickMs])

  // 已完成组：默认只露最近几条。被揭示的那条在折叠线以下时整组展开 —— 点了对话卡上的状态却看不见那一行，等于没揭示
  const revealedIdx = reveal ? finished.findIndex((task) => task.taskId === reveal.taskId) : -1
  const showAll = showAllFinished || revealedIdx >= FINISHED_PREVIEW
  const shownFinished = showAll ? finished : finished.slice(0, FINISHED_PREVIEW)
  const olderCount = finished.length - FINISHED_PREVIEW

  // 展开互斥：点已展开的收起，否则独占展开
  const toggleExpand = useCallback(
    (taskId: string) => setExpandedId((prev) => (prev === taskId ? null : taskId)),
    []
  )

  // 对话流里那张工具卡的行尾状态被点了 → 独占展开对应那条（面板的展开/切页由宿主负责）。
  // 订阅而不是 useEffect 读取：这是「外部状态变了就 setState」，effect 体里同步 setState
  // 会引发级联渲染（react-hooks 规则直接拦）
  useEffect(
    () =>
      useChatStore.subscribe((next, prev) => {
        const req = next.taskRevealRequest
        if (req && req !== prev.taskRevealRequest) {
          setExpandedId(req.taskId)
          setReveal(req)
          // 它所在的组被组头折起来了也得打开 —— 点了却看不见那一行，等于没揭示
          const task = useBgTaskStore.getState().tasks[req.taskId]
          if (task) {
            const group = isTaskFinished(task) ? 'finished' : 'running'
            setCollapsed((c) => (c[group] ? { ...c, [group]: false } : c))
          }
        }
      }),
    []
  )

  // 揭示请求画出来之后：记为已处理，再滚（那一行此刻才在 DOM 里，可能刚因整组展开而出现）
  useEffect(() => {
    if (!reveal) return
    handledReveal = reveal
    if (scrollRef.current) scrollRowIntoView(scrollRef.current, reveal.taskId)
  }, [reveal])

  const clearFinished = useCallback(() => {
    if (!sessionId) return
    if (expandedId && finished.some((task) => task.taskId === expandedId)) setExpandedId(null)
    setShowAllFinished(false)
    setReveal(null)
    useBgTaskStore.getState().removeFinished(sessionId)
    void getHostApi()
      ?.bgTask.clearDone({ sessionId })
      .catch(() => {})
  }, [sessionId, expandedId, finished])

  const finishedFooter =
    olderCount > 0 ? (
      <button
        data-task-older=""
        onClick={() => {
          if (showAll) {
            setShowAllFinished(false)
            setReveal(null)
          } else setShowAllFinished(true)
        }}
        className="w-full border-t border-border-secondary/30 px-2 py-1 text-left text-[10px] text-text-tertiary hover:bg-bg-hover/30 hover:text-text-secondary transition-colors"
      >
        {showAll
          ? t('panel.tasksShowRecent', { count: FINISHED_PREVIEW })
          : t('panel.tasksShowOlder', { count: olderCount })}
      </button>
    ) : undefined

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto no-scrollbar p-1.5 bg-bg-secondary">
      {/* 让位只给**首个可见**分组：空组渲染成 null，运行中为空时首行就是「已完成」那条 */}
      <TaskGroup
        label={t('panel.tasksRunning')}
        tasks={running}
        total={running.length}
        now={now}
        expandedId={expandedId}
        blockedIds={blockedIds}
        onToggleExpand={toggleExpand}
        collapsed={collapsed.running}
        onToggleCollapsed={() => setCollapsed((c) => ({ ...c, running: !c.running }))}
        reserveTopRight={closeInset && running.length > 0}
      />
      <TaskGroup
        label={t('panel.tasksFinished')}
        tasks={shownFinished}
        total={finished.length}
        now={now}
        expandedId={expandedId}
        blockedIds={blockedIds}
        onToggleExpand={toggleExpand}
        collapsed={collapsed.finished}
        onToggleCollapsed={() => setCollapsed((c) => ({ ...c, finished: !c.finished }))}
        onClear={clearFinished}
        footer={finishedFooter}
        reserveTopRight={closeInset && running.length === 0}
      />
    </div>
  )
}
