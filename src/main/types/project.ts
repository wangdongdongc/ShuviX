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
}

/** IPC: 删除项目参数 */
export interface ProjectDeleteParams {
  id: string
}
