import { ipcMain } from 'electron'
import { customSubAgentDao } from '../dao/customSubAgentDao'
import {
  registerCustomSubAgent,
  unregisterCustomSubAgent,
  reloadCustomSubAgent,
  toggleCustomSubAgent,
  listBuiltinSubAgents,
  setBuiltinSubAgentEnabled,
  isBuiltinSubAgent
} from '../subagent'
import type { CustomSubAgent } from '../dao/types'
import type { CustomSubAgentAddParams, CustomSubAgentUpdateParams } from '../types'

/**
 * 将内置 sub-agent 映射为 CustomSubAgent 风格的行（供 UI 统一展示）
 *
 * 内置 sub-agent 没有 DB 行，用 name 作为稳定 id。UUID 与 name 的取值空间不会冲突
 * （UUIDv7 形如 `0194...`），handler 层通过 isBuiltinSubAgent(id) 区分来源并路由。
 */
function builtinToRow(info: ReturnType<typeof listBuiltinSubAgents>[number]): CustomSubAgent {
  return {
    id: info.name,
    name: info.name,
    displayName: info.displayName,
    description: info.shortDescription || info.description,
    systemPrompt: info.systemPrompt,
    tools: [...info.tools],
    maxTurns: info.maxTurns,
    isBuiltin: true,
    isEnabled: info.isEnabled,
    metadata: {},
    createdAt: 0,
    updatedAt: 0
  }
}

/**
 * 自定义子智能体管理 IPC 处理器
 */
export function registerCustomSubAgentHandlers(): void {
  /** 获取所有子智能体（内置 code-driven + 用户自定义 DB-driven） */
  ipcMain.handle('customSubAgent:list', () => {
    const builtins = listBuiltinSubAgents().map(builtinToRow)
    const customs = customSubAgentDao.findAll()
    return [...builtins, ...customs]
  })

  /** 添加自定义子智能体（名称不得与任何内置项冲突） */
  ipcMain.handle('customSubAgent:add', (_event, params: CustomSubAgentAddParams) => {
    if (isBuiltinSubAgent(params.name)) {
      return { error: `Name "${params.name}" is reserved by a built-in sub-agent` }
    }
    const id = customSubAgentDao.insert(params)
    const agent = customSubAgentDao.findById(id)!
    registerCustomSubAgent(agent)
    return { id }
  })

  /** 更新自定义子智能体（内置不可修改） */
  ipcMain.handle('customSubAgent:update', (_event, params: CustomSubAgentUpdateParams) => {
    if (isBuiltinSubAgent(params.id)) return { success: false }
    const existing = customSubAgentDao.findById(params.id)
    if (!existing) return { success: false }
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
    if (isBuiltinSubAgent(id)) return { success: false }
    const agent = customSubAgentDao.findById(id)
    if (!agent) return { success: false }
    unregisterCustomSubAgent(agent.name)
    customSubAgentDao.deleteById(id)
    return { success: true }
  })

  /** 切换启用/禁用（内置走 settings，自定义走 DB） */
  ipcMain.handle('customSubAgent:toggle', (_event, params: { id: string; enabled: boolean }) => {
    if (isBuiltinSubAgent(params.id)) {
      const ok = setBuiltinSubAgentEnabled(params.id, params.enabled)
      return { success: ok }
    }
    const agent = customSubAgentDao.findById(params.id)
    if (!agent) return { success: false }
    customSubAgentDao.setEnabled(params.id, params.enabled)
    toggleCustomSubAgent(agent, params.enabled)
    return { success: true }
  })
}
