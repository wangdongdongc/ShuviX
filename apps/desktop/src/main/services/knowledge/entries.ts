/**
 * 侧栏 / 管理页的条目清单 —— 扫描全部 bundle（项目库 + 用户库），投影成 chat-protocol 的
 * KnowledgeEntry（不含正文）。`path` 与 `bundle` 用两个根共用的名字空间（`projects/<id>/…` /
 * `knowledge/<库名>/…`），所以跨 bundle、跨根都唯一。
 *
 * 这里**不建任何东西**：清单是只读的，bundle 由写入（或项目首次用到知识库）时才建出来。
 *
 * 一处**视图覆盖**：绑定概念（`project.md`）的 title 换成项目的**当前**名字。目录名是项目 id，
 * 文件里的 title 是建库那一刻记下的名字 —— 项目改名之后它就旧了，而侧栏显示的应当是用户此刻
 * 认得的那个名字。不回写文件：那是每次改名都往用户的 git 历史里塞一条提交，为的只是一行显示。
 *
 * **不合规的 md 照常列出**：没有 frontmatter、或 frontmatter 里没有 `type` 的文件按 OKF 不算合规
 * 条目，但用户库多半是从别处拷进来的笔记，藏起来会让用户以为文件丢了。它们照常一行、点开即开，
 * 不做任何特殊标注。保留文件（index.md / log.md）仍不列 —— 那是宿主的投影，不是笔记。
 */
import type { KnowledgeEntry } from '@shuvix/chat-protocol/knowledge'
import { PROJECT_CONCEPT_FILE, projectResource } from '@shuvix/chat-protocol/knowledge'
import { isReservedFile, titleFromPath, toKnowledgeEntry } from '@shuvix/agent-runtime'
import { projectDao } from '../../dao/projectDao'
import { getShuvixKnowledgeRoot, getUserKnowledgeRoot } from './knowledgePaths'
import { scanAllBundles } from './scan'

/** `shuvix://project/<id>` → 项目当前名字；解析不出 / 项目已删返回 null */
function boundProjectName(resource: string | undefined): string | null {
  if (!resource) return null
  const prefix = projectResource('')
  const id = resource.startsWith(prefix) ? resource.slice(prefix.length) : ''
  if (!id) return null
  return projectDao.findById(id)?.name?.trim() || null
}

/** 不合规 md 的一行：没有可读的元数据，按文件名显示、按合规条目的缺省值填充 */
function plainEntry(bundle: string, rel: string): KnowledgeEntry {
  return {
    path: `${bundle}/${rel}`,
    bundle,
    type: '',
    title: titleFromPath(rel),
    description: '',
    status: 'stable',
    tags: [],
    trustTier: 'unverified',
    verifiedCurrent: false,
    stale: false
  }
}

/** 清单 + 两个根（条目 id 的首段决定相对哪个根：`knowledge/…` 相对用户根，其余相对 knowledge-shuvix） */
export async function listKnowledgeEntries(): Promise<{
  entries: KnowledgeEntry[]
  root: string
  userRoot: string
}> {
  const scans = await scanAllBundles()
  const now = new Date()
  const entries = scans.flatMap((scan) => {
    const conceptPaths = new Set(scan.concepts.map((c) => c.path))
    const fromConcepts = scan.concepts.map((c) => {
      const entry = toKnowledgeEntry(c, { bundle: scan.bundle, now })
      if (c.path !== PROJECT_CONCEPT_FILE) return entry
      const live = boundProjectName(c.resource)
      return live ? { ...entry, title: live } : entry
    })
    const plain = scan.files
      .filter((f) => !isReservedFile(f.path) && !conceptPaths.has(f.path))
      .map((f) => plainEntry(scan.bundle, f.path))
    return [...fromConcepts, ...plain]
  })
  return { root: getShuvixKnowledgeRoot(), userRoot: getUserKnowledgeRoot(), entries }
}
