/**
 * 实验功能清单 —— 不对用户承诺稳定性的功能：后续版本可能做不兼容的变更，甚至整个移除，
 * 不保证迁移已有的配置与数据。入口上的「实验」小标签（app-shell / chat-ui 的 `ExperimentalTag`）只认这张表。
 *
 * 值是悬停说明的 i18n 键。多数功能共用一句通用说明；个别功能另有必须交代的现状 ——
 * Telegram Bot 目前只是登记，登记后什么都不会发生，光说「以后可能会变」等于没说。
 *
 * 转正 = 删掉这里的一行：各入口的 `experimental: '<id>'` 随之类型报错，顺手删掉即可，
 * 不会留下一枚指向已转正功能的死标签。
 */
export const EXPERIMENTAL_FEATURES = {
  voice: 'experimental.hint',
  bots: 'experimental.hint',
  triggers: 'experimental.hint',
  tracking: 'experimental.hint',
  taskList: 'experimental.hint',
  telegramBots: 'experimental.hintTelegramBots'
} as const

export type ExperimentalFeature = keyof typeof EXPERIMENTAL_FEATURES

/**
 * 实验性质的内置能力服务器（server 名 → 功能）：扩展选择器与设置 → MCP 里的那一行带标签。
 * 名字与内置行一一对应（撞名的自定义行会被种子迁移改名），调用方仍应先看 isBuiltin。
 */
const EXPERIMENTAL_BUILTIN_MCP: Readonly<Record<string, ExperimentalFeature>> = {
  plan: 'taskList'
}

/** 内置 server 名（或选择器里的 `mcp:<name>`）→ 它算哪个实验功能；不是 → undefined */
export function experimentalFeatureOfMcp(name: string): ExperimentalFeature | undefined {
  const server = name.startsWith('mcp:') ? name.slice('mcp:'.length) : name
  return Object.prototype.hasOwnProperty.call(EXPERIMENTAL_BUILTIN_MCP, server)
    ? EXPERIMENTAL_BUILTIN_MCP[server]
    : undefined
}
