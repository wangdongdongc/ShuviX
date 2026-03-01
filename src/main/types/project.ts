export type { Project } from '../dao/types'

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
