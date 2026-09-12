/**
 * 后台任务枢纽的桌面实例 —— 进程内唯一的一份任务登记簿。
 *
 * 内核（等待策略 / 通知规则 / 宣告时机）在 `@shuvix/agent-runtime` 的 task/registry，
 * 两端共用；这里只接两根线：状态广播接桌面的前端注册表，通知投递接会话的 AgentSession。
 *
 * **通知用注入而不是直连 sessionService**：后者已经 import 本模块的使用方
 * （删会话时级联杀任务），直连会成环 —— 与旧 `setBgTaskNotifier` 同一理由，同一形状。
 */
import { createTaskRegistry, type TaskInfo } from '@shuvix/agent-runtime'
import type { BgTaskInfo } from '@shuvix/chat-protocol/types/bgTask'
import { chatFrontendRegistry } from '../frontend/core/ChatFrontendRegistry'
import { createLogger } from '../logger'

const log = createLogger('TaskRegistry')

/** 任务结束时把结果告知智能体；由 sessionService 在启动时注入 */
export type TaskNotifier = (sessionId: string, text: string) => void

let notifier: TaskNotifier | null = null

export function setTaskNotifier(fn: TaskNotifier): void {
  notifier = fn
}

/**
 * 把统一快照压回 `BgTaskInfo` 形状，非 bash 任务返回 null。
 *
 * 事件与面板早已改吃 `TaskInfo`，这里只剩 bash 自己那一面还用得上：启动回执、
 * 「同时跑太多」的错误列表、以及 bash 工具面向模型的那几段文案都按 pid / 日志路径说话。
 */
export function toBgTaskInfo(task: TaskInfo): BgTaskInfo | null {
  if (task.subject.kind !== 'bash') return null
  const { command, cwd, pid, logPath, exitCode, signal, logCapped } = task.subject
  return {
    toolCallId: task.taskId,
    sessionId: task.sessionId,
    command,
    description: task.title,
    cwd,
    pid,
    logPath,
    // 统一状态里 done/error 都是「跑完了」，旧契约只分 exited / killed
    status: task.status === 'killed' ? 'killed' : task.endedAt === null ? 'running' : 'exited',
    exitCode,
    signal,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    logCapped
  }
}

export const taskRegistry = createTaskRegistry({
  broadcast: (task) =>
    chatFrontendRegistry.broadcast({ type: 'bg_task', sessionId: task.sessionId, task }),
  deliver: (sessionId, text) => notifier?.(sessionId, text),
  logger: log
})
