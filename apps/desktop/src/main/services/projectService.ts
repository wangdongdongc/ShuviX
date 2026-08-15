import { v7 as uuidv7 } from 'uuid'
import { WIKI_PROJECT_ID } from '@shuvix/chat-protocol/wiki'
import { projectDao } from '../dao/projectDao'
import { appEventBus } from '../utils/appEventBus'
import type { Project, ProjectSettings } from '../types'
import { basename, resolve } from 'path'
import { expandPath } from '../utils/toolUtils/pathUtils'

// ---------- 项目字段元数据注册表 ----------

export interface ProjectFieldMeta {
  /** 对应项目编辑页面的 i18n key（用于前端展示） */
  labelKey: string
  /** AI 可读描述（用于工具参数 description 和 prompt） */
  desc: string
}

/**
 * 所有已知的项目可修改字段元数据注册表
 * 新增字段时在此追加一行，工具参数描述、AI prompt、审批弹窗标签自动同步
 */
export const KNOWN_PROJECT_FIELDS: Record<string, ProjectFieldMeta> = {
  name: { labelKey: 'projectForm.name', desc: 'Project display name' },
  systemPrompt: {
    labelKey: 'projectForm.systemPrompt',
    desc: 'Project-level system prompt as plain text (injected into sessions of this project)'
  },
  enabledTools: {
    labelKey: 'projectForm.wizardStepExtensions',
    desc: 'List of enabled MCP/Skill identifiers — entries must be prefixed with mcp: or skill: (string[])'
  },
  'tool.pglitePersist': {
    labelKey: 'projectForm.pglitePersistLabel',
    desc: 'Enable PGLite persistent storage — data stored in project folder .shuvix/pglite/data (boolean)'
  }
}

/** 所有已知项目字段描述列表（供 AI prompt / 参数 description 使用） */
export function getProjectFieldDescriptions(): string {
  return Object.entries(KNOWN_PROJECT_FIELDS)
    .map(([field, e]) => `${field} (${e.desc})`)
    .join(', ')
}

// ---------- 项目服务 ----------

/**
 * 项目服务 — 编排项目相关的业务逻辑
 */
export class ProjectService {
  /** 获取未归档项目(不含隐藏的 wiki 项目;getById 不过滤,保证其会话正常解析) */
  list(): Project[] {
    return projectDao.findAllActive().filter((p) => p.id !== WIKI_PROJECT_ID)
  }

  /** 获取已归档项目(不含隐藏的 wiki 项目) */
  listArchived(): Project[] {
    return projectDao.findAllArchived().filter((p) => p.id !== WIKI_PROJECT_ID)
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
    enabledTools?: string[]
    tool?: import('../dao/types').ToolSettings
    archived?: boolean
  }): Project {
    const now = Date.now()
    const id = uuidv7()
    const settings: ProjectSettings = {}
    if (params.enabledTools) settings.enabledTools = params.enabledTools
    if (params.tool) settings.tool = params.tool
    const project: Project = {
      id,
      name: params.name || basename(params.path) || params.path,
      path: resolve(expandPath(params.path)),
      systemPrompt: params.systemPrompt ?? '',
      settings,
      archivedAt: params.archived ? now : 0,
      createdAt: now,
      updatedAt: now
    }
    projectDao.insert(project)
    appEventBus.publish({ type: 'project.changed' })
    return project
  }

  /** 更新项目 */
  update(
    id: string,
    params: {
      name?: string
      path?: string
      systemPrompt?: string
      enabledTools?: string[]
      tool?: import('../dao/types').ToolSettings
      archived?: boolean
    }
  ): void {
    // 处理 settings 字段（合并而非覆盖）
    let settingsUpdate: ProjectSettings | undefined
    if (params.enabledTools !== undefined || params.tool !== undefined) {
      const existing = projectDao.pick(id, ['settings'])
      const current: ProjectSettings = { ...(existing?.settings || {}) }
      if (params.enabledTools !== undefined) current.enabledTools = params.enabledTools
      if (params.tool !== undefined) current.tool = { ...(current.tool || {}), ...params.tool }
      settingsUpdate = current
    }
    projectDao.update(id, {
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.path !== undefined ? { path: resolve(expandPath(params.path)) } : {}),
      ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
      ...(params.archived !== undefined ? { archivedAt: params.archived ? Date.now() : 0 } : {}),
      ...(settingsUpdate !== undefined ? { settings: settingsUpdate } : {})
    })
    appEventBus.publish({ type: 'project.changed' })
  }

  /** 删除项目及其所有关联会话和消息 */
  delete(id: string): void {
    projectDao.deleteById(id)
    appEventBus.publish({ type: 'project.changed' })
  }
}

export const projectService = new ProjectService()
