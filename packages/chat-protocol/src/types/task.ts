/**
 * 后台任务枢纽的前后端共享契约 —— bash 命令、派生 agent、子会话轮次三类运行的统一快照。
 *
 * 设计见 docs/background-task-hub-design.md。三条要点：
 *
 *  1. **「前台 / 后台」不是两种任务，而是同一个 `join` 的两组参数**（同步等待 / 异步挂起）。
 *     快照里因此没有「前台任务」这一类，只有 `detached` —— 发起它的那次调用还在不在等。
 *  2. **id 就是发起它的 tool_call id**（没有 tool call 的由管理器发 uuid），不另发明一套。
 *     它同时是 bash 的日志文件名与对话卡查实时态的 key。
 *  3. **输出不在这里**。bash 的 stdout 由 OS 直接写日志文件、派生 agent 的转写在事件流里、
 *     子会话的转写在它自己的会话里 —— 本契约只承载元信息与状态，事件因此低频（每任务 2 次）。
 */

/** 任务类别 —— 决定面板用哪个详情渲染器，以及 `subject` 的形状 */
export type TaskKind = 'bash' | 'agent' | 'sub-session'

/**
 * 任务状态。
 *
 * `waiting-input` 是**所有 kind 的一等状态**，不是子会话的专利：派生 agent 与子会话跑到一半
 * 弹安全询问时都卡在这里，而它**不会自己好起来** —— 只有用户点一下能解。脱离等待者的任务
 * 弹出的询问更没有归属者，面板是它唯一的可见位置。
 */
export type TaskStatus = 'running' | 'waiting-input' | 'done' | 'error' | 'killed'

/** bash 任务的专属面 —— 进程与日志 */
export interface BashTaskSubject {
  kind: 'bash'
  command: string
  cwd: string
  /** unix 下 detached spawn，pid 同时是 pgid */
  pid: number
  /** stdout + stderr 合并追加写入的绝对路径（模型 read 它免询问） */
  logPath: string
  exitCode: number | null
  /** 被信号终止时的信号名 */
  signal: string | null
  /** 日志超过告警阈值（输出不经主进程，只能定期 fstat 近似发现） */
  logCapped: boolean
}

/** 派生 agent 的专属面 —— `agentId` 即 taskId（它同时是派生期间全部 ChatEvent 的频道） */
export interface AgentTaskSubject {
  kind: 'agent'
  profileName: string
  /** 派生层级（根会话 = 0，直接派生 = 1） */
  depth: number
  /**
   * 派发它的那次 tool_call id（工作流 run 起的没有）。
   * 对话流里那张工具卡据此找到自己的任务，把实时状态挂在摘要行尾。
   */
  parentToolCallId?: string
}

/** 子会话轮次的专属面 —— 一次 prompt 是一个任务，子会话本身是长期实体 */
export interface SubSessionTaskSubject {
  kind: 'sub-session'
  childSessionId: string
  /** `waiting-input` 时它到底卡在什么问题上（待答询问的人读摘要） */
  blockedOn?: string[]
}

export type TaskSubject = BashTaskSubject | AgentTaskSubject | SubSessionTaskSubject

/** 任务快照 —— 事件载荷与 `task.list` 共用同一形状 */
export interface TaskInfo {
  /** 发起它的 tool_call id；无 tool call（工作流 run / 用户从面板发起）时由管理器发 uuid */
  taskId: string
  kind: TaskKind
  /** 归属的**可见**会话（派生 agent 取 rootSessionId，嵌套派生不落在中间那层身上） */
  sessionId: string
  /** 面板行标题：bash 取 description、agent 取 displayName、子会话取会话标题 */
  title: string
  status: TaskStatus
  /** 发起它的那次调用已不在等（超时降级 / 本就异步挂起） */
  detached: boolean
  /** 结束时是否告知 AI（面板开关） */
  notifyAgent: boolean
  startedAt: number
  endedAt: number | null
  subject: TaskSubject
}
