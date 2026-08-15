/**
 * Telegram 模块入口
 *
 * Telegram Bot 登记表：仅负责 Bot 的 CRUD 与 token 校验。
 *
 * 没有任何运行时 —— 不轮询、不收发消息、不绑定会话。会话流绑定那一套（长轮询、
 * 消息中继、1:1 绑定）已整体下线，这里留下的是一张待用的登记表。
 */

export { telegramService } from './telegramService'
