import { ipcMain } from 'electron'
import { agentService } from '../services/agentService'
import type { SubAgentCreateParams, SubAgentSaveParams } from '../types'

/**
 * Sub-Agent 文件系统管理 IPC 处理器
 *
 * 纯 md 驱动：每次 list 都现扫文件系统，派发工具执行时也按名现查 ——
 * 保存/新建/删除后无需向活跃会话级联任何刷新（派发工具描述为静态文案）。
 * 暴露读 / 保存、新建与删除（设置页 GUI）/ 打开文件夹。
 */
export function registerSubAgentHandlers(): void {
  /** 列出所有 agent（含内置 + 用户 + 被覆盖内置的展示项，现扫文件系统） */
  ipcMain.handle('subAgent:list', () => agentService.listForSettings())

  /** 保存用户 agent 定义（设置页编辑 GUI） */
  ipcMain.handle('subAgent:save', (_e, params: SubAgentSaveParams) =>
    agentService.saveAgent(params.originalName, params.agent)
  )

  /** 新建用户 agent 定义（设置页「添加自定义智能体」） */
  ipcMain.handle('subAgent:create', (_e, params: SubAgentCreateParams) =>
    agentService.createAgent(params.agent)
  )

  /** 删除用户 agent 定义文件（设置页确认后调用） */
  ipcMain.handle('subAgent:delete', (_e, params: { name: string }) =>
    agentService.deleteAgent(params.name)
  )

  /** 打开用户 agents 目录（OS 文件管理器） */
  /** md 原文读写（属性卡 + live-preview 的原文编辑路径；非法拒绝并回传解析器原因） */
  ipcMain.handle('subAgent:getSource', (_e, params: { name: string; source: 'builtin' | 'user' }) =>
    agentService.getSource(params.name, params.source)
  )
  ipcMain.handle('subAgent:saveSource', (_e, params: { originalName: string; text: string }) =>
    agentService.saveAgentSource(params.originalName, params.text)
  )
  ipcMain.handle('subAgent:createSource', (_e, params: { text: string }) =>
    agentService.createAgentSource(params.text)
  )

  ipcMain.handle('subAgent:openFolder', async () => {
    await agentService.openUserFolder()
    return { success: true }
  })
}
