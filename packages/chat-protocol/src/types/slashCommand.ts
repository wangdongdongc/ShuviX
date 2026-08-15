/** 斜杠命令定义（来自 .claude/commands/ 项目命令或 skill） */
export interface SlashCommand {
  /** 命令标识符，如 "opsx:explore" 或 "review" */
  commandId: string
  /** 显示名称（frontmatter name 或 commandId） */
  name: string
  /** 命令描述（frontmatter description） */
  description: string
  /** 模板正文（frontmatter 之后的 markdown） */
  template: string
  /** 源文件路径（调试用） */
  filePath: string
  /** 依赖的工具名（选中命令时自动启用这些工具） */
  requiredTools?: string[]
  /**
   * 命令来源——'project' 来自 .claude/commands/，'skill' 来自 SKILL.md。
   * （曾有 'agent'：`/<agentName>` 切换会话档案，已改由输入框的档案选择器承担。）
   */
  kind?: 'project' | 'skill'
}
