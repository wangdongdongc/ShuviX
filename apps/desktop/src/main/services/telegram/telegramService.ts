import { telegramBotDao } from '../../dao/telegramBotDao'
import { createLogger } from '../../logger'
import type { TelegramBotInfo } from '../../types'

const log = createLogger('Telegram')

/**
 * Telegram Bot 登记表 —— 只有 CRUD，没有运行时。
 *
 * 会话流绑定那一套（长轮询、消息中继、Bot↔会话 1:1 绑定、随绑定自动启停）已整体
 * 下线：它是很早期的设计，实际无人使用。这里保留的是「注册过哪些 Bot」这份数据与
 * 它的管理入口，供将来重新接入时复用 —— 登记本身不产生任何网络行为。
 */
class TelegramService {
  /** 列出所有已登记的 Bot */
  listBots(): TelegramBotInfo[] {
    return telegramBotDao.findAll().map((b) => {
      let allowedUsers: number[] = []
      try {
        allowedUsers = JSON.parse(b.allowedUsers)
      } catch {
        /* ignore */
      }
      return {
        id: b.id,
        name: b.name,
        username: b.username,
        allowedUsers,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt
      }
    })
  }

  /** 添加 Bot（token 验证后传入 id/username） */
  addBot(params: { id: string; name: string; token: string; username: string }): TelegramBotInfo {
    telegramBotDao.insert(params)
    const bot = telegramBotDao.pick(params.id, [
      'id',
      'name',
      'username',
      'createdAt',
      'updatedAt'
    ])!
    return {
      id: bot.id,
      name: bot.name,
      username: bot.username,
      allowedUsers: [],
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt
    }
  }

  /** 更新 Bot 配置 */
  updateBot(params: {
    id: string
    name?: string
    token?: string
    username?: string
    allowedUsers?: number[]
  }): void {
    const fields: Parameters<typeof telegramBotDao.update>[1] = {}
    if (params.name !== undefined) fields.name = params.name
    if (params.token !== undefined) fields.token = params.token
    if (params.username !== undefined) fields.username = params.username
    if (params.allowedUsers !== undefined) fields.allowedUsers = JSON.stringify(params.allowedUsers)
    telegramBotDao.update(params.id, fields)
  }

  /** 删除 Bot */
  deleteBot(id: string): void {
    telegramBotDao.deleteById(id)
    log.info(`已删除 Bot id=${id}`)
  }
}

export const telegramService = new TelegramService()
