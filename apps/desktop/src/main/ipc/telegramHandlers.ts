import { ipcMain } from 'electron'
import { telegramService } from '../services/telegram'
import type { TelegramBotAddParams, TelegramBotUpdateParams } from '../types'

/** getMe 返回的 Bot 身份（只取登记需要的字段） */
interface BotIdentity {
  id: number
  first_name: string
  username?: string
}

/**
 * 校验 token 并取回 Bot 身份 —— 直接打 Telegram 的 getMe。
 *
 * 这里刻意不用 Bot 框架：登记表只需要这一次 HTTPS GET，为它留一整套长轮询/中间件
 * 运行时（grammy）没有意义，会话绑定下线后那些能力也无处可用。
 */
async function fetchBotIdentity(token: string): Promise<BotIdentity> {
  const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`)
  const body = (await res.json()) as {
    ok: boolean
    description?: string
    result?: BotIdentity
  }
  if (!body.ok || !body.result) {
    throw new Error(body.description || `Telegram API returned ${res.status}`)
  }
  return body.result
}

/**
 * Telegram Bot 登记 IPC 处理器 —— 只有 CRUD 与 token 校验，没有会话绑定与启停。
 */
export function registerTelegramHandlers(): void {
  // ─── Bot CRUD ────────────────────────────────

  ipcMain.handle('telegram:listBots', () => telegramService.listBots())

  ipcMain.handle('telegram:addBot', async (_event, params: TelegramBotAddParams) => {
    // 先验证 token
    const me = await fetchBotIdentity(params.token)
    return telegramService.addBot({
      id: String(me.id),
      name: me.first_name,
      token: params.token,
      username: me.username ?? ''
    })
  })

  ipcMain.handle('telegram:updateBot', async (_event, params: TelegramBotUpdateParams) => {
    // 如果 token 变更，先验证并获取 bot info
    let username: string | undefined
    if (params.token) {
      username = (await fetchBotIdentity(params.token)).username
    }
    telegramService.updateBot({ ...params, username })
    return { success: true }
  })

  ipcMain.handle('telegram:deleteBot', (_event, id: string) => {
    telegramService.deleteBot(id)
    return { success: true }
  })

  // ─── Token 验证 ──────────────────────────────

  ipcMain.handle('telegram:validateToken', async (_event, token: string) => {
    try {
      const me = await fetchBotIdentity(token)
      return { valid: true, username: me.username, id: me.id }
    } catch (err: unknown) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
