/**
 * 后台任务 store —— bash 命令、派生 agent、子会话轮次共用的一张表
 *
 * 纯内存、事件驱动：`bg_task` ChatEvent 到达即按 taskId upsert，面板收起（组件卸载）
 * 不影响状态，重新展开时完整。**只记录本次应用运行期间的任务**（重启即空）——
 * 面板的意义是「这次跑起来之后它都在后台干了些什么」，不是一份跨会话的历史账。
 *
 * **这里不存内容**。bash 的 stdout/stderr 由 OS 直接写日志文件（面板展开某条时按字节
 * 范围轮询 `bgTask.readLog` 自取）；派生 agent 的转写在 subSessionStore 里（事件流累积）；
 * 子会话的转写在它自己的会话里。本 store 只管任务的元信息与状态。
 * 见 docs/background-task-hub-design.md。
 */

import { create } from 'zustand'
import { useMemo } from 'react'
import type { TaskInfo } from '@shuvix/chat-protocol/types/task'

/** 已落定（含失败与被停止）—— 分组与「清空」都按这个判定 */
export function isTaskFinished(task: TaskInfo): boolean {
  return task.endedAt !== null
}

/**
 * 这条任务算不算「会话在跑」（侧栏、收件箱）：没结束的都算 —— 后台命令、派发的 agent、驱动的子会话轮次 ——
 * 除了 hook 起的 agent（没有 `parentToolCallId`）：起标题、审查都是它，每轮结束后都来一下，算上的话
 * 跑完的会话还要再闪几秒。
 */
export function countsAsSessionBusy(task: TaskInfo): boolean {
  if (isTaskFinished(task)) return false
  return !(task.subject.kind === 'agent' && task.subject.parentToolCallId === undefined)
}

interface BgTaskStore {
  /** taskId → 任务快照（全会话共存，取用侧按 sessionId 过滤） */
  tasks: Record<string, TaskInfo>

  /** 事件到达 / 快照补齐：按 taskId 覆盖写 */
  upsert: (task: TaskInfo) => void
  /** 用会话快照整体替换该会话的条目（挂载 / 切会话时调用） */
  replaceSession: (sessionId: string, tasks: TaskInfo[]) => void
  /** 整张表换成主进程的快照（`bgTask.listAll`）：补上错过的事件，断线期间已结束的也随之落定 */
  replaceAll: (tasks: TaskInfo[]) => void
  /** 移除单条（用户 dismiss 后调用） */
  remove: (taskId: string) => void
  /** 移除会话内所有已结束的条目（用户「清空」后调用） */
  removeFinished: (sessionId: string) => void
}

export const useBgTaskStore = create<BgTaskStore>((set) => ({
  tasks: {},

  upsert: (task) => set((s) => ({ tasks: { ...s.tasks, [task.taskId]: task } })),

  replaceSession: (sessionId, list) =>
    set((s) => {
      const next: Record<string, TaskInfo> = {}
      for (const [id, task] of Object.entries(s.tasks)) {
        if (task.sessionId !== sessionId) next[id] = task
      }
      for (const task of list) next[task.taskId] = task
      return { tasks: next }
    }),

  replaceAll: (list) => set({ tasks: Object.fromEntries(list.map((t) => [t.taskId, t])) }),

  remove: (taskId) =>
    set((s) => {
      if (!s.tasks[taskId]) return s
      const next = { ...s.tasks }
      delete next[taskId]
      return { tasks: next }
    }),

  removeFinished: (sessionId) =>
    set((s) => {
      const next: Record<string, TaskInfo> = {}
      for (const [id, task] of Object.entries(s.tasks)) {
        if (task.sessionId !== sessionId || !isTaskFinished(task)) next[id] = task
      }
      return { tasks: next }
    })
}))

/**
 * 会话在跑的是哪一种 —— 侧栏与收件箱共用这一套记号（2026-11-11 用户选定 S1）：
 * `agent` = 有 agent 在干活（自己这一轮、派发的 agent、驱动的子会话轮次），会话图标蓝色、实心、呼吸；
 * `resident` = agent 停了，只剩后台命令开着（命令工具起的后台任务，远端的也算），图标绿色、实心、不动。
 * 两样都有算 `agent`。
 */
