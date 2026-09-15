/**
 * 后台任务枢纽 —— bash 命令、派生 agent、子会话轮次共用的登记簿、等待器与通知中枢。
 *
 * 设计见 docs/background-task-hub-design.md。本文件只管簿记与等待，**数据完全不经手**：
 * 输出怎么产生、进程怎么杀、转写存在哪，全部由各 kind 的拥有者（bgTaskService /
 * SubAgentManager / subSessionRunner）实现，经 `create` 的回调注入。
 *
 * 三条立足点：
 *
 *  1. **「前台 / 后台」退化成 `join` 的两组参数**。原先两套机制其实互为镜像 ——
 *     bash 的预热窗口是「按异步起、窗口内落定就同步回话」，子会话的超时降级是
 *     「按同步等、到点不杀转异步」。合成一个原语后，`run_in_background: true` 只是
 *     「maxWait = 预热窗口、onTimeout = detach」的别名，工具契约一个字不用改。
 *
 *  2. **通知只剩一条规则**：落定时还有人在等 → 结果由那次调用交回，不通知；没人等 → 通知。
 *     原先散在两处的「没宣告过不通知」「已有人在 wait 不通知」被它完全吸收。
 *
 *  3. **宣告是延迟的**。任务一落地就广播会让面板被一排 100ms 就结束的 `ls` 淹掉，
 *     所以：脱离等待者时立刻宣告，否则等 `announceAfter`；没宣告过的任务结束时也不广播
 *     —— 否则前端会凭空多出一条自己从没见过 started 的幽灵条目。
 */
import { v4 as uuid } from 'uuid'
import type { TaskInfo, TaskKind, TaskStatus, TaskSubject } from '@shuvix/chat-protocol/types/task'
import type { RuntimeLogger } from '../types'

export type { TaskInfo, TaskKind, TaskStatus, TaskSubject }

/** 通知合并窗口 —— 一批几乎同时落定的任务并成一条通知，而不是连发数条打断智能体 */
const DEFAULT_COALESCE_MS = 250

export interface TaskRegistryDeps {
  /** 状态变更广播（快照 upsert）。低频：每任务至多 2 次，输出增量不走这条路 */
  broadcast: (task: TaskInfo) => void
  /** 通知投递 —— 文本已由中枢合并成一条（多个通知信封块以空行相连） */
  deliver: (sessionId: string, text: string) => void
  logger?: RuntimeLogger
  /** 合并窗口（测试里调小） */
  coalesceMs?: number
  now?: () => number
}

export interface CreateTaskParams {
  /** 发起它的 tool_call id；省略则发 uuid（hook run / 用户从面板发起） */
  taskId?: string
  kind: TaskKind
  sessionId: string
  title: string
  subject: TaskSubject
  /**
   * 仍在跑超过这么久才进面板（毫秒）。默认 0 = 立刻；`Infinity` = 除非脱离等待者否则永不进。
   * 同步 bash 用后者 —— 一条 `ls` 不该在面板里留下痕迹。
   */
  announceAfter?: number
  /** 落定时的通知文案；返回空串 / null = 这条不通知 */
  formatNotice?: (task: TaskInfo) => string | null | undefined
  /** 停止实现（killProcessTree / runtime.abort / …）。没给 = 这类任务停不了 */
  stop?: (force: boolean) => void | Promise<void>
}

export interface JoinPolicy {
  /** 等多久（毫秒）。省略 = 不限时 */
  maxWait?: number
  /** 到点怎么办：转异步（默认）还是杀掉 */
  onTimeout?: 'detach' | 'kill'
  /** 本次调用的中止信号 */
  signal?: AbortSignal
  /** 被中止时怎么办：杀掉（默认）还是放手让它继续跑 */
  onAbort?: 'kill' | 'detach'
  /**
   * 杀的时候直接下死手（透传给拥有者的停止实现）。
   *
   * 给「超时」与「用户点停止生成」用：这两种情形下进程多半已经不响应温和信号了，
   * 而调用方正等着这次工具调用返回 —— 先 SIGINT 再等升级只是让它多等几秒。
   * 用户从面板按的那枚停止键不走这里（那是 `stop`，默认给进程清理的机会）。
   */
  killForce?: boolean
}

