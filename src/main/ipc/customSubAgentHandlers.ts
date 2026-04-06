import { ipcMain } from 'electron'
import { customSubAgentDao } from '../dao/customSubAgentDao'
import {
  registerCustomSubAgent,
  unregisterCustomSubAgent,
  reloadCustomSubAgent,
  toggleCustomSubAgent
} from '../subagent'
import type { CustomSubAgentAddParams, CustomSubAgentUpdateParams } from '../types'

/**
 * 自定义子智能体管理 IPC 处理器
 */
export function registerCustomSubAgentHandlers(): void {
  /** 获取所有子智能体（含内置） */
  ipcMain.handle('customSubAgent:list', () => {
    return customSubAgentDao.findAll()
  })

  /** 添加自定义子智能体 */
  ipcMain.handle('customSubAgent:add', (_event, params: CustomSubAgentAddParams) => {
    const id = customSubAgentDao.insert(params)
    const agent = customSubAgentDao.findById(id)!
    registerCustomSubAgent(agent)
    return { id }
  })

  /** 更新自定义子智能体（内置不可修改） */
  ipcMain.handle('customSubAgent:update', (_event, params: CustomSubAgentUpdateParams) => {
    const existing = customSubAgentDao.findById(params.id)
    if (!existing) return { success: false }
    if (existing.isBuiltin) return { success: false }
    const { id, ...fields } = params
    customSubAgentDao.update(id, fields)
    const agent = customSubAgentDao.findById(id)
    if (agent) {
      reloadCustomSubAgent(agent)
    }
    return { success: true }
  })

  /** 删除自定义子智能体（内置不可删除） */
  ipcMain.handle('customSubAgent:delete', (_event, id: string) => {
    const agent = customSubAgentDao.findById(id)
    if (!agent || agent.isBuiltin) return { success: false }
    unregisterCustomSubAgent(agent.name)
    customSubAgentDao.deleteById(id)
    return { success: true }
  })

  /** 切换启用/禁用 */
  ipcMain.handle('customSubAgent:toggle', (_event, params: { id: string; enabled: boolean }) => {
    const agent = customSubAgentDao.findById(params.id)
    if (!agent) return { success: false }
    customSubAgentDao.setEnabled(params.id, params.enabled)
    toggleCustomSubAgent(agent, params.enabled)
    return { success: true }
  })
}
