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
  isEnabled?: boolean
}

/** IPC: 绑定 session 到 bot */
export interface TelegramBindSessionParams {
  botId: string
  sessionId: string
}

/** IPC: 解绑 session */
export interface TelegramUnbindSessionParams {
  sessionId: string
}

/** 返回给前端的 Bot 信息（含运行时状态，不含 token） */
export interface TelegramBotInfo {
  /** Telegram bot numeric ID（主键） */
  id: string
  name: string
  username: string
  allowedUsers: number[]
  isEnabled: boolean
  running: boolean
  /** 1:1 绑定的 session ID */
  boundSessionId: string | null
  /** 绑定 session 的标题 */
  boundSessionTitle: string | null
  createdAt: number
  updatedAt: number
}