export interface JoinOutcome {
  kind: 'settled' | 'detached'
  /** 'finished' = 自己跑完的；'timeout' / 'abort' = 因等待策略而落定或放手 */
  reason: 'finished' | 'timeout' | 'abort'
  task: TaskInfo
}

export interface SettlePatch {
  status: Exclude<TaskStatus, 'running' | 'waiting-input'>
  subject?: Partial<TaskSubject>
}

interface Waiter {
  resolve: (outcome: JoinOutcome) => void
  done: boolean
  /** 本次等待因何落定 —— 超时杀 / 中止杀 时由 join 改写，拥有者的 settle 不必知情 */
  reason: 'finished' | 'timeout' | 'abort'
}

interface TaskEntry {
  info: TaskInfo
  waiters: Set<Waiter>
  /** 已向前端宣告过（没宣告过的任务结束时也不广播，见文件头第 3 点） */
  announced: boolean
  announceTimer: ReturnType<typeof setTimeout> | null
  /** 谁停的 —— 智能体自己停的不必再通知它（它早就知道），用户停的要通知 */
  stoppedBy: 'agent' | 'user' | null
  formatNotice?: (task: TaskInfo) => string | null | undefined
  stop?: (force: boolean) => void | Promise<void>
}

export interface TaskRegistry {
  create: (params: CreateTaskParams) => string
  join: (taskId: string, policy?: JoinPolicy) => Promise<JoinOutcome | undefined>
  /** 拥有者在底层落定时调用 —— 解挂等待者，没人等就交给通知中枢 */
  settle: (taskId: string, patch: SettlePatch) => void
  /** 运行中的状态 / 专属面更新（`waiting-input`、日志超阈值…） */
  update: (taskId: string, patch: { status?: TaskStatus; subject?: Partial<TaskSubject> }) => void
  /**
   * 已落定的任务又跑起来了 —— 用户在面板里追问一个跑完的派生 agent。
   * 那条面板行代表的是**那个 agent**，不是它的某一轮，所以复用同一条任务而不是另起一条。
   */
  reopen: (taskId: string) => boolean
  stop: (taskId: string, opts?: { by?: 'agent' | 'user'; force?: boolean }) => boolean
  get: (taskId: string) => TaskInfo | undefined
  list: (sessionId: string) => TaskInfo[]
  runningCount: (sessionId: string, kind?: TaskKind) => number
  /** 移除一条已结束的任务（运行中的不移除） */
  dismiss: (taskId: string) => boolean
  clearFinished: (sessionId: string) => number
  /** 删除会话 / 应用退出：停掉并清空（日志文件等资源由拥有者各自清理） */
  killBySession: (sessionId: string) => void
  killAll: () => void
}

