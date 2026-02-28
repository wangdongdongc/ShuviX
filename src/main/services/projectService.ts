import { v7 as uuidv7 } from 'uuid'
import { projectDao } from '../dao/projectDao'
import type { Project } from '../types'
import { basename, resolve } from 'path'
import { expandPath } from '../tools/utils/pathUtils'

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
  systemPrompt: { labelKey: 'projectForm.prompt', desc: 'Project-level system prompt' },
  sandboxEnabled: { labelKey: 'projectForm.sandbox', desc: 'Enable sandbox mode (boolean)' },
  enabledTools: { labelKey: 'projectForm.tools', desc: 'List of enabled tool names (string[])' },
  referenceDirs: {
    labelKey: 'projectForm.referenceDirs',
    desc: 'Reference directories for AI to access (array of {path, note?, access?}). access: readonly (default) or readwrite'
  }
}

/** 所有已知项目字段描述列表（供 AI prompt / 参数 description 使用） */
export function getProjectFieldDescriptions(): string {
  return Object.entries(KNOWN_PROJECT_FIELDS)
    .map(([field, e]) => `${field} (${e.desc})`)
    .join(', ')
}

/**
 * 参考目录去重：基于 resolve 后的绝对路径去重，同时排除与项目根路径相同的条目
 * @param dirs 原始参考目录列表
 * @param projectPath 项目根目录绝对路径（可选，传入时会过滤掉与之相同的条目）
 */
function deduplicateReferenceDirs(
  dirs: Array<{ path: string; note?: string; access?: string }>,
  projectPath?: string
): Array<{ path: string; note?: string; access?: string }> {
  const resolvedProjectPath = projectPath ? resolve(expandPath(projectPath)) : undefined
  const seen = new Set<string>()
  const result: Array<{ path: string; note?: string; access?: string }> = []
  for (const d of dirs) {
    const abs = resolve(expandPath(d.path))
    // 跳过与项目根目录相同的条目
    if (resolvedProjectPath && abs === resolvedProjectPath) continue
    if (seen.has(abs)) continue
    seen.add(abs)
    result.push({ ...d, path: abs })
  }
  return result
}

// ---------- 项目服务 ----------

/**
 * 项目服务 — 编排项目相关的业务逻辑
 */
export class ProjectService {
  /** 获取未归档项目 */
  list(): Project[] {
    return projectDao.findAllActive()
  }

  /** 获取已归档项目 */
  listArchived(): Project[] {
    return projectDao.findAllArchived()
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
    referenceDirs?: Array<{ path: string; note?: string; access?: string }>
    archived?: boolean
  }): Project {
    const now = Date.now()
    const id = uuidv7()
    const settings: Record<
      string,
      string[] | Array<{ path: string; note?: string; access?: string }>
    > = {}
    if (params.enabledTools) settings.enabledTools = params.enabledTools
    if (params.referenceDirs)
      settings.referenceDirs = deduplicateReferenceDirs(params.referenceDirs, params.path)
    const project: Project = {
      id,
      name: params.name || basename(params.path) || params.path,
      path: resolve(expandPath(params.path)),
      systemPrompt: params.systemPrompt || '',
      dockerEnabled: params.dockerEnabled ? 1 : 0,
      dockerImage: params.dockerImage || '',
      sandboxEnabled: params.sandboxEnabled === false ? 0 : 1,
      settings: JSON.stringify(settings),
      archivedAt: params.archived ? now : 0,
      createdAt: now,
      updatedAt: now
    }
    projectDao.insert(project)
    return project
  }

  /** 更新项目 */
  update(
    id: string,
    params: {
      name?: string
      path?: string
      systemPrompt?: string
      dockerEnabled?: boolean
      dockerImage?: string
      sandboxEnabled?: boolean
      enabledTools?: string[]
      referenceDirs?: Array<{ path: string; note?: string; access?: string }>
      archived?: boolean
    }
  ): void {
    // 处理 settings JSON 字段（合并而非覆盖）
    let settingsUpdate: string | undefined
    if (params.enabledTools !== undefined || params.referenceDirs !== undefined) {
      const existing = projectDao.findById(id)
      const current = (() => {
        try {
          const p = JSON.parse(existing?.settings || '{}')
          return typeof p === 'object' && p !== null ? p : {}
        } catch {
          return {}
        }
      })()
      if (params.enabledTools !== undefined) current.enabledTools = params.enabledTools
      if (params.referenceDirs !== undefined) {
        // 获取项目路径用于去重校验
        const projPath = params.path ?? existing?.path
        current.referenceDirs = deduplicateReferenceDirs(params.referenceDirs, projPath)
      }
      settingsUpdate = JSON.stringify(current)
    }
    projectDao.update(id, {
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.path !== undefined ? { path: resolve(expandPath(params.path)) } : {}),
      ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
      ...(params.dockerEnabled !== undefined
        ? { dockerEnabled: params.dockerEnabled ? 1 : 0 }
        : {}),
      ...(params.dockerImage !== undefined ? { dockerImage: params.dockerImage } : {}),
      ...(params.sandboxEnabled !== undefined
        ? { sandboxEnabled: params.sandboxEnabled ? 1 : 0 }
        : {}),
      ...(params.archived !== undefined ? { archivedAt: params.archived ? Date.now() : 0 } : {}),
      ...(settingsUpdate !== undefined ? { settings: settingsUpdate } : {})
    })
  }

  /** 删除项目及其所有关联会话和消息 */
  delete(id: string): void {
    projectDao.deleteById(id)
  }
}

export const projectService = new ProjectService()
