import { ipcMain } from 'electron'
import { workflowService } from '../services/workflowService'
import { openRegistryNote } from '../services/registryNotes'

/**
 * 工作流 IPC 处理器 —— 设置页「工作流」tab（与策略页同形）。
 *
 * 纯 md 驱动：每次 list 现扫 ~/.shuvix/workflows 并按当前界面语言取内置工作流。
 * 用户工作流的编辑就是它的笔记本会话（`workflow:openNote`，自动保存）；结构或脚本语法
 * 不合法的文件进「无法解析」分组，既不触发也不遮蔽内置。引擎每次 fire 现算注册表，
 * 无需失效通知。与策略页同形：没有启用开关，文件存在且校验通过即生效。
 */
export function registerWorkflowHandlers(): void {
  /** 列出所有工作流（内置 + 用户 + 被覆盖内置的展示项） */
  ipcMain.handle('workflow:list', () => workflowService.listForSettings())

  /** 取 md 原文（用户读文件；内置回 bundle 原文，作只读查看与覆盖副本初值） */
  ipcMain.handle('workflow:getSource', (_e, params: { name: string; source: 'builtin' | 'user' }) =>
    workflowService.getSource(params.name, params.source)
  )

  /** 新建用户工作流文件（「新建」与「创建覆盖副本」共用） */
  ipcMain.handle('workflow:create', (_e, params: { text: string }) =>
    workflowService.create(params.text)
  )

  /** 删除用户工作流文件（同名内置随之恢复生效） */
  ipcMain.handle('workflow:delete', (_e, params: { name: string }) =>
    workflowService.delete(params.name)
  )

  /** 目录里无法解析的文件（设置页「无法解析」分组） */
  ipcMain.handle('workflow:listInvalid', () => workflowService.listInvalid())

  /** 按文件名删除解析不过的文件（它没有 name） */
  ipcMain.handle('workflow:deleteByFile', (_e, params: { fileName: string }) =>
    workflowService.deleteByFile(params.fileName)
  )

  /** 打开 / 复用一份工作流文件的笔记本会话（按文件名认 —— 解析不过的文件也这样打开去修） */
  ipcMain.handle('workflow:openNote', (_e, params: { fileName: string; title?: string }) =>
    openRegistryNote('workflow', params.fileName, params.title)
  )

  /** 打开用户工作流目录（OS 文件管理器） */
  ipcMain.handle('workflow:openFolder', async () => {
    await workflowService.openUserFolder()
    return { success: true }
  })
}
