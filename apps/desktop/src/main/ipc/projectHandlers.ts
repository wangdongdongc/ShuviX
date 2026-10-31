import { defineHandler } from './registry'
import { projectService, KNOWN_PROJECT_FIELDS } from '../services/projectService'
import { sessionRecords } from '../services/sessionRecords'
import { sessionService } from '../services/sessionService'
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

  /**
   * 删除项目连同它的会话。会话逐条走 sessionService.delete（运行时、对话文件、工具大结果、产物、权限表、日历行、
   * 子会话一并清掉）—— 以前只删了数据库里那几行，每条会话的文件都留在磁盘上没人管（2026-10-31 补上）。
   * 只删项目的**成员**：引用它当工作位置的 bot 会话只归属 bot，不跟着删（它们退回建会话时记下的路径快照）。
   * 项目知识库（`~/.shuvix/knowledge-shuvix/projects/<id>`）是用户写下的条目，这里不删
   */
  defineHandler('project:delete', async (_ctx, params: ProjectDeleteParams) => {
    const members = sessionRecords.findByProjectId(params.id)
    const ids = new Set(members.map((s) => s.id))
    // 只删顶层的那几条：子会话随父会话级联（父会话不在这个项目里的子会话 —— 不该有 —— 照样单删）
    for (const s of members) {
      if (!s.parentId || !ids.has(s.parentId)) await sessionService.delete(s.id)
    }
    projectService.delete(params.id)
    return { success: true }
  })

  /** 获取已知项目字段的元数据（labelKey + desc） */
  defineHandler('project:getKnownFields', () => {
    return KNOWN_PROJECT_FIELDS
  })
}
