import type { ReferenceDir } from '../dao/types'

export type { Project, ProjectSettings, ReferenceDir } from '../dao/types'

/** IPC: 创建项目参数 */
export interface ProjectCreateParams {
  name?: string
  path: string
  systemPrompt?: string
  dockerEnabled?: boolean
  dockerImage?: string
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
  enabledTools?: string[]
  referenceDirs?: ReferenceDir[]
  archived?: boolean
}

/** IPC: 删除项目参数 */
export interface ProjectDeleteParams {
  id: string
}
