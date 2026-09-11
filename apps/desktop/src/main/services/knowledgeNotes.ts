/**
 * 知识库笔记 —— 侧栏「知识库」分组点行的后端：一个隐藏项目（固定 id = KNOWLEDGE_PROJECT_ID，
 * path = ~/.shuvix/knowledge-shuvix）承载全部 bundle 的笔记本会话，不出现在项目列表
 * （projectService.list 过滤）。每个条目文件至多一个笔记本会话，重复打开复用已有会话。
 *
 * `notebookPath` 与条目视图的 `path` 同一口径：**shuvix 根相对**（如 `projects/acme/x.md`），
 * 所以跨 bundle 唯一。与 wikiService 同一套做法；清单归 services/knowledge/。
 */
import { KNOWLEDGE_PROJECT_ID } from '@shuvix/chat-protocol/knowledge'
import { normalizeBundlePath, titleFromPath } from '@shuvix/agent-runtime'
import { projectDao } from '../dao/projectDao'
import { sessionDao } from '../dao/sessionDao'
import { sessionService } from './sessionService'
import { bundleFilePath, getShuvixKnowledgeRoot, locateBundle } from './knowledge'
import type { Project, Session } from '../types'

/** 面向用户的功能名（隐藏项目的 name；同旧 wiki 项目的「知识库」，靠 id 区分） */
const KNOWLEDGE_PROJECT_NAME = '知识库'

/**
 * 确保隐藏知识库项目存在并返回（目录本身由写入 / 建 bundle 时懒建）。
 * 不发 project.changed —— 该项目对列表不可见。
 */
export function ensureKnowledgeProject(): Project {
  const root = getShuvixKnowledgeRoot()
  const existing = projectDao.findById(KNOWLEDGE_PROJECT_ID)
  if (existing) {
    // 容错：历史行 path/name 与当前值不一致时纠正（如 home 目录迁移）
    const patch: Partial<Pick<Project, 'name' | 'path'>> = {}
    if (existing.path !== root) patch.path = root
    if (existing.name !== KNOWLEDGE_PROJECT_NAME) patch.name = KNOWLEDGE_PROJECT_NAME
    if (Object.keys(patch).length > 0) {
      projectDao.update(KNOWLEDGE_PROJECT_ID, patch)
      return { ...existing, ...patch }
    }
    return existing
  }
  const now = Date.now()
  const project: Project = {
    id: KNOWLEDGE_PROJECT_ID,
    name: KNOWLEDGE_PROJECT_NAME,
    path: root,
    systemPrompt: '',
    settings: {},
    archivedAt: 0,
    createdAt: now,
    updatedAt: now
  }
  projectDao.insert(project)
  return project
}

/**
 * 打开知识库条目的笔记本：同文件已有笔记本会话则复用，否则创建（main 单线程 + 同步 SQLite，
 * 查建原子）。`title` 是条目的显示名（frontmatter title），缺省文件名 stem。路径是 shuvix 根
 * 相对的，必须落在某个 bundle 里 —— 落不进去（越界、指到容器目录上）直接拒绝（抛错）。
 */
export async function openKnowledgeNote(relPath: string, title?: string): Promise<Session> {
  const normalized = normalizeBundlePath(relPath)
  // 渲染端只会传清单里的路径；这里仍守一道：必须解析得出所属 bundle
  if (!normalized || !locateBundle(bundleFilePath('', normalized))) {
    throw new Error(`Invalid knowledge path: ${relPath}`)
  }
  const project = ensureKnowledgeProject()
  const existing = sessionDao.findByProjectAndNotebookPath(project.id, normalized)
  if (existing) return existing
  return sessionService.create({
    projectId: project.id,
    notebookPath: normalized,
    title: title?.trim() || titleFromPath(normalized)
  })
}
