import { ipcMain } from 'electron'
import { botService } from '../services/botService'

/**
 * Bot IPC 处理器 —— 设置页「Bots」tab（与工作流/策略页同形）。
 *
 * 纯 md 驱动：每次 list 现扫 ~/.shuvix/bots。编辑走 **md 原文**（frontmatter 由属性卡
 * 渲染，正文是人设 + 内联记忆区），写盘前经解析器校验（非法拒绝并回传人读原因）。
 * 没有启用开关，文件存在且合法即可用；**不内置 bot**，所以也没有「内置/用户」两源之分 ——
 * 新建走 `bot:template`（用内置管线与阶段 agent 填一份模板）。
 */
export function registerBotHandlers(): void {
  /** 列出全部 bot */
  ipcMain.handle('bot:list', () => botService.listForSettings())

  /** 取 md 原文 */
  ipcMain.handle('bot:getSource', (_e, params: { name: string }) =>
    botService.getSource(params.name)
  )

  /** 「新建 bot」的模板原文（内置管线 + 内置阶段 agent + 用户取的名字） */
  ipcMain.handle(
    'bot:template',
    (_e, params: { name: string; description?: string; persona?: string }) => ({
      text: botService.newBotTemplate(params)
    })
  )

  /** 覆写用户 bot 文件（非法一律拒绝） */
  ipcMain.handle(
    'bot:save',
    (_e, params: { originalName: string; text: string; revision?: string }) =>
      botService.save(params.originalName, params.text, params.revision)
  )

  /** 新建用户 bot 文件（「新建」与「创建覆盖副本」共用） */
  ipcMain.handle('bot:create', (_e, params: { text: string }) => botService.create(params.text))

  /** 删除用户 bot 文件（同名内置随之恢复） */
  ipcMain.handle('bot:delete', (_e, params: { name: string }) => botService.delete(params.name))

  /** 目录里无法解析的文件（设置页显示为可点开修复的告警项） */
  ipcMain.handle('bot:listInvalid', () => botService.listInvalid())

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

  /** 打开用户 bot 目录（OS 文件管理器） */
  ipcMain.handle('bot:openFolder', async () => {
    await botService.openUserFolder()
    return { success: true }
  })
}
