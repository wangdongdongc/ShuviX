/** 斜杠命令定义（来自 .claude/commands/ 项目命令、skill 或子代理派发） */
export interface SlashCommand {
  /** 命令标识符，如 "opsx:explore" 或 "review"；kind='agent' 时即 agent name */
  commandId: string
  /** 显示名称（frontmatter name 或 commandId） */
  name: string
  /** 命令描述（frontmatter description） */
  description: string
  /** 模板正文（frontmatter 之后的 markdown）；kind='agent' 无模板，恒为空串 */
  template: string
  /** 源文件路径（调试用） */
  filePath: string
  /** 依赖的工具名（选中命令时自动启用这些工具） */
  requiredTools?: string[]
  /**
   * 命令来源——'project' 来自 .claude/commands/，'skill' 来自 SKILL.md；
   * 'agent' 来自子代理注册表：`/<agentName> <prompt>` 不做模板展开，
   * 由前端走 agent.dispatchPrompt 直接派发具名子智能体
   */
  kind?: 'project' | 'skill' | 'agent'
}