export type SessionRunKind = 'agent' | 'resident'

/** 一条任务让它的会话处于哪种在跑；不算数的（已结束、hook 起的 agent）→ null */
export function taskRunKind(task: TaskInfo): SessionRunKind | null {
  if (!countsAsSessionBusy(task)) return null
  return task.subject.kind === 'bash' ? 'resident' : 'agent'
}

/**
 * 各会话的后台任务让它处于哪种在跑（同一会话里有 agent 类的任务就是 `agent`）。自己这一轮在跑另算：
 * 那一份在 chatStore（`selectStreamingSessions`），由用的一方合上 —— 这一轮在跑就是 `agent`。
 * 值不变时引用稳定：任务来来去去，不该让整个侧栏跟着重渲染
 */
let _lastKindsInput: BgTaskStore['tasks'] | null = null
let _lastKinds: Record<string, SessionRunKind> = {}
export const selectBgRunKinds = (s: BgTaskStore): Record<string, SessionRunKind> => {
  if (s.tasks === _lastKindsInput) return _lastKinds
  _lastKindsInput = s.tasks
  const next: Record<string, SessionRunKind> = {}
  for (const task of Object.values(s.tasks)) {
    const kind = taskRunKind(task)
    if (kind && next[task.sessionId] !== 'agent') next[task.sessionId] = kind
  }
  const prev = _lastKinds
  const same =
    Object.keys(next).length === Object.keys(prev).length &&
    Object.keys(next).every((k) => prev[k] === next[k])
  if (!same) _lastKinds = next
  return _lastKinds
}

/**
 * 某会话的任务列表（启动时间正序）。
 *
 * 用 useMemo 包一层而非直接在 selector 里 filter：zustand 的 selector 每次都会返回
 * 新数组引用，等于每次 store 变动都重渲染。这里依赖 tasks 引用做记忆化。
 */
export function useBgTasks(sessionId: string | null): TaskInfo[] {
  const tasks = useBgTaskStore((s) => s.tasks)
  return useMemo(() => {
    if (!sessionId) return []
    return Object.values(tasks)
      .filter((task) => task.sessionId === sessionId)
      .sort((a, b) => a.startedAt - b.startedAt)
  }, [tasks, sessionId])
}

/** 会话内任务总数（决定面板 tab 是否出现） */
export function useBgTaskCount(sessionId: string | null): number {
  return useBgTaskStore((s) => {
    if (!sessionId) return 0
    let n = 0
    for (const task of Object.values(s.tasks)) if (task.sessionId === sessionId) n++
    return n
  })
}

/** 会话内运行中的任务数（tab 徽标） */
export function useBgTaskRunningCount(sessionId: string | null): number {
  return useBgTaskStore((s) => {
    if (!sessionId) return 0
    let n = 0
    for (const task of Object.values(s.tasks)) {
      if (task.sessionId === sessionId && !isTaskFinished(task)) n++
    }
    return n
  })
}

/** 单条任务的实时态 */
export function useBgTask(taskId: string | undefined): TaskInfo | undefined {
  return useBgTaskStore((s) => (taskId ? s.tasks[taskId] : undefined))
}

/**
 * 对话流里那张工具卡按 tool_call id 找自己的任务。
 *
 * bash 的 taskId 就是 tool_call id（同一个东西，命中是 O(1)）；派生 agent 的 taskId 是它的
 * 事件频道 id，派发它的 tool_call id 记在 subject 上，只能扫一遍 —— 一个会话里的任务是
 * 个位数量级，这点扫描比为它维护第二张索引便宜。
 */
export function useBgTaskByToolCall(toolCallId: string | undefined): TaskInfo | undefined {
  return useBgTaskStore((s) => {
    if (!toolCallId) return undefined
    const direct = s.tasks[toolCallId]
    if (direct) return direct
    for (const task of Object.values(s.tasks)) {
      if (task.subject.kind === 'agent' && task.subject.parentToolCallId === toolCallId) return task
    }
    return undefined
  })
}
