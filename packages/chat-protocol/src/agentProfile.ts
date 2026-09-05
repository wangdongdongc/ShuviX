/**
 * 会话档案的跨端常量。
 *
 * 放在 chat-protocol 是因为**渲染层也要用**：输入框的档案选择器要判断「当前是不是基座
 * 档案」（决定着色）以及会话设置缺省时回落到哪个名字，而渲染进程够不到 agent-runtime。
 * agent-runtime 的 `DEFAULT_PROFILE_NAME` 从这里导入再导出，全仓仍是同一个值。
 */

/**
 * 主会话的基座档案名。会话设置里没有 `agentProfile`、或它指向的 md 文件已不存在时，
 * 后端一律回落到它（见 sessionService.resolveAgentProfileName）。
 * 它可被 `~/.shuvix/agents/default.md` 覆盖，但名字本身是固定的。
 */
export const DEFAULT_PROFILE_NAME = 'default'

/**
 * 聊天会话（不属于任何项目）的基座档案名。它与 `default` 是**两条路线**：`chat` 握着
 * 完整内置工具、倾向自己把活干完，`default` 倾向把成规模的活儿交给 `coding` 子会话、
 * 自己做需求确认与验收。哪一条用在哪种会话由设置里的两个默认档案决定
 * （`general.defaultChatAgent` / `general.defaultProjectAgent`），此处只钉住名字。
 * 同样可被 `~/.shuvix/agents/chat.md` 覆盖。
 */
export const CHAT_PROFILE_NAME = 'chat'

/**
 * 新会话默认档案的两个设置 key —— 会话形态（有没有项目）决定读哪一个。
 * 值是档案名，缺省即 `default` / `chat` 两个基座；指向的档案不存在时后端回落基座。
 */
export const DEFAULT_PROJECT_AGENT_KEY = 'general.defaultProjectAgent'
export const DEFAULT_CHAT_AGENT_KEY = 'general.defaultChatAgent'
