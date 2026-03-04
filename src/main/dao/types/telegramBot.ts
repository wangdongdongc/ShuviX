/** Telegram Bot 数据结构（对应 DB 表 telegram_bots，token 加密存储） */
export interface TelegramBot {
  /** Telegram bot numeric ID (from getMe)，用作主键 */
  id: string
  /** 用户自定义名称 */
  name: string
  /** Bot Token（加密存储，DAO 层解密后返回） */
  token: string
  /** Telegram bot username (from getMe) */
  username: string
  /** 允许的用户 ID 列表，JSON: number[] */
  allowedUsers: string
  isEnabled: number
  createdAt: number
  updatedAt: number
}
