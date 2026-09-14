/**
 * 会话 → 知识库。`knowledge` 工具除 `bases` 外的每个动作都点名一个 base：
 *
 *   - `project`（KNOWLEDGE_PROJECT_BASE）—— **根会话**所属项目的那一个 bundle。会话不属于任何项目
 *     就没有这个库，回一句可读的话（工具把检索 / 盘点当软条件）；
 *   - 其余字符串 —— `~/.shuvix/knowledge/` 下的同名子目录，即一个用户知识库。**所有会话都看得见
 *     所有用户库**。用户库从不由宿主建出来：建库交给文件系统；点名一个不存在的库直接报错并列出
 *     有哪些 —— 手滑打错的名字不能凭空长出一个库。
 *
 * 保留名优先：目录恰好叫 `project` 的用户库够不着工具，这是一条已知的代价。
 */
import { statSync } from 'fs'
import { KNOWLEDGE_PROJECT_BASE } from '@shuvix/chat-protocol/knowledge'
import type { KnowledgeBaseInfo } from '@shuvix/agent-runtime'
import { projectDao } from '../../dao/projectDao'
import { sessionDao } from '../../dao/sessionDao'
import type { Project } from '../../dao/types/project'
import { ensureProjectBundle, findProjectBundle } from './bundles'
import { bundleDir, isValidLibraryName, userBundleId } from './knowledgePaths'
import { listUserLibraries } from './scan'

export interface SessionBundleTarget {
  /** bundle id（`projects/<projectId>` / `knowledge/<库名>`） */
  bundle: string
  /** bundle 根的绝对路径 */
  dir: string
  /** 人读标签 */
  label: string
}

const NO_PROJECT =
  'This session does not belong to a project, so it has no "project" knowledge base — name one of the user\'s knowledge bases instead (call "bases" to list them).'

function rootProject(rootSessionId: string): Project | undefined {
  const picked = sessionDao.pick(rootSessionId, ['projectId'])
  return picked?.projectId ? projectDao.findById(picked.projectId) : undefined
}

/** 本会话所属项目的库；`create` 为真时尚不存在的 bundle 由宿主建出 */
export async function sessionBundle(
  rootSessionId: string,
  opts: { create: boolean }
): Promise<SessionBundleTarget | { error: string }> {
  const project = rootProject(rootSessionId)
  if (!project) return { error: NO_PROJECT }

  const bundle = opts.create
    ? await ensureProjectBundle(project)
    : await findProjectBundle(project.id)
  if (!bundle) return { error: `Project "${project.name}" has no knowledge entries yet.` }
  return { bundle, dir: bundleDir(bundle), label: `project "${project.name}"` }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 解析工具参数里的 base */
export async function resolveBase(
  rootSessionId: string,
  base: string,
  opts: { create: boolean }
): Promise<SessionBundleTarget | { error: string }> {
  const name = base.trim()
  if (name === KNOWLEDGE_PROJECT_BASE) return sessionBundle(rootSessionId, opts)
  if (isValidLibraryName(name)) {
    const bundle = userBundleId(name)
    const dir = bundleDir(bundle)
    if (isDirectory(dir)) return { bundle, dir, label: `knowledge base "${name}"` }
  }
  const known = [KNOWLEDGE_PROJECT_BASE, ...listUserLibraries()].map((n) => `"${n}"`).join(', ')
  return { error: `No knowledge base named "${name}". Available: ${known}.` }
}

/** 本会话可点名的全部库：`project` 在前，其后每个用户库 */
export async function listBases(rootSessionId: string): Promise<KnowledgeBaseInfo[]> {
  const project = rootProject(rootSessionId)
  const out: KnowledgeBaseInfo[] = []
  if (!project) {
    out.push({
      base: KNOWLEDGE_PROJECT_BASE,
      label: 'this project',
      note: 'this session does not belong to a project'
    })
  } else {
    const bundle = await findProjectBundle(project.id)
    out.push(
      bundle
        ? {
            base: KNOWLEDGE_PROJECT_BASE,
            label: `project "${project.name}"`,
            dir: bundleDir(bundle)
          }
        : {
            base: KNOWLEDGE_PROJECT_BASE,
            label: `project "${project.name}"`,
            note: 'empty — the first "create" makes it'
          }
    )
  }
  for (const name of listUserLibraries()) {
    out.push({ base: name, label: `knowledge base "${name}"`, dir: bundleDir(userBundleId(name)) })
  }
  return out
}