export function createTaskRegistry(deps: TaskRegistryDeps): TaskRegistry {
  const tasks = new Map<string, TaskEntry>()
  const coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS
  const now = deps.now ?? (() => Date.now())
  /** 待投递的通知，按会话聚拢 */
  const pending = new Map<string, { blocks: string[]; timer: ReturnType<typeof setTimeout> }>()

  const snapshot = (entry: TaskEntry): TaskInfo => ({
    ...entry.info,
    subject: { ...entry.info.subject }
  })

  function announce(entry: TaskEntry): void {
    if (entry.announceTimer) {
      clearTimeout(entry.announceTimer)
      entry.announceTimer = null
    }
    entry.announced = true
    deps.broadcast(snapshot(entry))
  }

  /** 状态已变：宣告过的才广播（见文件头第 3 点） */
  function touch(entry: TaskEntry): void {
    if (entry.announced) deps.broadcast(snapshot(entry))
  }

  function enqueueNotice(sessionId: string, text: string): void {
    const slot = pending.get(sessionId)
    if (slot) {
      slot.blocks.push(text)
      return
    }
    const timer = setTimeout(() => {
      const batch = pending.get(sessionId)
      pending.delete(sessionId)
      if (batch?.blocks.length) deps.deliver(sessionId, batch.blocks.join('\n\n'))
    }, coalesceMs)
    timer.unref?.()
    pending.set(sessionId, { blocks: [text], timer })
  }

  /**
   * 级联清理一条任务（删会话 / 应用退出）：停掉它，**并把还挂在它上面的等待者解开**。
   *
   * 解挂这一步是必须的 —— 条目一删，拥有者稍后送回来的 settle 就落空了，
   * 那次 `join` 会永远停在那里（在 bash 上就是一次再也不返回的工具调用）。
   * 这条落定不发通知：会话都没了，没人需要被叫醒。
   */
  function teardown(entry: TaskEntry): void {
    if (entry.announceTimer) clearTimeout(entry.announceTimer)
    if (entry.info.endedAt !== null) return
    entry.stoppedBy = 'agent'
    void entry.stop?.(true)
    entry.info.status = 'killed'
    entry.info.endedAt = now()
    resolveWaiters(entry, snapshot(entry))
  }

  function resolveWaiters(entry: TaskEntry, task: TaskInfo): number {
    let n = 0
    for (const waiter of [...entry.waiters]) {
      if (waiter.done) continue
      waiter.done = true
      n++
      waiter.resolve({ kind: 'settled', reason: waiter.reason, task })
    }
    entry.waiters.clear()
    return n
  }

  return {
    create(params) {
      const taskId = params.taskId ?? uuid()
      const info: TaskInfo = {
        taskId,
        kind: params.kind,
        sessionId: params.sessionId,
        title: params.title,
        status: 'running',
        detached: false,
        startedAt: now(),
        endedAt: null,
        subject: params.subject
      }
      const entry: TaskEntry = {
        info,
        waiters: new Set(),
        announced: false,
        announceTimer: null,
        stoppedBy: null,
        formatNotice: params.formatNotice,
        stop: params.stop
      }
      tasks.set(taskId, entry)

      const delay = params.announceAfter ?? 0
      if (delay <= 0) announce(entry)
      else if (Number.isFinite(delay)) {
        entry.announceTimer = setTimeout(() => {
          entry.announceTimer = null
          if (entry.info.status === 'running' || entry.info.status === 'waiting-input')
            announce(entry)
        }, delay)
        entry.announceTimer.unref?.()
      }
      deps.logger?.info?.(`task create ${taskId} kind=${params.kind} session=${params.sessionId}`)
      return taskId
    },

    join(taskId, policy = {}) {
      const entry = tasks.get(taskId)
      if (!entry) return Promise.resolve(undefined)

      // 已经落定的：立刻交回，不再挂等待者（也就不会再触发通知）
      if (entry.info.endedAt !== null) {
        return Promise.resolve<JoinOutcome>({
          kind: 'settled',
          reason: 'finished',
          task: snapshot(entry)
        })
      }

      const { maxWait, onTimeout = 'detach', signal, onAbort = 'kill', killForce = false } = policy
      // 重新 join 一条已脱离的任务（`task.wait`）—— 它重新有人等了
      entry.info.detached = false

      return new Promise<JoinOutcome>((resolve) => {
        const waiter: Waiter = { done: false, reason: 'finished', resolve: () => {} }
        let timer: ReturnType<typeof setTimeout> | null = null

        const finish = (outcome: JoinOutcome): void => {
          if (timer) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbortEvent)
          entry.waiters.delete(waiter)
          resolve(outcome)
        }
        waiter.resolve = finish

        /** 放手：任务继续跑，本次调用不再等 —— 它此后落定就该走通知 */
        const letGo = (reason: 'timeout' | 'abort'): void => {
          if (waiter.done) return
          waiter.done = true
          entry.info.detached = true
          announce(entry)
          finish({ kind: 'detached', reason, task: snapshot(entry) })
        }

        /** 杀：等待者留在原地，等拥有者把 settle 送回来（届时结果里就是 killed） */
        const killAndWait = (reason: 'timeout' | 'abort'): void => {
          if (waiter.done) return
          waiter.reason = reason
          entry.stoppedBy = 'agent'
          void entry.stop?.(killForce)
        }

        // 声明式函数：finish / letGo / onAbortEvent 互相引用，靠提升解环
        function onAbortEvent(): void {
          if (onAbort === 'detach') letGo('abort')
          else killAndWait('abort')
        }

        entry.waiters.add(waiter)

        if (signal?.aborted) onAbortEvent()
        else signal?.addEventListener('abort', onAbortEvent, { once: true })

        if (maxWait !== undefined && Number.isFinite(maxWait)) {
          timer = setTimeout(
            () => (onTimeout === 'kill' ? killAndWait('timeout') : letGo('timeout')),
            Math.max(0, maxWait)
          )
          timer.unref?.()
        }
      })
    },

    settle(taskId, patch) {
      const entry = tasks.get(taskId)
      if (!entry || entry.info.endedAt !== null) return
      entry.info.status = patch.status
      entry.info.endedAt = now()
      if (patch.subject) {
        entry.info.subject = { ...entry.info.subject, ...patch.subject } as TaskSubject
      }
      if (entry.announceTimer) {
        clearTimeout(entry.announceTimer)
        entry.announceTimer = null
      }
      deps.logger?.info?.(`task settle ${taskId} status=${patch.status}`)

      const had = resolveWaiters(entry, snapshot(entry))
      touch(entry)

      // 唯一一条通知规则：落定时还有人在等 → 结果由那次调用交回，不通知
      if (had > 0) return
      // 智能体自己停的不必再通知它；用户从面板停的要通知
      if (entry.stoppedBy === 'agent') return
      const text = entry.formatNotice?.(snapshot(entry))
      if (text) enqueueNotice(entry.info.sessionId, text)
    },

    update(taskId, patch) {
      const entry = tasks.get(taskId)
      if (!entry || entry.info.endedAt !== null) return
      if (patch.status) entry.info.status = patch.status
      if (patch.subject) {
        entry.info.subject = { ...entry.info.subject, ...patch.subject } as TaskSubject
      }
      touch(entry)
    },

    reopen(taskId) {
      const entry = tasks.get(taskId)
      if (!entry || entry.info.endedAt === null) return false
      entry.info.status = 'running'
      entry.info.endedAt = null
      entry.stoppedBy = null
      touch(entry)
      return true
    },

    stop(taskId, opts = {}) {
      const entry = tasks.get(taskId)
      if (!entry || entry.info.endedAt !== null || !entry.stop) return false
      entry.stoppedBy = opts.by ?? 'user'
      void entry.stop(opts.force ?? false)
      return true
    },

    get(taskId) {
      const entry = tasks.get(taskId)
      return entry ? snapshot(entry) : undefined
    },

    list(sessionId) {
      return [...tasks.values()]
        .filter((e) => e.info.sessionId === sessionId && e.announced)
        .sort((a, b) => a.info.startedAt - b.info.startedAt)
        .map(snapshot)
    },

    runningCount(sessionId, kind) {
      let n = 0
      for (const entry of tasks.values()) {
        if (entry.info.sessionId !== sessionId) continue
        if (kind && entry.info.kind !== kind) continue
        if (entry.info.endedAt === null) n++
      }
      return n
    },

    dismiss(taskId) {
      const entry = tasks.get(taskId)
      if (!entry || entry.info.endedAt === null) return false
      tasks.delete(taskId)
      return true
    },

    clearFinished(sessionId) {
      let n = 0
      for (const [id, entry] of [...tasks.entries()]) {
        if (entry.info.sessionId === sessionId && entry.info.endedAt !== null) {
          tasks.delete(id)
          n++
        }
      }
      return n
    },

    killBySession(sessionId) {
      for (const [id, entry] of [...tasks.entries()]) {
        if (entry.info.sessionId !== sessionId) continue
        teardown(entry)
        tasks.delete(id)
      }
      const slot = pending.get(sessionId)
      if (slot) {
        clearTimeout(slot.timer)
        pending.delete(sessionId)
      }
    },

    killAll() {
      for (const entry of tasks.values()) teardown(entry)
      tasks.clear()
      for (const slot of pending.values()) clearTimeout(slot.timer)
      pending.clear()
    }
  }
}
