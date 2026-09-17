/**
 * 知识库笔记 —— 侧栏「知识库」分组点行的后端。三个隐藏承载项目，各自的 path 就是 notebookPath
 * 解析的根，都不出现在项目列表（isHiddenProjectId 过滤）：
 *
 *   - KNOWLEDGE_PROJECT_ID         = knowledge-shuvix 根，承载项目库；notebookPath 即条目 id
 *                                    （`projects/<id>/x.md`）—— 与引入用户库之前逐字一致，存量会话照常
 *   - KNOWLEDGE_USER_PROJECT_ID    = 用户根，承载用户库；notebookPath 是条目 id 去掉首段 `knowledge/`
 *   - KNOWLEDGE_BUILTIN_PROJECT_ID = 内置库**当前语言那一版**的目录（`<应用包>/knowledge/shuvix/<lang>`），
 *                                    notebookPath 是库内相对路径。各语言版本同名同路径，所以切换语言后
 *                                    同一条会话读到的就是新语言的那份 —— 承载项目的 path 在下一次打开、
 *                                    或语言切换时（syncKnowledgeBuiltinProject）重新指向。只读：渲染端按
 *                                    承载项目 id 认出来，不给输入框、编辑器只读。
 *
 * 为什么不合成一个承载项目：它的 path 一变，存量会话的 notebookPath 就全部解析到错的地方。
 * 每个条目文件至多一个笔记本会话，重复打开复用已有会话。与注册表 md 的 registryNotes 同一套做法。
 */
import {
  KNOWLEDGE_BUILTIN_PROJECT_ID,
  KNOWLEDGE_PROJECT_ID,
  KNOWLEDGE_USER_PROJECT_ID
} from '@shuvix/chat-protocol/knowledge'
import { normalizeBundlePath, titleFromPath } from '@shuvix/agent-runtime'
import { createLogger } from '../logger'
import { projectDao } from '../dao/projectDao'
import { sessionDao } from '../dao/sessionDao'
import { sessionService } from './sessionService'
import {
  bundleDir,
  entryFilePath,
  listBuiltinBundles,
  getShuvixKnowledgeRoot,
  getUserKnowledgeRoot,
  isBuiltinBundle,
  isUserBundle,
  locateBundle,
  USER_CONTAINER
} from './knowledge'
import type { Project, Session } from '../types'

const log = createLogger('KnowledgeNotes')

/** 面向用户的功能名（隐藏项目的 name；三个承载项目靠 id 区分） */
const KNOWLEDGE_PROJECT_NAME = '知识库'
const KNOWLEDGE_USER_PROJECT_NAME = '用户知识库'
const KNOWLEDGE_BUILTIN_PROJECT_NAME = 'ShuviX 系统说明'

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

/** 内置库的承载项目：path 是该库当前语言那一版的目录（一个内置库一个承载项目；本期只有 `builtin/shuvix`） */
function ensureKnowledgeBuiltinProject(bundle: string): Project {
  return ensureCarrier(
    KNOWLEDGE_BUILTIN_PROJECT_ID,
    KNOWLEDGE_BUILTIN_PROJECT_NAME,
    bundleDir(bundle)
  )
}

/**
 * 界面语言切换后把内置库承载项目的 path 指向新语言那一版 —— 只在它已经存在时（从没打开过内置条目就
 * 没有这个项目，不必凭空建）。开着的笔记本会话下一次读文件就落到新目录：notebookPath 在各语言里同名。
 *
 * **一个承载项目只服务一个内置库**：它的 id 是常量，path 只能指向一个目录。今天内置库恰好一个；真出现
 * 第二个时，按名字重指会让先开的那些会话解析到别人的目录里（而且两边文件名多半不同，表现是「打开即空」
 * 而不是报错）—— 那一步得连承载项目 id 一起带上库名。所以这里遇到不止一个就什么都不做并记一笔，
 * 而不是让「最后一个赢」悄悄发生。
 */
export function syncKnowledgeBuiltinProject(): void {
  if (!projectDao.findById(KNOWLEDGE_BUILTIN_PROJECT_ID)) return
  const bundles = listBuiltinBundles()
  // 一个都没有：没什么可指的（资源没发到位 / 这个库只发了别的语言），承载项目留在原处，不必说什么
  if (bundles.length === 0) return
  if (bundles.length > 1) {
    log.warn(
      `builtin knowledge carrier left as is: one carrier serves one base, found ${bundles.length}`
    )
    return
  }
  ensureKnowledgeBuiltinProject(bundles[0])
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
  const builtin = isBuiltinBundle(located.bundle)
  const project = builtin
    ? ensureKnowledgeBuiltinProject(located.bundle)
    : user
      ? ensureKnowledgeUserProject()
      : ensureKnowledgeProject()
  const notebookPath = builtin
    ? located.rel
    : user
      ? entryId.slice(USER_CONTAINER.length + 1)
      : entryId
  const existing = sessionDao.findByProjectAndNotebookPath(project.id, notebookPath)
  if (existing) return existing
  return sessionService.create({
    projectId: project.id,
    notebookPath,
    title: title?.trim() || titleFromPath(normalized)
  })
}
