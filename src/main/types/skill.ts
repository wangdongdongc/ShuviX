/**
 * Skill 数据结构（基于文件系统 ~/.shuvix/skills/<name>/）
 * 每个 skill 是一个目录，包含 SKILL.md（入口）和可选伴随文件
 */
export interface Skill {
  /** skill 标识符：默认目录为原名，外部目录为 dirName:skillName */
  name: string
  /** 触发条件描述（从 SKILL.md frontmatter 中提取） */
  description: string
  /** SKILL.md 正文（去除 frontmatter 后的 markdown） */
  content: string
  /** skill 目录的绝对路径 */
  basePath: string
  /** 是否全局启用 */
  isEnabled: boolean
  /** skill 来源 */
  source: 'default' | 'project' | 'external' | 'builtin'
  /** 外部目录名称（external 用用户取名；builtin 固定为 'builtin'） */
  dirName?: string
}

/** 外部 skill 目录 */
export interface SkillDir {
  /** 用户提供的唯一名称 */
  name: string
  /** 目录绝对路径 */
  path: string
}

/** skill:listGrouped 返回的分组结构 */
export interface SkillGroup {
  /** 目录名称（默认目录为 'default'） */
  dirName: string
  /** 目录路径 */
  dirPath: string
  /** 是否为默认目录 */
  isDefault: boolean
  /** 该目录下的 skills */
  skills: Skill[]
}

/** IPC: 更新 Skill 参数 */
export interface SkillUpdateParams {
  name: string
  description?: string
  content?: string
  isEnabled?: boolean
}
