/**
 * 会话 → 知识库。`knowledge` 工具除 `bases` 外的每个动作都点名一个 base：
 *
 *   - `project`（KNOWLEDGE_PROJECT_BASE）—— **根会话**所属项目的库，就是
 *     `knowledge-shuvix/projects/<项目 id>/` 这个目录。不判断它建没建过（读宽）：没写过的库读起来是空的，
 *     第一次 create 写进去目录就有了，git 仓库由变更管线在第一次提交前建出。会话不属于任何项目就没有
 *     这个库，回一句可读的话（工具把检索 / 盘点当软条件）；
 *   - 其余字符串 —— `~/.shuvix/knowledge/` 下的同名子目录，即一个用户知识库。**所有会话都看得见
 *     所有用户库**。用户库从不由宿主建出来：建库交给文件系统；点名一个不存在的库直接报错并列出
 *     有哪些 —— 手滑打错的名字不能凭空长出一个库。
 *
 * 库名按**目录清单**精确匹配（与侧栏、扫描同一份清单），不拿拼出来的路径去 stat：大小写不敏感的
 * 文件系统上 `Notes` 能 stat 到 `notes/`，id 却成了 `knowledge/Notes`，缓存键与侧栏就此分叉；
 * 指向目录的符号链接同理 —— 清单不认，这里也不认。比较前两边都归一成 NFC。
 *
 * 保留名优先：目录恰好叫 `project` 的用户库够不着工具，也不出现在 `bases` 与报错的候选里。
 */
import { KNOWLEDGE_PROJECT_BASE } from '@shuvix/chat-protocol/knowledge'
import type { KnowledgeBaseInfo } from '@shuvix/agent-runtime'
import { projectDao } from '../../dao/projectDao'
import { sessionDao } from '../../dao/sessionDao'
import type { Project } from '../../dao/types/project'
import { bundleDir, projectBundleId, userBundleId } from './knowledgePaths'
import { listUserLibraries } from './scan'

export interface SessionBundleTarget {
  /** bundle id（`projects/<projectId>` / `knowledge/<库名>`） */
  bundle: string
  /** bundle 根的绝对路径（项目库的目录可能还不存在） */
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

/** 本会话所属项目的库（目录可能还不存在 —— 那就是一个空库） */
export function sessionBundle(rootSessionId: string): SessionBundleTarget | { error: string } {
  const project = rootProject(rootSessionId)
  if (!project) return { error: NO_PROJECT }
  const bundle = projectBundleId(project.id)
  return { bundle, dir: bundleDir(bundle), label: `project "${project.name}"` }
}

/** 工具可点名的用户库名（保留名 `project` 的同名目录除外） */
function userBaseNames(): string[] {
  return listUserLibraries().filter((name) => name !== KNOWLEDGE_PROJECT_BASE)
}

/** 解析工具参数里的 base */
export async function resolveBase(
  rootSessionId: string,
  base: string
): Promise<SessionBundleTarget | { error: string }> {
  const name = base.trim()
  if (name === KNOWLEDGE_PROJECT_BASE) return sessionBundle(rootSessionId)
  const names = userBaseNames()
  const wanted = name.normalize('NFC')
  const match = names.find((n) => n.normalize('NFC') === wanted)
  if (match) {
    const bundle = userBundleId(match)
    return { bundle, dir: bundleDir(bundle), label: `knowledge base "${match}"` }
  }
  const known = [KNOWLEDGE_PROJECT_BASE, ...names].map((n) => `"${n}"`).join(', ')
  return { error: `No knowledge base named "${name}". Available: ${known}.` }
}

/** 本会话可点名的全部库：`project` 在前，其后每个用户库 */
export async function listBases(rootSessionId: string): Promise<KnowledgeBaseInfo[]> {
  const project = rootProject(rootSessionId)
  const out: KnowledgeBaseInfo[] = [
    project
      ? {
          base: KNOWLEDGE_PROJECT_BASE,
          label: `project "${project.name}"`,
          dir: bundleDir(projectBundleId(project.id))
        }
      : {
          base: KNOWLEDGE_PROJECT_BASE,
          label: 'this project',
          note: 'this session does not belong to a project'
        }
  ]
  for (const name of userBaseNames()) {
    out.push({ base: name, label: `knowledge base "${name}"`, dir: bundleDir(userBundleId(name)) })
  }
  return out
}
