/**
 * 知识库笔记 —— 侧栏「知识库」分组点行的后端：知识库是一个隐藏项目（固定 id =
 * KNOWLEDGE_PROJECT_ID，path = ~/.shuvix/knowledge），不出现在项目列表（projectService.list
 * 过滤），仅承载笔记本会话：每个条目文件至多一个笔记本会话，重复打开复用已有会话。
 * 与 wikiService 同一套做法；文件清单归 services/knowledge/（listKnowledgeEntries）。
 */
import { KNOWLEDGE_PROJECT_ID } from '@shuvix/chat-protocol/knowledge'
import { escapesBundle, normalizeBundlePath, titleFromPath } from '@shuvix/agent-runtime'
import { projectDao } from '../dao/projectDao'
import { sessionDao } from '../dao/sessionDao'
import { sessionService } from './sessionService'
import { ensureKnowledgeRoot, getKnowledgeRoot } from './knowledge'
import type { Project, Session } from '../types'

/** 面向用户的功能名（隐藏项目的 name；同旧 wiki 项目的「知识库」，靠 id 区分） */
const KNOWLEDGE_PROJECT_NAME = '知识库'

/**
 * 确保隐藏知识库项目存在并返回（目录本身由 ensureKnowledgeRoot 懒建）。
 * 不发 project.changed —— 该项目对列表不可见。
 */
export function ensureKnowledgeProject(): Project {
  const root = getKnowledgeRoot()
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
 * 查建原子）。`title` 是条目的显示名（frontmatter title），缺省文件名 stem。路径按 bundle 相对
 * 路径归一后查重；空路径或含 `..` 的路径直接拒绝（抛错）。
 */
export async function openKnowledgeNote(relPath: string, title?: string): Promise<Session> {
  const normalized = normalizeBundlePath(relPath)
  // 渲染端只会传清单里的路径；这里仍守一道：空路径 / 越出 bundle 的路径不得绑成笔记本
  if (!normalized || escapesBundle(normalized)) {
    throw new Error(`Invalid knowledge path: ${relPath}`)
  }
  await ensureKnowledgeRoot()
  const project = ensureKnowledgeProject()
  const existing = sessionDao.findByProjectAndNotebookPath(project.id, normalized)
  if (existing) return existing
  return sessionService.create({
    projectId: project.id,
    notebookPath: normalized,
    title: title?.trim() || titleFromPath(normalized)
  })
}
