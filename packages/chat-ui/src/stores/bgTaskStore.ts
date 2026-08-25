/**
 * 后台任务 store —— `bash({ run_in_background: true })` 起的任务
 *
 * 纯内存、事件驱动，形态对齐 subSessionStore：`bg_task` ChatEvent 到达即 upsert，
 * 面板收起（组件卸载）不影响状态，重新展开时完整。
 *
 * **这里不存输出**。子进程的 stdout/stderr 由 OS 直接写日志文件，面板展开某条任务时
 * 按字节范围轮询 `bgTask.readLog` 自取；本 store 只管任务的元信息与状态。
 * 见 docs/background-tasks-design.md。
 */

import { create } from 'zustand'
import { useMemo } from 'react'
import type { BgTaskInfo } from '@shuvix/chat-protocol/types/bgTask'

interface BgTaskStore {
  /** toolCallId → 任务快照（全会话共存，取用侧按 sessionId 过滤） */
  tasks: Record<string, BgTaskInfo>

  /** 事件到达 / 快照补齐：按 toolCallId 覆盖写 */
  upsert: (task: BgTaskInfo) => void
  /** 用会话快照整体替换该会话的条目（挂载 / 切会话时调用） */
  replaceSession: (sessionId: string, tasks: BgTaskInfo[]) => void
  /** 移除单条（用户 dismiss 后调用） */
  remove: (toolCallId: string) => void
  /** 移除会话内所有已结束的条目（用户「清空」后调用） */
  removeFinished: (sessionId: string) => void
}

export const useBgTaskStore = create<BgTaskStore>((set) => ({
  tasks: {},

  upsert: (task) => set((s) => ({ tasks: { ...s.tasks, [task.toolCallId]: task } })),

  replaceSession: (sessionId, list) =>
    set((s) => {
      const next: Record<string, BgTaskInfo> = {}
      for (const [id, task] of Object.entries(s.tasks)) {
        if (task.sessionId !== sessionId) next[id] = task
      }
      for (const task of list) next[task.toolCallId] = task
      return { tasks: next }
    }),

  remove: (toolCallId) =>
    set((s) => {
      if (!s.tasks[toolCallId]) return s
      const next = { ...s.tasks }
      delete next[toolCallId]
      return { tasks: next }
    }),

  removeFinished: (sessionId) =>
    set((s) => {
      const next: Record<string, BgTaskInfo> = {}
      for (const [id, task] of Object.entries(s.tasks)) {
        if (task.sessionId !== sessionId || task.status === 'running') next[id] = task
      }
      return { tasks: next }
    })
}))

/**
 * 某会话的任务列表（启动时间正序）。
 *
 * 用 useMemo 包一层而非直接在 selector 里 filter：zustand 的 selector 每次都会返回
 * 新数组引用，等于每次 store 变动都重渲染。这里依赖 tasks 引用做记忆化。
 */
export function useBgTasks(sessionId: string | null): BgTaskInfo[] {
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
      if (task.sessionId === sessionId && task.status === 'running') n++
    }
    return n
  })
}

/** 单条任务的实时态（对话内工具卡按 toolCallId 取用） */
export function useBgTask(toolCallId: string | undefined): BgTaskInfo | undefined {
  return useBgTaskStore((s) => (toolCallId ? s.tasks[toolCallId] : undefined))
}
