/**
 * Telegram 模块入口
 *
 * 负责 Telegram Bot 多实例管理：CRUD、生命周期、Session 绑定（1:1）。
 * 具体 Telegram HTTP API 实现在 frontend/telegram/TelegramBotServer.ts，
 * 通过 telegramGateway 注入的 factory 反转依赖。
 */

export { telegramService } from './telegramService'
export type { TelegramBotGateway, TelegramBotGatewayFactory } from './telegramGateway'
export { registerTelegramBotGatewayFactory } from './telegramGateway'
