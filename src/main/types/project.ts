/** 参考目录访问模式 */
export type ReferenceDirAccess = 'readonly' | 'readwrite'

/** 参考目录条目 */
export interface ReferenceDir {
  /** 目录绝对路径 */
  path: string
  /** 用户注释（帮助 AI 理解目录用途） */
  note?: string
  /** 访问模式：readonly（默认）仅允许读取，readwrite 允许读写 */
  access?: ReferenceDirAccess
}

/** 项目数据结构 */
export interface Project {
  id: string
  /** 项目名称（默认取目录名） */
  name: string
  /** 项目根目录绝对路径 */
  path: string
  /** 项目级 system prompt（和全局默认 prompt 同时生效） */
  systemPrompt: string
  /** 是否启用 Docker 隔离 */
  dockerEnabled: number
  /** Docker 镜像名 */
  dockerImage: string
  /** 是否启用沙箱模式（限制文件越界 + bash 需确认） */
  sandboxEnabled: number
  /** JSON 扩展字段（预留） */
  settings: string
  /** 归档时间戳（0 表示未归档） */
  archivedAt: number
  createdAt: number
  updatedAt: number
}

/** IPC: 创建项目参数 */
export interface ProjectCreateParams {
  name?: string
  path: string
  systemPrompt?: string
  dockerEnabled?: boolean
  dockerImage?: string
  sandboxEnabled?: boolean
  enabledTools?: string[]
  referenceDirs?: ReferenceDir[]
  archived?: boolean
}

/** IPC: 更新项目参数 */
export interface ProjectUpdateParams {
  id: string
  name?: string
  path?: string
  systemPrompt?: string
  dockerEnabled?: boolean
  dockerImage?: string
  sandboxEnabled?: boolean
  enabledTools?: string[]
  referenceDirs?: ReferenceDir[]
  archived?: boolean
}

/** IPC: 删除项目参数 */
export interface ProjectDeleteParams {
  id: string
}
