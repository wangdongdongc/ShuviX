/**
 * 后台任务（`bash({ run_in_background: true })`）的前后端共享契约。
 *
 * 输出不走事件总线 —— 子进程的 stdout/stderr 由 OS 直接追加写 `logPath` 指向的文件
 * （落在 tool_results/ 下，模型可无询问 read）。前端要看实时输出时按字节范围轮询
 * `bgTask.readLog`，任务本身的状态变更才走 `bg_task` ChatEvent。
 * 设计缘由见 docs/background-tasks-design.md。
 */

export type BgTaskStatus = 'running' | 'exited' | 'killed'

/** 任务快照 —— 事件载荷与 `bgTask.list` 共用同一形状 */
export interface BgTaskInfo {
  /** 任务身份 = 派生它的 tool_call id（不另发明 id） */
  toolCallId: string
  sessionId: string
  command: string
  /** 来自 bash 参数的人读描述 —— 面板条目的标题 */
  description: string
  cwd: string
  /** unix 下 detached spawn，pid 同时是 pgid */
  pid: number
  /** stdout + stderr 合并追加写入的绝对路径 */
  logPath: string
  status: BgTaskStatus
  exitCode: number | null
  /** 被信号终止时的信号名 */
  signal: string | null
  startedAt: number
  endedAt: number | null
  /** 日志超过告警阈值（输出不经主进程，只能定期 fstat 近似发现） */
  logCapped: boolean
  /** 退出时是否告知 AI */
  notifyAgent: boolean
}

/** 按字节范围读日志的结果 */
export interface BgTaskLogChunk {
  /**
   * 日志文件是否存在。**空文件与文件不存在必须分开** —— 刚启动还没输出的任务
   * size 也是 0，UI 不该把它显示成「日志已不存在」。
   */
  exists: boolean
  text: string
  /** 本片起始字节偏移（调用方传入越界时会被回退到尾部窗口起点） */
  fromByte: number
  /** 下次续读的起点 */
  nextByte: number
  /** 文件当前总字节数 */
  size: number
}
