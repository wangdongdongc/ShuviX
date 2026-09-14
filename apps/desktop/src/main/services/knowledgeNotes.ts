/**
 * 知识库笔记 —— 侧栏「知识库」分组点行的后端。两个隐藏承载项目，各自的 path 就是 notebookPath
 * 解析的根，都不出现在项目列表（isHiddenProjectId 过滤）：
 *
 *   - KNOWLEDGE_PROJECT_ID      = knowledge-shuvix 根，承载项目库；notebookPath 即条目 id
 *                                 （`projects/<id>/x.md`）—— 与引入用户库之前逐字一致，存量会话照常
 *   - KNOWLEDGE_USER_PROJECT_ID = 用户根，承载用户库；notebookPath 是条目 id 去掉首段 `knowledge/`
 *
 * 为什么不合成一个承载项目：它的 path 一变，存量会话的 notebookPath 就全部解析到错的地方。
 * 每个条目文件至多一个笔记本会话，重复打开复用已有会话。与 wikiService 同一套做法。
 */
import { KNOWLEDGE_PROJECT_ID, KNOWLEDGE_USER_PROJECT_ID } from '@shuvix/chat-protocol/knowledge'
import { normalizeBundlePath, titleFromPath } from '@shuvix/agent-runtime'
import { projectDao } from '../dao/projectDao'
import { sessionDao } from '../dao/sessionDao'
import { sessionService } from './sessionService'
import {
  entryFilePath,
  getShuvixKnowledgeRoot,
  getUserKnowledgeRoot,
  isUserBundle,
  locateBundle,
  USER_CONTAINER
} from './knowledge'
import type { Project, Session } from '../types'

/** 面向用户的功能名（隐藏项目的 name；同旧 wiki 项目的「知识库」，靠 id 区分） */
const KNOWLEDGE_PROJECT_NAME = '知识库'
const KNOWLEDGE_USER_PROJECT_NAME = '用户知识库'

/** 确保一个隐藏承载项目存在并返回（目录不在这里建）；历史行的 path / name 漂移自愈 */
function ensureCarrier(id: string, name: string, root: string): Project {
  const existing = projectDao.findById(id)
  if (existing) {
    const patch: Partial<Pick<Project, 'name' | 'path'>> = {}
    if (existing.path !== root) patch.path = root
    if (existing.name !== name) patch.name = name
    if (Object.keys(patch).length > 0) {
      projectDao.update(id, patch)
      return { ...existing, ...patch }
    }
    return existing
  }
  const now = Date.now()
  const project: Project = {
    id,
    name,
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

/** 项目库的承载项目（不发 project.changed —— 该项目对列表不可见） */
export function ensureKnowledgeProject(): Project {
  return ensureCarrier(KNOWLEDGE_PROJECT_ID, KNOWLEDGE_PROJECT_NAME, getShuvixKnowledgeRoot())
}

/** 用户库的承载项目 */
export function ensureKnowledgeUserProject(): Project {
  return ensureCarrier(
    KNOWLEDGE_USER_PROJECT_ID,
    KNOWLEDGE_USER_PROJECT_NAME,
    getUserKnowledgeRoot()
  )
}

/**
 * 打开知识库条目的笔记本：同文件已有笔记本会话则复用，否则创建（main 单线程 + 同步 SQLite，
 * 查建原子）。`relPath` 是条目 id（`projects/<id>/x.md` / `knowledge/<库名>/x.md`），`title` 是
 * 显示名，缺省文件名 stem。落不进任何 bundle 的路径（越界、指到容器或库目录本身）直接拒绝。
 */
export async function openKnowledgeNote(relPath: string, title?: string): Promise<Session> {
  const normalized = normalizeBundlePath(relPath)
  // 渲染端只会传清单里的路径；这里仍守一道：必须解析得出所属 bundle。查重键从解析结果重新拼 ——
  // `..` 在这一步被消解，绕回另一个根的写法（`knowledge/../knowledge-shuvix/…`）也落回规范形
  const located = normalized ? locateBundle(entryFilePath(normalized)) : null
  if (!located) throw new Error(`Invalid knowledge path: ${relPath}`)

  const entryId = `${located.bundle}/${located.rel}`
  const user = isUserBundle(located.bundle)
  const project = user ? ensureKnowledgeUserProject() : ensureKnowledgeProject()
  const notebookPath = user ? entryId.slice(USER_CONTAINER.length + 1) : entryId
  const existing = sessionDao.findByProjectAndNotebookPath(project.id, notebookPath)
  if (existing) return existing
  return sessionService.create({
    projectId: project.id,
    notebookPath,
    title: title?.trim() || titleFromPath(normalized)
  })
}
