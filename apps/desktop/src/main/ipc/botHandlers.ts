import { basename } from 'path'
import { ipcMain } from 'electron'
import { botService } from '../services/botService'
import { openRegistryNote } from '../services/registryNotes'

/**
 * Bot IPC 处理器 —— 主窗口侧栏「Bots」分组。
 *
 * 纯 md 驱动：每次 list 现扫 `~/.shuvix/bots`。**编辑不在这里**：打开一份 bot 就是打开 / 复用它的
 * 笔记本会话（`bot:openNote`，与知识库条目同一条路），改动由笔记本自动保存落盘，改名迁移与
 * `bot.changed` 由 botService 在写入回执里补上。没有启用开关，文件存在且合法即可用；**不内置 bot**，
 * 新建走 `bot:createNew`（按模板落一份新文件）。
 */
export function registerBotHandlers(): void {
  /** 列出全部 bot（合法 + 非法两拨一次取齐 —— 侧栏一次扫描就够） */
  ipcMain.handle('bot:list', () => {
    const { valid, invalid } = botService.listWithInvalid()
    return {
      bots: valid.map((b) => ({
        name: b.file.name,
        displayName: b.file.displayName,
        description: b.file.description,
        basePath: b.basePath,
        fileName: basename(b.basePath)
      })),
      invalid
    }
  })

  /** 打开 / 复用一份 bot 文件的笔记本会话（按文件名认 —— 解析不过的文件也这样打开去修） */
  ipcMain.handle('bot:openNote', (_e, params: { fileName: string; title?: string }) =>
    openRegistryNote('bot', params.fileName, params.title)
  )

  /** 按模板新建一份 bot 文件（名字取第一个没被占用的 my-bot / my-bot-2 ……），回名字与文件名 */
  ipcMain.handle('bot:createNew', () => botService.createNew())

  /** 删除 bot 文件（绑定它的会话不动 —— 会话是用户资产） */
  ipcMain.handle('bot:delete', (_e, params: { name: string }) => botService.delete(params.name))

  /** 按文件名删除解析不过的文件（它没有 name） */
  ipcMain.handle('bot:deleteByFile', (_e, params: { fileName: string }) =>
    botService.deleteByFile(params.fileName)
  )

  /** 打开 bots 目录（OS 文件管理器） */
  ipcMain.handle('bot:openFolder', async () => {
    await botService.openFolder()
    return { success: true }
  })
}
