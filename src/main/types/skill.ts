/**
 * Skill 数据结构（基于文件系统 ~/.shuvix/skills/<name>/）
 * 每个 skill 是一个目录，包含 SKILL.md（入口）和可选伴随文件
 */
export interface Skill {
  /** skill 标识符 = 目录名（如 "pdf"、"brand-guide"） */
  name: string
  /** 触发条件描述（从 SKILL.md frontmatter 中提取） */
  description: string
  /** SKILL.md 正文（去除 frontmatter 后的 markdown） */
  content: string
  /** skill 目录的绝对路径 */
  basePath: string
  /** 是否全局启用 */
  isEnabled: boolean
}

/** IPC: 创建 Skill 参数（手动填写） */
export interface SkillAddParams {
  name: string
  description: string
  content: string
}

/** IPC: 更新 Skill 参数 */
export interface SkillUpdateParams {
  name: string
  description?: string
  content?: string
  isEnabled?: boolean
}
