/**
 * 会话 → 目标 bundle。本期只有一条规则：**根会话所属项目的那一个 bundle**。
 * 会话不属于任何项目就没有目标 —— 回一句可读的话，不抛错（工具把它当软条件）。
 */
import { projectDao } from '../../dao/projectDao'
import { sessionDao } from '../../dao/sessionDao'
import { ensureProjectBundle, findProjectBundle } from './bundles'
import { bundleDir } from './knowledgePaths'

export interface SessionBundleTarget {
  /** bundle id（shuvix 根相对，如 `projects/acme`） */
  bundle: string
  /** bundle 根的绝对路径 */
  dir: string
  /** 人读标签 */
  label: string
}

const NO_PROJECT =
  'This session does not belong to a project, and the knowledge base is per project — open the session inside a project first.'

/** 本会话的目标 bundle；`create` 为真时尚不存在的 bundle 由宿主建出 */
export async function sessionBundle(
  rootSessionId: string,
  opts: { create: boolean }
): Promise<SessionBundleTarget | { error: string }> {
  const picked = sessionDao.pick(rootSessionId, ['projectId'])
  const project = picked?.projectId ? projectDao.findById(picked.projectId) : undefined
  if (!project) return { error: NO_PROJECT }

  const bundle = opts.create
    ? await ensureProjectBundle(project)
    : await findProjectBundle(project.id)
  if (!bundle) return { error: `Project "${project.name}" has no knowledge entries yet.` }
  return { bundle, dir: bundleDir(bundle), label: `project "${project.name}"` }
}
