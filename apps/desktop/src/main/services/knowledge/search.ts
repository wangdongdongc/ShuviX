/**
 * 知识库检索 —— okf-minisearch（MiniSearch 之上的 OKF 专用索引：title / description / tags /
 * type / 正文分节，BM25+，模糊与前缀）。**一个 bundle 一个索引**：检索面就是一个 bundle，
 * 跨 bundle 的检索不是同一件事（那是「在哪个库里找」，本期没有这个入口）。
 *
 * 索引在内存里按需建、变更后整体失效重建 —— 单个库的规模不值得增量维护。
 * 保留文件不进索引，deprecated 不出现在结果里。
 */
import { createOkfSearch, type OkfSearch } from 'okf-minisearch'
import {
  isReservedFile,
  type KnowledgeConcept,
  type KnowledgeSearchHit
} from '@shuvix/agent-runtime'
import { createLogger } from '../../logger'
import { scanBundle } from './scan'

const log = createLogger('Knowledge')

interface Built {
  index: OkfSearch
  concepts: Map<string, KnowledgeConcept>
}

const built = new Map<string, Built>()

export function invalidateKnowledgeSearch(bundle?: string): void {
  if (bundle === undefined) built.clear()
  else built.delete(bundle)
}

async function getIndex(bundle: string): Promise<Built> {
  const hit = built.get(bundle)
  if (hit) return hit
  const { files, concepts } = await scanBundle(bundle)
  const map = new Map(concepts.map((c) => [c.path, c]))
  const index = createOkfSearch(
    files
      .filter((f) => !isReservedFile(f.path) && map.has(f.path))
      .map((f) => ({ path: f.path, markdown: f.text }))
  )
  const degraded = index.listDegradedDocuments()
  if (degraded.length > 0) {
    log.warn(`knowledge search: ${degraded.length} document(s) indexed in degraded mode`)
  }
  const entry = { index, concepts: map }
  built.set(bundle, entry)
  return entry
}

/** 在一个 bundle 里检索。同一文件多个分节命中只保留最高分那条。 */
export async function searchBundle(
  bundle: string,
  query: string,
  opts: { limit: number }
): Promise<KnowledgeSearchHit[]> {
  const { index, concepts } = await getIndex(bundle)
  const hits = index.search(query, {
    limit: Math.max(opts.limit * 4, 40),
    where: { statuses: ['draft', 'stable'] },
    fuzzy: 0.2
  })
  const seen = new Set<string>()
  const out: KnowledgeSearchHit[] = []
  for (const hit of hits) {
    const path = hit.path.replace(/^\/+/, '')
    if (seen.has(path)) continue
    const concept = concepts.get(path)
    if (!concept || concept.status === 'deprecated') continue
    seen.add(path)
    out.push({
      path,
      title: concept.title,
      description: concept.description,
      status: concept.status,
      snippet: hit.snippet
    })
    if (out.length >= opts.limit) break
  }
  return out
}
