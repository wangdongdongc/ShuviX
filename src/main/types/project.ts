import type { ReferenceDir, ToolSettings } from '../dao/types'
import type { ProjectPromptSection } from '../../shared/types/promptSection'

export type {
  Project,
  ProjectEnvVar,
  ProjectSettings,
  ReferenceDir,
  ToolSettings,
  ProjectPromptSection
} from '../dao/types'

/** IPC: 创建项目参数 */
export interface ProjectCreateParams {
  name?: string
  path: string
  promptSections?: ProjectPromptSection[]
  enabledTools?: string[]
  referenceDirs?: ReferenceDir[]
  tool?: ToolSettings
  archived?: boolean
}

/** IPC: 更新项目参数 */
export interface ProjectUpdateParams {
  id: string
  name?: string
  path?: string
  promptSections?: ProjectPromptSection[]
  enabledTools?: string[]
  referenceDirs?: ReferenceDir[]
  tool?: ToolSettings
  archived?: boolean
}

/** IPC: 删除项目参数 */
export interface ProjectDeleteParams {
  id: string
}
