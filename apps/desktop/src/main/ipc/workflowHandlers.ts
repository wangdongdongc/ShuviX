import { ipcMain } from 'electron'
import { workflowService } from '../services/workflowService'

/**
 * 工作流 IPC 处理器 —— 设置页「工作流」tab（与策略页同形）。
 *
 * 纯 md 驱动：每次 list 现扫 ~/.shuvix/workflows 并按当前界面语言取内置工作流。
 * 编辑走 **md 原文**（frontmatter 由属性卡渲染，正文含编排脚本块），写盘前经解析器 +
 * 脚本引擎双重校验（非法拒绝并回传原因）。引擎每次 fire 现算注册表，无需失效通知。
 *
 * 相对策略页多一个 `setAutorun`：文件存在只代表「可用」，自动触发要显式启用
 * （设计 §3.4 —— 放下一个 md 不该能静默开始烧 token）。
 */
export function registerWorkflowHandlers(): void {
  /** 列出所有工作流（内置 + 用户 + 被覆盖内置的展示项，含 autorun 当前值） */
  ipcMain.handle('workflow:list', () => workflowService.listForSettings())

  /** 取 md 原文（用户读文件；内置回 bundle 原文，作覆盖副本初值） */
  ipcMain.handle('workflow:getSource', (_e, params: { name: string; source: 'builtin' | 'user' }) =>
    workflowService.getSource(params.name, params.source)
  )

  /** 覆写用户工作流文件（结构 + 脚本语法非法一律拒绝） */
  ipcMain.handle('workflow:save', (_e, params: { originalName: string; text: string }) =>
    workflowService.save(params.originalName, params.text)
  )

  /** 新建用户工作流文件（「新建」与「创建覆盖副本」共用） */
  ipcMain.handle('workflow:create', (_e, params: { text: string }) =>
    workflowService.create(params.text)
  )

  /** 删除用户工作流文件（同名内置随之恢复生效） */
  ipcMain.handle('workflow:delete', (_e, params: { name: string }) =>
    workflowService.delete(params.name)
  )

  /** 自动触发开关（写 .config.json；引擎下次 fire 现读，即时生效） */
  ipcMain.handle('workflow:setAutorun', (_e, params: { name: string; enabled: boolean }) =>
    workflowService.setAutorun(params.name, params.enabled)
  )

  /** 目录里无法解析的文件（设置页显示为可点开修复的告警项） */
  ipcMain.handle('workflow:listInvalid', () => workflowService.listInvalid())

  /** 非法文件的读/写/删（身份是文件名 —— 它解析不出 name） */
  ipcMain.handle('workflow:getSourceByFile', (_e, params: { fileName: string }) =>
    workflowService.getSourceByFile(params.fileName)
  )
  ipcMain.handle('workflow:saveByFile', (_e, params: { fileName: string; text: string }) =>
    workflowService.saveByFile(params.fileName, params.text)
  )
  ipcMain.handle('workflow:deleteByFile', (_e, params: { fileName: string }) =>
    workflowService.deleteByFile(params.fileName)
  )

  /** 打开用户工作流目录（OS 文件管理器） */
  ipcMain.handle('workflow:openFolder', async () => {
    await workflowService.openUserFolder()
    return { success: true }
  })
}
