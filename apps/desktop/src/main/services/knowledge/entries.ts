/**
 * 侧栏 / 管理页的条目清单 —— 扫描全部 bundle，投影成 chat-protocol 的 KnowledgeEntry
 * （不含正文）。`path` 与 `bundle` 都相对 shuvix 根，所以跨 bundle 唯一。
 *
 * 这里**不建任何东西**：清单是只读的，bundle 由写入（或项目首次用到知识库）时才建出来。
 *
 * 一处**视图覆盖**：绑定概念（`project.md`）的 title 换成项目的**当前**名字。目录名是项目 id，
 * 文件里的 title 是建库那一刻记下的名字 —— 项目改名之后它就旧了，而侧栏显示的应当是用户此刻
 * 认得的那个名字。不回写文件：那是每次改名都往用户的 git 历史里塞一条提交，为的只是一行显示。
 * 文件里那份留作**可携带**的记录（外部 OKF 读者看到的就是它）。
 */
import type { KnowledgeEntry } from '@shuvix/chat-protocol/knowledge'
import { PROJECT_CONCEPT_FILE, projectResource } from '@shuvix/chat-protocol/knowledge'
import { toKnowledgeEntry } from '@shuvix/agent-runtime'
import { projectDao } from '../../dao/projectDao'
import { getShuvixKnowledgeRoot } from './knowledgePaths'
import { scanAllBundles } from './scan'

/** `shuvix://project/<id>` → 项目当前名字；解析不出 / 项目已删返回 null */
function boundProjectName(resource: string | undefined): string | null {
  if (!resource) return null
  const id = resource.startsWith(projectResource(''))
    ? resource.slice(projectResource('').length)
    : ''
  if (!id) return null
  return projectDao.findById(id)?.name?.trim() || null
}

export async function listKnowledgeEntries(): Promise<{
  entries: KnowledgeEntry[]
  root: string
}> {
  const scans = await scanAllBundles()
  const now = new Date()
  const entries = scans.flatMap((scan) =>
    scan.concepts.map((c) => {
      const entry = toKnowledgeEntry(c, { bundle: scan.bundle, now })
      if (c.path !== PROJECT_CONCEPT_FILE) return entry
      const live = boundProjectName(c.resource)
      return live ? { ...entry, title: live } : entry
    })
  )
  return { root: getShuvixKnowledgeRoot(), entries }
}
