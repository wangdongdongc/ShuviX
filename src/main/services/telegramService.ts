import { telegramBotDao } from '../dao/telegramBotDao'
import { sessionDao } from '../dao/sessionDao'
import { createLogger } from '../logger'
import type { TelegramBotInfo } from '../types'
import type { TelegramBotServer } from '../frontend/telegram/TelegramBotServer'

const log = createLogger('Telegram')

/**
 * Telegram Bot 多实例管理服务
 * 管理多个 Bot 的 CRUD、生命周期、Session 绑定（1:1）
 */
class TelegramService {
  /** botId (Telegram numeric ID) → TelegramBotServer 运行实例 */
  private botServers = new Map<string, TelegramBotServer>()

  // ─── Bot CRUD ────────────────────────────────

  /** 列出所有 Bot（含运行时状态和绑定信息） */
  listBots(): TelegramBotInfo[] {
    const bots = telegramBotDao.findAll()
    return bots.map((b) => {
      const boundSession = sessionDao.findByTelegramBotId(b.id)
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
        isEnabled: b.isEnabled === 1,
        running: this.botServers.get(b.id)?.isRunning() ?? false,
        boundSessionId: boundSession?.id ?? null,
        boundSessionTitle: boundSession?.title ?? null,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt
      }
    })
  }

  /** 添加 Bot（token 验证后传入 id/username） */
  addBot(params: {
    id: string
    name: string
    token: string
    username: string
  }): TelegramBotInfo {
    telegramBotDao.insert(params)
    const bot = telegramBotDao.findById(params.id)!
    return {
      id: bot.id,
      name: bot.name,
      username: bot.username,
      allowedUsers: [],
      isEnabled: true,
      running: false,
      boundSessionId: null,
      boundSessionTitle: null,
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt
    }
  }

  /** 更新 Bot 配置 */
  async updateBot(params: {
    id: string
    name?: string
    token?: string
    username?: string
    allowedUsers?: number[]
    isEnabled?: boolean
  }): Promise<void> {
    const fields: Parameters<typeof telegramBotDao.update>[1] = {}
    if (params.name !== undefined) fields.name = params.name
    if (params.token !== undefined) fields.token = params.token
    if (params.username !== undefined) fields.username = params.username
    if (params.allowedUsers !== undefined) fields.allowedUsers = JSON.stringify(params.allowedUsers)
    if (params.isEnabled !== undefined) fields.isEnabled = params.isEnabled ? 1 : 0
    telegramBotDao.update(params.id, fields)

    // 如果 token 变更且 Bot 正在运行 → 重启
    if (params.token && this.botServers.has(params.id)) {
      await this.stopBot(params.id)
      await this.startBot(params.id)
    }
  }

  /** 删除 Bot（先停止、解绑） */
  async deleteBot(id: string): Promise<void> {
    await this.stopBot(id)
    sessionDao.clearAllTelegramBotBindings(id)
    telegramBotDao.deleteById(id)
    log.info(`已删除 Bot id=${id}`)
  }

  // ─── Bot 生命周期 ────────────────────────────

  async startBot(botId: string): Promise<void> {
    if (this.botServers.has(botId)) return
    const bot = telegramBotDao.findById(botId)
    if (!bot || !bot.token) return

    // 延迟 import 避免模块加载顺序问题
    const { TelegramBotServer } = await import('../frontend/telegram/TelegramBotServer')
    const server = new TelegramBotServer(bot.id)
    this.botServers.set(botId, server)
    try {
      await server.start(bot.token)
      log.info(`Bot 已启动: ${bot.username} (id=${botId})`)
    } catch (err) {
      this.botServers.delete(botId)
      log.error(`Bot 启动失败: ${err}`)
      throw err
    }
  }

  async stopBot(botId: string): Promise<void> {
    const server = this.botServers.get(botId)
    if (!server) return
    await server.stop()
    this.botServers.delete(botId)
    log.info(`Bot 已停止: id=${botId}`)
  }

  /** 停止所有运行中的 Bot */
  async stopAll(): Promise<void> {
    for (const [id, server] of this.botServers) {
      await server.stop().catch((err) => log.error(`停止 Bot ${id} 失败: ${err}`))
    }
    this.botServers.clear()
  }

  getBotStatus(botId: string): { running: boolean } {
    return { running: this.botServers.get(botId)?.isRunning() ?? false }
  }

  // ─── Session 绑定（1:1） ─────────────────────

  /** 绑定 session 到 bot（1:1，先解除已有绑定） */
  async bindSession(botId: string, sessionId: string): Promise<void> {
    // 解除 session 的旧绑定
    const session = sessionDao.findById(sessionId)
    if (session?.settings?.telegramBotId) {
      await this.unbindSession(sessionId)
    }

    // 解除 bot 的旧绑定（1:1）
    const existingSession = sessionDao.findByTelegramBotId(botId)
    if (existingSession) {
      sessionDao.clearTelegramBotId(existingSession.id)
      this.botServers.get(botId)?.unbindSession(existingSession.id)
    }

    // 写入新绑定
    sessionDao.updateSettings(sessionId, { telegramBotId: botId })
    log.info(`绑定 session=${sessionId} → bot=${botId}`)

    // 自动启动 bot
    const bot = telegramBotDao.findById(botId)
    if (bot?.isEnabled && !this.botServers.has(botId)) {
      this.startBot(botId).catch((err) => log.error(`Bot 自动启动失败: ${err}`))
    }
  }

  /** 解绑 session */
  async unbindSession(sessionId: string): Promise<void> {
    const session = sessionDao.findById(sessionId)
    const botId = session?.settings?.telegramBotId
    if (!botId) return

    sessionDao.clearTelegramBotId(sessionId)
    log.info(`解绑 session=${sessionId}（bot=${botId}）`)

    // 通知运行中的 server
    this.botServers.get(botId)?.unbindSession(sessionId)

    // 若该 bot 不再有绑定 session → 自动停止
    const stillBound = sessionDao.findByTelegramBotId(botId)
    if (!stillBound && this.botServers.has(botId)) {
      this.stopBot(botId).catch((err) => log.error(`Bot 自动停止失败: ${err}`))
    }
  }

  /** 获取 session 绑定的 bot ID */
  getSessionBotId(sessionId: string): string | null {
    const session = sessionDao.findById(sessionId)
    return session?.settings?.telegramBotId ?? null
  }

  /** 获取 bot 绑定的 session ID（1:1） */
  getBoundSessionId(botId: string): string | null {
    const session = sessionDao.findByTelegramBotId(botId)
    return session?.id ?? null
  }

  // ─── 用户访问控制 ───────────────────────────

  isAllowedUser(botId: string, userId: number): boolean {
    const bot = telegramBotDao.findById(botId)
    if (!bot) return false
    let allowed: number[] = []
    try {
      allowed = JSON.parse(bot.allowedUsers)
    } catch {
      /* ignore */
    }
    if (allowed.length === 0) {
      // 首次交互：自动将该用户绑定为 owner
      allowed = [userId]
      telegramBotDao.update(botId, { allowedUsers: JSON.stringify(allowed) })
      log.info(`Bot ${botId}: 首次交互，自动绑定用户 ${userId}`)
      return true
    }
    return allowed.includes(userId)
  }

  // ─── 启动恢复 ───────────────────────────────

  /** 应用启动时：恢复有绑定 session 的 enabled bot */
  async autoStartBots(): Promise<void> {
    const enabledBots = telegramBotDao.findEnabled()
    for (const bot of enabledBots) {
      const boundSession = sessionDao.findByTelegramBotId(bot.id)
      if (boundSession) {
        log.info(`自动恢复 Bot: ${bot.username} (id=${bot.id})`)
        this.startBot(bot.id).catch((err) => {
          log.error(`自动恢复 Bot 失败: ${err}`)
        })
      }
    }
  }
}

export const telegramService = new TelegramService()
