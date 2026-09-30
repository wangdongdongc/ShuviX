import { ipcMain } from 'electron'
import { taskRegistry } from '../services/taskRegistry'
import {
  readBgTaskLog,
  stopBgTask,
  dismissBgTask,
  clearFinishedBgTasks
} from '../services/bgTaskService'
import { readInvocation } from '../services/commandInvocation'

/**
 * 后台任务 IPC —— `bash({ run_in_background: true })` 起的任务的只读面与管理动作。
 *
 * 这里**没有输出流通道**：子进程的 stdout/stderr 由 OS 直接写日志文件，渲染端要看实时
 * 输出就轮询 `bgTask:readLog` 取字节范围；任务状态变更走 `bg_task` ChatEvent 广播。
 * 也没有输入通道 —— 后台任务的 stdin 是 /dev/null，见 bgTaskService 文件头第 5 点。
 * 见 docs/background-tasks-design.md。
 */
export function registerBgTaskHandlers(): void {
  // ─── 只读（SessionChannelApi 面）──────────────

  // 三类任务混排一张表 —— 面板按 kind 选渲染器（bash 终端 / 派生 agent 转写 / 子会话跳转）
  ipcMain.handle('bgTask:list', (_event, params: { sessionId: string }) =>
    taskRegistry.list(params.sessionId)
  )

  ipcMain.handle(
    'bgTask:readLog',
    (_event, params: { toolCallId: string; fromByte?: number; maxBytes?: number }) =>
      readBgTaskLog(params)
  )

  // ─── 管理动作（HostApi 面）────────────────────

  ipcMain.handle('bgTask:stop', (_event, params: { toolCallId: string; force?: boolean }) => ({
    success: stopBgTask(params.toolCallId, params.force)
  }))

  ipcMain.handle('bgTask:dismiss', (_event, params: { toolCallId: string }) => ({
    success: dismissBgTask(params.toolCallId)
  }))

  ipcMain.handle('bgTask:clearDone', (_event, params: { sessionId: string }) => ({
    cleared: clearFinishedBgTasks(params.sessionId)
  }))

  // 工具卡上「实际执行命令」：只读，但暴露本机沙箱规则与路径，归宿主面（渠道端没有 shell 工具）
  ipcMain.handle(
    'bgTask:readInvocation',
    (_event, params: { sessionId: string; toolCallId: string }) =>
      readInvocation(params.sessionId, params.toolCallId)
  )
}
