import { ipcMain } from 'electron'
import { telegramService } from '../services/telegramService'
import type {
  TelegramBotAddParams,
  TelegramBotUpdateParams,
  TelegramBindSessionParams,
  TelegramUnbindSessionParams
} from '../types'

/**
 * Telegram Bot 管理 IPC 处理器（多 Bot 版）
 */
export function registerTelegramHandlers(): void {
  // ─── Bot CRUD ────────────────────────────────

  ipcMain.handle('telegram:listBots', () => telegramService.listBots())

  ipcMain.handle('telegram:addBot', async (_event, params: TelegramBotAddParams) => {
    // 先验证 token
    const { Bot } = await import('grammy')
    const tempBot = new Bot(params.token)
    const me = await tempBot.api.getMe()
    return telegramService.addBot({
      id: String(me.id),
      name: me.first_name,
      token: params.token,
      username: me.username
    })
  })

  ipcMain.handle('telegram:updateBot', async (_event, params: TelegramBotUpdateParams) => {
    // 如果 token 变更，先验证并获取 bot info
    let username: string | undefined
    if (params.token) {
      const { Bot } = await import('grammy')
      const tempBot = new Bot(params.token)
      const me = await tempBot.api.getMe()
      username = me.username
    }
    await telegramService.updateBot({ ...params, username })
    return { success: true }
  })

  ipcMain.handle('telegram:deleteBot', async (_event, id: string) => {
    await telegramService.deleteBot(id)
    return { success: true }
  })

  // ─── Token 验证 ──────────────────────────────

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

  // ─── Session 绑定 ────────────────────────────

  ipcMain.handle('telegram:bindSession', async (_event, params: TelegramBindSessionParams) => {
    await telegramService.bindSession(params.botId, params.sessionId)
    return { success: true }
  })

  ipcMain.handle('telegram:unbindSession', async (_event, params: TelegramUnbindSessionParams) => {
    await telegramService.unbindSession(params.sessionId)
    return { success: true }
  })

  ipcMain.handle('telegram:getSessionBotId', (_event, sessionId: string) => {
    return telegramService.getSessionBotId(sessionId)
  })

  // ─── Bot 生命周期 ────────────────────────────

  ipcMain.handle('telegram:startBot', async (_event, botId: string) => {
    await telegramService.startBot(botId)
    return { success: true }
  })

  ipcMain.handle('telegram:stopBot', async (_event, botId: string) => {
    await telegramService.stopBot(botId)
    return { success: true }
  })

  ipcMain.handle('telegram:getBotStatus', (_event, botId: string) => {
    return telegramService.getBotStatus(botId)
  })
}
