/**
 * 侧栏 / 管理页的条目清单 —— 扫描全部 bundle（项目库 + 用户库），每个 md 投影成一行
 * chat-protocol 的 KnowledgeEntry（不含正文）。`path` 与 `bundle` 用两个根共用的名字空间
 * （`projects/<id>/…` / `knowledge/<库名>/…`），所以跨 bundle、跨根都唯一。
 *
 * 这里**不建任何东西**：清单是只读的。
 *
 * **读宽**：库里每个 md 都有一行。合规的 OKF 条目带信任 / 核实 / 过期标注；没有 frontmatter、没有
 * `type`、带别家标记的用户笔记照常列出、点开即开，标题依次取 frontmatter title、正文第一个 `#`
 * 标题、文件名。ShuviX 早先生成的 index.md / log.md 不列 —— 用户自己写的同名笔记照常列出。
 *
 * 项目库的**显示名**随清单一起下发：目录名是项目 id，按 id 查项目**当前**的名字 —— 改名即时生效，
 * 不靠任何写在库里的文件。项目已删就查不到，侧栏回落目录名。
 */
import type { KnowledgeEntry } from '@shuvix/chat-protocol/knowledge'
import { toKnowledgeEntryFromNote } from '@shuvix/agent-runtime'
import { projectDao } from '../../dao/projectDao'
import { PROJECTS_CONTAINER, getShuvixKnowledgeRoot, getUserKnowledgeRoot } from './knowledgePaths'
import { scanAllBundles } from './scan'

/** 项目库 bundle id → 项目当前的名字（查不到的不给） */
function projectBundleNames(bundles: readonly string[]): Record<string, string> {
  const names: Record<string, string> = {}
  for (const bundle of bundles) {
    const [container, id] = bundle.split('/')
    if (container !== PROJECTS_CONTAINER || !id) continue
    const name = projectDao.findById(id)?.name?.trim()
    if (name) names[bundle] = name
  }
  return names
}

/** 清单 + 两个根（条目 id 的首段决定相对哪个根：`knowledge/…` 相对用户根，其余相对 knowledge-shuvix） */
export async function listKnowledgeEntries(): Promise<{
  entries: KnowledgeEntry[]
  root: string
  userRoot: string
  /** bundle id → 显示名（项目库：项目当前的名字） */
  bundleNames: Record<string, string>
}> {
  const scans = await scanAllBundles()
  const now = new Date()
  const entries = scans.flatMap((scan) =>
    scan.notes.map((note) => toKnowledgeEntryFromNote(note, { bundle: scan.bundle, now }))
  )
  return {
    root: getShuvixKnowledgeRoot(),
    userRoot: getUserKnowledgeRoot(),
    entries,
    bundleNames: projectBundleNames(scans.map((scan) => scan.bundle))
  }
}
