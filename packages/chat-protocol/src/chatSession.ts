/**
 * 聊天会话（bot 一对一会话）的形态判定 —— 两个宿主与渲染层共用的一份。
 *
 * 一个聊天会话绑定**一个** bot（`settings.bot`）。它没有根 Agent，用户消息由这个 bot 的
 * 管线应答；形态在创建那一刻定死，之后不可转回普通会话。
 *
 * `settings.bots` 是群聊时代的遗留键（成员名单）。**没有做迁移**：带着它的老会话仍被认作
 * 聊天会话（否则它们的 `chat_messages` 历史在普通会话的渲染路径下没有来源），但视为
 * **未绑定 bot** —— 由用户在会话头部重新选一个，写进 `bot`。遗留键只读、不再写入，
 * `bot` 一旦有值就压过它。
 *
 * 判定一律走这里，别在各处手写 `bots?.length` / `!!bot`：一处口径，两个宿主与三层 UI
 * 才不会各自漂移。
 */

/** 判定所需的最小字段（SessionSettings 是它的超集） */
export interface ChatSessionShape {
  bot?: string
  /** 遗留：群聊时代的成员名单，只读 */
  bots?: string[]
}

/** 绑定的 bot 名；未绑定（含遗留会话）为 undefined */
export function boundBotOf(settings?: ChatSessionShape | null): string | undefined {
  const bot = settings?.bot
  return typeof bot === 'string' && bot.trim() ? bot : undefined
}

/**
 * 这是不是一个聊天会话（无根会话）。
 *
 * 绑定了 bot、或带着遗留成员名单，都算 —— 后者只是「还没重新选 bot」的聊天会话。
 * 遗留名单一律用 `?.length` 判：settings 的 JSON patch 没有删键路径，群聊时代
 * 「移除全部成员」只能写 `[]`，而空数组是 truthy。
 */
export function isChatSessionSettings(settings?: ChatSessionShape | null): boolean {
  return !!boundBotOf(settings) || (settings?.bots?.length ?? 0) > 0
}
