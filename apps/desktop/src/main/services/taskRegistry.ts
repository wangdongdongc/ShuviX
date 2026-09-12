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
 * **过渡期投影**：把统一快照压回旧的 `BgTaskInfo` 形状，非 bash 任务返回 null。
 *
 * 前端这一侧还认 `bg_task` 事件与 `BgTaskInfo`（面板只会画 bash 那一种）。S2 把面板改成
 * 按 kind 选渲染器之后，这里连同 `bg_task` 事件一起换成直接下发 `TaskInfo`，本函数删除。
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
    logCapped,
    notifyAgent: task.notifyAgent
  }
}

export const taskRegistry = createTaskRegistry({
  broadcast: (task) => {
    const info = toBgTaskInfo(task)
    if (!info) return
    chatFrontendRegistry.broadcast({ type: 'bg_task', sessionId: task.sessionId, task: info })
  },
  deliver: (sessionId, text) => notifier?.(sessionId, text),
  logger: log
})
