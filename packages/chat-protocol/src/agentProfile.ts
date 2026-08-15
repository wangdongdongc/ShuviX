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
