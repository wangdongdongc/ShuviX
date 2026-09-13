/**
 * Bot 会话的形态判定 —— 两个宿主与渲染层共用的一份。
 *
 * 一条 bot 会话绑定**一个** bot（`settings.bot`，指向 `~/.shuvix/bots/<name>.md`），在创建那一刻
 * 定死，之后不可转回普通会话，也不可换绑 —— 换一个 bot 就是另开一条会话，因为这条会话的全部
 * 历史都是那个 bot 说的话。
 *
 * **它是一条普通的有根会话**：根 Agent 的档案是基座 `bot`，人设与记忆经 systemContext 注入它的
 * 系统提示词。于是模型选择、工具勾选、压缩、导出、子会话、自动续跑 —— 会话该有的一切都天然
 * 成立，一行都不用为 bot 另写。
 *
 * 判定一律走这里，别在各处手写 `!!settings.bot`：空串 / 纯空白要算「没绑定」。
 */

/** 判定所需的最小字段（SessionSettings 是它的超集） */
export interface BotSessionShape {
  bot?: string
}

/** 绑定的 bot 名；不是 bot 会话则为 undefined */
export function boundBotOf(settings?: BotSessionShape | null): string | undefined {
  const bot = settings?.bot
  return typeof bot === 'string' && bot.trim() ? bot.trim() : undefined
}

/** 这是不是一条 bot 会话 */
export function isBotSessionSettings(settings?: BotSessionShape | null): boolean {
  return !!boundBotOf(settings)
}
