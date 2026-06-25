import { ipcMain } from 'electron'
import { agentService } from '../services/agentService'
import { sessionService } from '../services/sessionService'
import type { AgentDefinition } from '@shuvix/agent-runtime'

/**
 * Sub-Agent 文件系统管理 IPC 处理器
 *
 * 仅暴露读 / 启用切换 / 打开文件夹 / 刷新；CRUD 由用户直接编辑文件完成。
 */
export function registerSubAgentHandlers(): void {
  /** 列出所有 agent（含内置 + 用户），带启用状态 */
  ipcMain.handle('subAgent:list', (): AgentDefinition[] => agentService.listAll())

  /** 重扫文件系统并把变化级联到所有活跃 AgentSession */
  ipcMain.handle('subAgent:refresh', () => {
    sessionService.rebuildToolsForAllSessions()
    return { success: true }
  })

  /** 切换启用/禁用（仅用户 agent 可切；内置返回 error） */
  ipcMain.handle('subAgent:setEnabled', (_e, params: { name: string; enabled: boolean }) => {
    const res = agentService.setEnabled(params.name, params.enabled)
    if (res.success) sessionService.rebuildToolsForAllSessions()
    return res
  })

  /** 打开用户 agents 目录（OS 文件管理器） */
  ipcMain.handle('subAgent:openFolder', async () => {
    await agentService.openUserFolder()
    return { success: true }
  })
}
