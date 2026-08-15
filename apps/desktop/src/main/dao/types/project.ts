/** 项目环境变量 */
export interface ProjectEnvVar {
  /** 变量名 */
  key: string
  /** 值（明文存储） */
  value: string
  /** 是否敏感（仅影响前端显示：password 输入框 vs 明文） */
  sensitive: boolean
}

/** 工具扩展配置 */
export interface ToolSettings {
  /** PGLite 持久化存储开关（开启后数据存储到项目文件夹 .shuvix/pglite/data） */
  pglitePersist?: boolean
  /** 项目环境变量（bash 执行时自动注入） */
  envVars?: ProjectEnvVar[]
}

/** 项目扩展配置 */
export interface ProjectSettings {
  enabledTools?: string[]
  /** 工具扩展配置 */
  tool?: ToolSettings
}

/** 项目数据结构（对应 DB 表 projects） */
export interface Project {
  id: string
  /** 项目名称（默认取目录名） */
  name: string
  /** 项目根目录绝对路径 */
  path: string
  /** 项目提示词（纯文本；经 shuvix-project-prompt 开关注入会话上下文） */
  systemPrompt: string
  /** 项目扩展配置 */
  settings: ProjectSettings
  /** 归档时间戳（0 表示未归档） */
  archivedAt: number
  createdAt: number
  updatedAt: number
}
