import { ipcMain } from 'electron'
import { hookService } from '../services/hookService'
import { openRegistryNote } from '../services/registryNotes'

/**
 * Hook IPC 处理器 —— 侧栏「Hooks」分组（与策略同形）。
 *
 * 纯 md 驱动：每次 list 现扫 ~/.shuvix/hooks 并按当前界面语言取内置 hook（md 随包发布，
 * 运行时现读）。用户 hook 的编辑就是它的笔记本会话（`hook:openNote`，自动保存）；内置 hook
 * 点行开随包那份 md 的只读笔记本（`hook:openBuiltinNote`）；结构不合法的文件进「无法解析」
 * 分组，既不触发也不遮蔽内置。runner 每次 fire 现算注册表，无需失效通知。
 * 与策略同形：没有启用开关，文件存在且校验通过即生效。
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

  /**
   * 打开 / 复用一份**内置** hook 的只读笔记本 —— 它随包发布在应用包里，运行时读的就是这份文件，
   * 所以按名问 hookService 要「当前语言那一版的文件名」再开，UI 不自己挑语言。
   */
  ipcMain.handle('hook:openBuiltinNote', (_e, params: { name: string; title?: string }) => {
    const fileName = hookService.builtinSourceFile(params.name)
    if (!fileName) throw new Error(`Builtin hook "${params.name}" not found`)
    return openRegistryNote('hookBuiltin', fileName, params.title)
  })

  /** 打开用户 hook 目录（OS 文件管理器） */
  ipcMain.handle('hook:openFolder', async () => {
    await hookService.openUserFolder()
    return { success: true }
  })
}
