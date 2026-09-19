import { ipcMain } from 'electron'
import { agentService } from '../services/agentService'
import { openRegistryNote } from '../services/registryNotes'
import type { SubAgentCreateParams, SubAgentSaveParams } from '../types'

/**
 * Sub-Agent 文件系统管理 IPC 处理器
 *
 * 纯 md 驱动：每次 list 都现扫文件系统，派发工具执行时也按名现查 ——
 * 新建 / 删除 / 编辑后无需向活跃会话级联任何刷新（派发工具描述为静态文案）。
 * 用户档案的编辑就是它的笔记本会话（`subAgent:openNote`，自动保存）；内置档案无文件，
 * getSource 回写等价 md，供只读查看与「创建覆盖副本」。
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

  /** 目录里无法解析的档案文件（设置页「无法解析」分组；身份是文件名） */
  ipcMain.handle('subAgent:listInvalid', () => agentService.listInvalid())

  /** 按文件名删除解析不过的档案文件（它没有 name） */
  ipcMain.handle('subAgent:deleteByFile', (_e, params: { fileName: string }) =>
    agentService.deleteByFile(params.fileName)
  )

  /** 取 md 原文（用户读文件；内置回写等价 md，作只读查看与覆盖副本初值） */
  ipcMain.handle('subAgent:getSource', (_e, params: { name: string; source: 'builtin' | 'user' }) =>
    agentService.getSource(params.name, params.source)
  )

  /** 按原文新建用户档案（「新建」与「创建覆盖副本」共用；非法拒绝并回传解析器原因） */
  ipcMain.handle('subAgent:createSource', (_e, params: { text: string }) =>
    agentService.createAgentSource(params.text)
  )

  /** 打开 / 复用一份档案文件的笔记本会话（按文件名认） */
  ipcMain.handle('subAgent:openNote', (_e, params: { fileName: string; title?: string }) =>
    openRegistryNote('agent', params.fileName, params.title)
  )

  /**
   * 打开 / 复用一份**内置**档案的只读笔记本 —— 它随包发布在应用包里，运行时读的就是这份文件，
   * 所以按名问 agentService 要「当前语言那一版的文件名」再开，UI 不自己挑语言。
   */
  ipcMain.handle('subAgent:openBuiltinNote', (_e, params: { name: string; title?: string }) => {
    const fileName = agentService.builtinSourceFile(params.name)
    if (!fileName) throw new Error(`Builtin agent "${params.name}" not found`)
    return openRegistryNote('agentBuiltin', fileName, params.title)
  })

  /** 打开用户 agents 目录（OS 文件管理器） */
  ipcMain.handle('subAgent:openFolder', async () => {
    await agentService.openUserFolder()
    return { success: true }
  })
}
