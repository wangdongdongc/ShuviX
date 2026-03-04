import { settingsDao } from '../dao/settingsDao'
import { createLogger } from '../logger'

const log = createLogger('Telegram')

/** TelegramBotServer 接口（避免直接 import 造成循环依赖） */
interface TelegramBotServerRef {
  isRunning(): boolean
  start(token: string): Promise<void>
  stop(): Promise<void>
  unbindSession(sessionId: string): void
}

/**
 * Telegram Bot 配置与会话绑定管理
 * 管理 Bot Token、允许的用户、已绑定 session，按需启停 Bot
 */
class TelegramService {
  private sharedSessions = new Set<string>()
  private serverRef: TelegramBotServerRef | null = null

  /** 由 TelegramBotServer 初始化时调用，注册自身引用 */
  registerServer(server: TelegramBotServerRef): void {
    this.serverRef = server
  }

  // ─── Bot Token ────────────────────────────────

  getBotToken(): string | undefined {
    return settingsDao.findByKey('telegram.botToken') || undefined
  }

  setBotToken(token: string): void {
    settingsDao.upsert('telegram.botToken', token)
  }

  // ─── 允许的用户 ──────────────────────────────

  getAllowedUsers(): number[] {
    const raw = settingsDao.findByKey('telegram.allowedUsers')
    if (!raw) return []
    try {
      return JSON.parse(raw)
    } catch {
      return []
    }
  }

  setAllowedUsers(userIds: number[]): void {
    settingsDao.upsert('telegram.allowedUsers', JSON.stringify(userIds))
  }

  isAllowedUser(userId: number): boolean {
    const allowed = this.getAllowedUsers()
    return allowed.length === 0 || allowed.includes(userId)
  }

  // ─── 会话绑定 ────────────────────────────────

  setShared(sessionId: string, shared: boolean): void {
    if (shared) {
      this.sharedSessions.add(sessionId)
      log.info(`开启绑定: session=${sessionId}`)
    } else {
      this.sharedSessions.delete(sessionId)
      // 通知 BotServer 解绑该 session 的所有 frontend
      this.serverRef?.unbindSession(sessionId)
      log.info(`关闭绑定: session=${sessionId}`)
    }
    this.syncServer()
  }

  isShared(sessionId: string): boolean {
    return this.sharedSessions.has(sessionId)
  }

  listShared(): string[] {
    return Array.from(this.sharedSessions)
  }

  // ─── Bot 状态与生命周期 ────────────────────────

  getBotStatus(): { running: boolean } {
    return { running: this.serverRef?.isRunning() ?? false }
  }

  async startBot(): Promise<void> {
    const token = this.getBotToken()
    if (!token || !this.serverRef) return
    await this.serverRef.start(token)
  }

  async stopBot(): Promise<void> {
    if (this.serverRef) await this.serverRef.stop()
  }

  /** 有绑定 session 且有 token → 自动启动；无绑定 → 自动停止 */
  private syncServer(): void {
    if (!this.serverRef) return
    const token = this.getBotToken()
    if (this.sharedSessions.size > 0 && !this.serverRef.isRunning() && token) {
      this.serverRef.start(token).catch((err) => {
        log.error(`Bot 自动启动失败: ${err}`)
      })
    } else if (this.sharedSessions.size === 0 && this.serverRef.isRunning()) {
      this.serverRef.stop().catch((err) => {
        log.error(`Bot 自动停止失败: ${err}`)
      })
    }
  }
}

export const telegramService = new TelegramService()
