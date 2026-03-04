import { ipcMain } from 'electron'
import { telegramService } from '../services/telegramService'
// 副作用导入：触发 TelegramBotServer 实例化 + 注册到 telegramService
import '../frontend/telegram/TelegramBotServer'

/**
 * Telegram Bot 管理 IPC 处理器
 */
export function registerTelegramHandlers(): void {
  // ─── Bot Token ────────────────────────────────

  ipcMain.handle('telegram:getBotToken', () => telegramService.getBotToken() || '')

  ipcMain.handle('telegram:setBotToken', async (_event, token: string) => {
    telegramService.setBotToken(token)
    if (telegramService.getBotStatus().running) {
      await telegramService.stopBot()
      if (token) await telegramService.startBot()
    }
    return { success: true }
  })

  /** 验证 Bot Token（临时创建 Bot 调用 getMe） */
  ipcMain.handle('telegram:validateToken', async (_event, token: string) => {
    try {
      const { Bot } = await import('grammy')
      const bot = new Bot(token)
      const me = await bot.api.getMe()
      return { valid: true, username: me.username, id: me.id }
    } catch (err: unknown) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ─── 允许的用户 ──────────────────────────────

  ipcMain.handle('telegram:getAllowedUsers', () => telegramService.getAllowedUsers())

  ipcMain.handle('telegram:setAllowedUsers', (_event, userIds: number[]) => {
    telegramService.setAllowedUsers(userIds)
    return { success: true }
  })

  // ─── 会话绑定 ────────────────────────────────

  ipcMain.handle('telegram:setShared', (_event, params: { sessionId: string; shared: boolean }) => {
    telegramService.setShared(params.sessionId, params.shared)
    return { success: true }
  })

  ipcMain.handle('telegram:isShared', (_event, sessionId: string) => {
    return telegramService.isShared(sessionId)
  })

  ipcMain.handle('telegram:listShared', () => {
    return telegramService.listShared()
  })

  // ─── Bot 状态与控制 ──────────────────────────

  ipcMain.handle('telegram:botStatus', () => telegramService.getBotStatus())

  ipcMain.handle('telegram:startBot', async () => {
    await telegramService.startBot()
    return { success: true }
  })

  ipcMain.handle('telegram:stopBot', async () => {
    await telegramService.stopBot()
    return { success: true }
  })
}
