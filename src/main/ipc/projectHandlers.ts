import { ipcMain, BrowserWindow } from 'electron'
import { projectService, KNOWN_PROJECT_FIELDS } from '../services/projectService'
import type { ProjectCreateParams, ProjectUpdateParams, ProjectDeleteParams } from '../types'

/** 通知所有渲染进程窗口:项目列表已变更 */
function broadcastProjectChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('project:changed')
    }
  }
}

/**
 * 项目管理 IPC 处理器
 */
export function registerProjectHandlers(): void {
  /** 获取所有项目 */
  ipcMain.handle('project:list', () => {
    return projectService.list()
  })

  /** 获取已归档项目 */
  ipcMain.handle('project:listArchived', () => {
    return projectService.listArchived()
  })

  /** 获取单个项目 */
  ipcMain.handle('project:getById', (_event, id: string) => {
    return projectService.getById(id) || null
  })

  /** 创建项目 */
  ipcMain.handle('project:create', (_event, params: ProjectCreateParams) => {
    const project = projectService.create(params)
    broadcastProjectChanged()
    return project
  })

  /** 更新项目 */
  ipcMain.handle('project:update', (_event, params: ProjectUpdateParams) => {
    projectService.update(params.id, params)
    broadcastProjectChanged()
    return { success: true }
  })

  /** 删除项目 */
  ipcMain.handle('project:delete', (_event, params: ProjectDeleteParams) => {
    projectService.delete(params.id)
    broadcastProjectChanged()
    return { success: true }
  })

  /** 获取已知项目字段的元数据（labelKey + desc） */
  ipcMain.handle('project:getKnownFields', () => {
    return KNOWN_PROJECT_FIELDS
  })
}
