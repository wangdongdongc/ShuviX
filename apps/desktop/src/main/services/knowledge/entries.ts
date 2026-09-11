/**
 * 侧栏 / 管理页的条目清单 —— 扫描全部 bundle，投影成 chat-protocol 的 KnowledgeEntry
 * （不含正文）。`path` 与 `bundle` 都相对 shuvix 根，所以跨 bundle 唯一。
 *
 * 这里**不建任何东西**：清单是只读的，bundle 由写入（或项目首次用到知识库）时才建出来。
 */
import type { KnowledgeEntry } from '@shuvix/chat-protocol/knowledge'
import { toKnowledgeEntry } from '@shuvix/agent-runtime'
import { getShuvixKnowledgeRoot } from './knowledgePaths'
import { scanAllBundles } from './scan'

export async function listKnowledgeEntries(): Promise<{
  entries: KnowledgeEntry[]
  root: string
}> {
  const scans = await scanAllBundles()
  const now = new Date()
  const entries = scans.flatMap((scan) =>
    scan.concepts.map((c) => toKnowledgeEntry(c, { bundle: scan.bundle, now }))
  )
  return { root: getShuvixKnowledgeRoot(), entries }
}
