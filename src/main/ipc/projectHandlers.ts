import { ipcMain } from 'electron'
import { projectService, KNOWN_PROJECT_FIELDS } from '../services/projectService'
import type { ProjectCreateParams, ProjectUpdateParams, ProjectDeleteParams } from '../types'

/**
 * 项目管理 IPC 处理器
 */
export function registerProjectHandlers(): void {
  /** 获取所有项目 */
  ipcMain.handle('project:list', () => {
    return projectService.list()
  })

  /** 获取单个项目 */
  ipcMain.handle('project:getById', (_event, id: string) => {
    return projectService.getById(id) || null
  })

  /** 创建项目 */
  ipcMain.handle('project:create', (_event, params: ProjectCreateParams) => {
    return projectService.create(params)
  })

  /** 更新项目 */
  ipcMain.handle('project:update', (_event, params: ProjectUpdateParams) => {
    projectService.update(params.id, params)
    return { success: true }
  })

  /** 删除项目 */
  ipcMain.handle('project:delete', (_event, params: ProjectDeleteParams) => {
    projectService.delete(params.id)
    return { success: true }
  })

  /** 获取已知项目字段的元数据（labelKey + desc） */
  ipcMain.handle('project:getKnownFields', () => {
    return KNOWN_PROJECT_FIELDS
  })
}
