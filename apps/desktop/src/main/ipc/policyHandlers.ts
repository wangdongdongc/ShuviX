import { ipcMain } from 'electron'
import { policyService } from '../services/policyService'
import { openRegistryNote } from '../services/registryNotes'

/**
 * 安全策略 IPC 处理器 —— 设置页「安全策略」tab。
 *
 * 纯 md 驱动：每次 list 都现扫 ~/.shuvix/policies 并按当前界面语言取内置策略的
 * 人读面（规则恒取 en）。用户策略的编辑就是它的笔记本会话（`policy:openNote`，自动保存；
 * 解析器的判定由属性卡实时显示，写坏的文件进「无法解析」分组、不遮蔽内置）。
 * 评估侧每次现装配，无需失效通知。
 */
export function registerPolicyHandlers(): void {
  /** 列出所有策略（内置 + 用户 + 被覆盖内置的展示项） */
  ipcMain.handle('policy:list', () => policyService.listForSettings())

  /** 取 md 原文（用户策略读文件；内置策略回写等价 md，作只读查看与覆盖副本初值） */
  ipcMain.handle('policy:getSource', (_e, params: { name: string; source: 'builtin' | 'user' }) =>
    policyService.getSource(params.name, params.source)
  )

  /** 新建用户策略文件（「新建」与「创建覆盖副本」共用，非法拒绝） */
  ipcMain.handle('policy:create', (_e, params: { text: string }) =>
    policyService.createPolicy(params.text)
  )

  /** 删除用户策略文件（同名内置随之恢复生效） */
  ipcMain.handle('policy:delete', (_e, params: { name: string }) =>
    policyService.deletePolicy(params.name)
  )

  /** 目录里无法解析的策略文件（设置页「无法解析」分组） */
  ipcMain.handle('policy:listInvalid', () => policyService.listInvalid())

  /** 按文件名删除解析不过的文件（它没有 name） */
  ipcMain.handle('policy:deleteByFile', (_e, params: { fileName: string }) =>
    policyService.deleteByFile(params.fileName)
  )

  /** 打开 / 复用一份策略文件的笔记本会话（按文件名认 —— 解析不过的文件也这样打开去修） */
  ipcMain.handle('policy:openNote', (_e, params: { fileName: string; title?: string }) =>
    openRegistryNote('policy', params.fileName, params.title)
  )

  /**
   * 打开 / 复用一份**内置**策略的只读笔记本 —— 它随包发布在应用包里，运行时读的就是这份文件，
   * 所以按名问 policyService 要「当前语言那一版的文件名」再开，UI 不自己挑语言。
   */
  ipcMain.handle('policy:openBuiltinNote', (_e, params: { name: string; title?: string }) => {
    const fileName = policyService.builtinSourceFile(params.name)
    if (!fileName) throw new Error(`Builtin policy "${params.name}" not found`)
    return openRegistryNote('policyBuiltin', fileName, params.title)
  })

  /** 打开用户策略目录（OS 文件管理器） */
  ipcMain.handle('policy:openFolder', async () => {
    await policyService.openUserFolder()
    return { success: true }
  })
}
