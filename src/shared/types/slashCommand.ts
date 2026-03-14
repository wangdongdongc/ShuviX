/** 斜杠命令定义（从 .claude/commands/ 发现） */
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
}
