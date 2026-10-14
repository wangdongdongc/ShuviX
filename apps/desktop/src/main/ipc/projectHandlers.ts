import { defineHandler } from './registry'
import { projectService, KNOWN_PROJECT_FIELDS } from '../services/projectService'
import type { ProjectCreateParams, ProjectUpdateParams, ProjectDeleteParams } from '../types'

/**
 * 项目管理 IPC 处理器
 *
 * project.changed 事件由 projectService 各 mutator 在数据层发布，此处不再广播。
 */
export function registerProjectHandlers(): void {
  /** 获取所有项目 */
  defineHandler('project:list', () => {
    return projectService.list()
  })

  /** 获取已归档项目 */
  defineHandler('project:listArchived', () => {
    return projectService.listArchived()
  })

  /** 获取单个项目 */
  defineHandler('project:getById', (_ctx, id: string) => {
    return projectService.getById(id) || null
  })

  /** 创建项目 */
  defineHandler('project:create', (_ctx, params: ProjectCreateParams) => {
    const project = projectService.create(params)
    return project
  })

  /** 更新项目 */
  defineHandler('project:update', (_ctx, params: ProjectUpdateParams) => {
    projectService.update(params.id, params)
    return { success: true }
  })

  /** 删除项目 */
  defineHandler('project:delete', (_ctx, params: ProjectDeleteParams) => {
    projectService.delete(params.id)
    return { success: true }
  })

  /** 获取已知项目字段的元数据（labelKey + desc） */
  defineHandler('project:getKnownFields', () => {
    return KNOWN_PROJECT_FIELDS
  })
}
