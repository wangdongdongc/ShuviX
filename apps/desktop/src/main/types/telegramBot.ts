export type { TelegramBot } from '../dao/types'

/** IPC: 添加 Telegram Bot 参数（名称从 getMe 自动获取） */
export interface TelegramBotAddParams {
  token: string
}

/** IPC: 更新 Telegram Bot 参数 */
export interface TelegramBotUpdateParams {
  id: string
  name?: string
  token?: string
  allowedUsers?: number[]
}

/** 返回给前端的 Bot 信息 —— 纯登记信息，不含 token，也没有运行时状态 */
export interface TelegramBotInfo {
  /** Telegram bot numeric ID（主键） */
  id: string
  name: string
  username: string
  allowedUsers: number[]
  createdAt: number
  updatedAt: number
}
