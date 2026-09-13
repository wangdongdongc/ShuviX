import { ipcMain } from 'electron'
import { botService } from '../services/botService'

/**
 * Bot IPC 处理器 —— 主窗口侧栏「Bots」分组 + bot 档案页（BotPage）。
 *
 * 纯 md 驱动：每次 list 现扫 `~/.shuvix/bots`。编辑走 **md 原文**（frontmatter 由属性卡渲染，
 * 正文是人设与记忆），写盘前经解析器校验（非法拒绝并回传人读原因）。没有启用开关，文件存在且
 * 合法即可用；**不内置 bot**，新建走 `bot:template`。每条写通道落盘后由 botService 广播
 * AppEvent `bot.changed`，侧栏分组据此重扫。
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
        basePath: b.basePath
      })),
      invalid
    }
  })

  /** 取 md 原文（带指纹：保存时回传做冲突检测 —— bot 自己也会改这份文件） */
  ipcMain.handle('bot:getSource', (_e, params: { name: string }) =>
    botService.getSource(params.name)
  )

  /** 「新建 bot」的模板原文（身份三项 + 一副人设 / 记忆骨架） */
  ipcMain.handle(
    'bot:template',
    (_e, params: { name: string; description?: string; body?: string }) => ({
      text: botService.newBotTemplate(params)
    })
  )

  /** 覆写 bot 文件（非法一律拒绝；指纹不符回 conflict） */
  ipcMain.handle(
    'bot:save',
    (_e, params: { originalName: string; text: string; revision?: string }) =>
      botService.save(params.originalName, params.text, params.revision)
  )

  /** 新建 bot 文件 */
  ipcMain.handle('bot:create', (_e, params: { text: string }) => botService.create(params.text))

  /** 删除 bot 文件（绑定它的会话不动 —— 会话是用户资产） */
  ipcMain.handle('bot:delete', (_e, params: { name: string }) => botService.delete(params.name))

  /** 非法文件的读/写/删（身份是文件名 —— 它解析不出 name） */
  ipcMain.handle('bot:getSourceByFile', (_e, params: { fileName: string }) =>
    botService.getSourceByFile(params.fileName)
  )
  ipcMain.handle('bot:saveByFile', (_e, params: { fileName: string; text: string }) =>
    botService.saveByFile(params.fileName, params.text)
  )
  ipcMain.handle('bot:deleteByFile', (_e, params: { fileName: string }) =>
    botService.deleteByFile(params.fileName)
  )

  /** 打开 bots 目录（OS 文件管理器） */
  ipcMain.handle('bot:openFolder', async () => {
    await botService.openFolder()
    return { success: true }
  })
}
