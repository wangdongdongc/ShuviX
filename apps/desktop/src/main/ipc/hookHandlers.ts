import { ipcMain } from 'electron'
import { hookService } from '../services/hookService'
import { openRegistryNote } from '../services/registryNotes'

/**
 * Hook IPC 处理器 —— 设置页「Hooks」tab（与策略页同形）。
 *
 * 纯 md 驱动：每次 list 现扫 ~/.shuvix/hooks 并按当前界面语言取内置 hook。
 * 用户 hook 的编辑就是它的笔记本会话（`hook:openNote`，自动保存）；结构不合法的文件
 * 进「无法解析」分组，既不触发也不遮蔽内置。runner 每次 fire 现算注册表，无需失效通知。
 * 与策略页同形：没有启用开关，文件存在且校验通过即生效。
 */
export function registerHookHandlers(): void {
  /** 列出所有 hook（内置 + 用户 + 被覆盖内置的展示项） */
  ipcMain.handle('hook:list', () => hookService.listForSettings())

  /** 取 md 原文（用户读文件；内置回 bundle 原文，作只读查看与覆盖副本初值） */
  ipcMain.handle('hook:getSource', (_e, params: { name: string; source: 'builtin' | 'user' }) =>
    hookService.getSource(params.name, params.source)
  )

  /** 新建用户 hook 文件（「新建」与「创建覆盖副本」共用） */
  ipcMain.handle('hook:create', (_e, params: { text: string }) => hookService.create(params.text))

  /** 删除用户 hook 文件（同名内置随之恢复生效） */
  ipcMain.handle('hook:delete', (_e, params: { name: string }) => hookService.delete(params.name))

  /** 目录里无法解析的文件（设置页「无法解析」分组） */
  ipcMain.handle('hook:listInvalid', () => hookService.listInvalid())

  /** 按文件名删除解析不过的文件（它没有 name） */
  ipcMain.handle('hook:deleteByFile', (_e, params: { fileName: string }) =>
    hookService.deleteByFile(params.fileName)
  )

  /** 打开 / 复用一份 hook 文件的笔记本会话（按文件名认 —— 解析不过的文件也这样打开去修） */
  ipcMain.handle('hook:openNote', (_e, params: { fileName: string; title?: string }) =>
    openRegistryNote('hook', params.fileName, params.title)
  )

  /** 打开用户 hook 目录（OS 文件管理器） */
  ipcMain.handle('hook:openFolder', async () => {
    await hookService.openUserFolder()
    return { success: true }
  })
}
