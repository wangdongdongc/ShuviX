/**
 * Telegram Bot Gateway —— service 层暴露给 frontend/telegram 的合约。
 *
 * `telegramService` 只持有 `TelegramBotGateway` 接口引用，具体的
 * `TelegramBotServer`（grammY 封装、session 绑定等运行时细节）在
 * `frontend/telegram/` 层实现并通过 `registerTelegramBotGatewayFactory`
 * 在 main 启动时反向注册自己 —— 这样 `services/` 下没有任何到
 * `frontend/telegram/` 的静态/动态 import。
 */

/** telegramService 调用 TelegramBotServer 的方法集合（仅列出必要的） */
export interface TelegramBotGateway {
  isRunning(): boolean
  start(token: string): Promise<void>
  stop(): Promise<void>
  unbindSession(sessionId: string): void
}

/** 工厂签名 —— botId → gateway 实例 */
export type TelegramBotGatewayFactory = (botId: string) => TelegramBotGateway

let factory: TelegramBotGatewayFactory | null = null

/** 由 frontend/telegram 在模块加载时调用，注入具体实现 */
export function registerTelegramBotGatewayFactory(f: TelegramBotGatewayFactory): void {
  factory = f
}

/** telegramService 按 botId 创建 gateway 实例 */
export function createTelegramBotGateway(botId: string): TelegramBotGateway {
  if (!factory) {
    throw new Error(
      'TelegramBotGateway factory not registered. main/index.ts must import frontend/telegram/TelegramBotServer at startup.'
    )
  }
  return factory(botId)
}
