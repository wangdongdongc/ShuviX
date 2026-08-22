import { ipcMain } from 'electron'
import { policyService } from '../services/policyService'

/**
 * 安全策略 IPC 处理器 —— 设置页「安全策略」tab。
 *
 * 纯 md 驱动：每次 list 都现扫 ~/.shuvix/policies 并按当前界面语言取内置策略的
 * 人读面（规则恒取 en）。编辑走 **md 原文**（rules/lets/scope 是嵌套结构，做表单
 * 成本远高于收益；解析器对非法文件本就给人读原因，原文 + 实时校验更贴合），
 * 写盘前一律解析校验（非法拒绝并回传原因）。评估侧每次现装配，无需失效通知。
 */
export function registerPolicyHandlers(): void {
  /** 列出所有策略（内置 + 用户 + 被覆盖内置的展示项） */
  ipcMain.handle('policy:list', () => policyService.listForSettings())

  /** 取 md 原文（用户策略读文件；内置策略回写等价 md，作覆盖副本初值） */
  ipcMain.handle('policy:getSource', (_e, params: { name: string; source: 'builtin' | 'user' }) =>
    policyService.getSource(params.name, params.source)
  )

  /** 覆写用户策略文件（非法拒绝） */
  ipcMain.handle('policy:save', (_e, params: { originalName: string; text: string }) =>
    policyService.savePolicy(params.originalName, params.text)
  )

  /** 新建用户策略文件（「新建」与「创建覆盖副本」共用，非法拒绝） */
  ipcMain.handle('policy:create', (_e, params: { text: string }) =>
    policyService.createPolicy(params.text)
  )

  /** 删除用户策略文件（同名内置随之恢复生效） */
  ipcMain.handle('policy:delete', (_e, params: { name: string }) =>
    policyService.deletePolicy(params.name)
  )

  /** 目录里无法解析的策略文件（设置页显示为可点开修复的告警项） */
  ipcMain.handle('policy:listInvalid', () => policyService.listInvalid())

  /** 非法文件的读/写/删（身份是文件名 —— 它解析不出 name） */
  ipcMain.handle('policy:getSourceByFile', (_e, params: { fileName: string }) =>
    policyService.getSourceByFile(params.fileName)
  )
  ipcMain.handle('policy:saveByFile', (_e, params: { fileName: string; text: string }) =>
    policyService.saveByFile(params.fileName, params.text)
  )
  ipcMain.handle('policy:deleteByFile', (_e, params: { fileName: string }) =>
    policyService.deleteByFile(params.fileName)
  )

  /** 打开用户策略目录（OS 文件管理器） */
  ipcMain.handle('policy:openFolder', async () => {
    await policyService.openUserFolder()
    return { success: true }
  })
}
