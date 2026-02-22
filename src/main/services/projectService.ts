import { v7 as uuidv7 } from 'uuid'
import { projectDao } from '../dao/projectDao'
import type { Project } from '../types'
import { basename } from 'path'

/**
 * 项目服务 — 编排项目相关的业务逻辑
 */
export class ProjectService {
  /** 获取所有项目 */
  list(): Project[] {
    return projectDao.findAll()
  }

  /** 获取单个项目 */
  getById(id: string): Project | undefined {
    return projectDao.findById(id)
  }

  /** 根据路径查找项目 */
  getByPath(path: string): Project | undefined {
    return projectDao.findByPath(path)
  }

  /** 创建项目 */
  create(params: {
    name?: string
    path: string
    systemPrompt?: string
    dockerEnabled?: boolean
    dockerImage?: string
    sandboxEnabled?: boolean
    enabledTools?: string[]
  }): Project {
    const now = Date.now()
    const id = uuidv7()
    const settings: Record<string, any> = {}
    if (params.enabledTools) settings.enabledTools = params.enabledTools
    const project: Project = {
      id,
      name: params.name || basename(params.path) || params.path,
      path: params.path,
      systemPrompt: params.systemPrompt || '',
      dockerEnabled: params.dockerEnabled ? 1 : 0,
      dockerImage: params.dockerImage || 'ubuntu:latest',
      sandboxEnabled: params.sandboxEnabled === false ? 0 : 1,
      settings: JSON.stringify(settings),
      createdAt: now,
      updatedAt: now
    }
    projectDao.insert(project)
    return project
  }

  /** 更新项目 */
  update(id: string, params: {
    name?: string
    path?: string
    systemPrompt?: string
    dockerEnabled?: boolean
    dockerImage?: string
    sandboxEnabled?: boolean
    enabledTools?: string[]
  }): void {
    // 处理 settings JSON 字段（合并而非覆盖）
    let settingsUpdate: string | undefined
    if (params.enabledTools !== undefined) {
      const existing = projectDao.findById(id)
      const current = (() => { try { return JSON.parse(existing?.settings || '{}') } catch { return {} } })()
      current.enabledTools = params.enabledTools
      settingsUpdate = JSON.stringify(current)
    }
    projectDao.update(id, {
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.path !== undefined ? { path: params.path } : {}),
      ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
      ...(params.dockerEnabled !== undefined ? { dockerEnabled: params.dockerEnabled ? 1 : 0 } : {}),
      ...(params.dockerImage !== undefined ? { dockerImage: params.dockerImage } : {}),
      ...(params.sandboxEnabled !== undefined ? { sandboxEnabled: params.sandboxEnabled ? 1 : 0 } : {}),
      ...(settingsUpdate !== undefined ? { settings: settingsUpdate } : {})
    })
  }

  /** 删除项目（关联 session 的 projectId 会被置空） */
  delete(id: string): void {
    projectDao.deleteById(id)
  }
}

export const projectService = new ProjectService()
