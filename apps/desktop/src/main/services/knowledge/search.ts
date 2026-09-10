/**
 * 知识库检索 —— okf-minisearch（MiniSearch 之上的 OKF 专用索引：title / description / tags /
 * type / 正文分节，BM25+，模糊与前缀）。索引在内存里按需建、变更后整体失效重建 ——
 * 库的规模不值得增量维护。保留文件不进索引，deprecated 不出现在结果里。
 */
import { createOkfSearch, type OkfSearch } from 'okf-minisearch'
import {
  isReservedFile,
  type KnowledgeConcept,
  type KnowledgeSearchHit
} from '@shuvix/agent-runtime'
import { createLogger } from '../../logger'
import { scanKnowledge } from './scan'

const log = createLogger('Knowledge')

interface Built {
  index: OkfSearch
  concepts: Map<string, KnowledgeConcept>
}

let built: Built | null = null

export function invalidateKnowledgeSearch(): void {
  built = null
}

async function getIndex(): Promise<Built> {
  if (built) return built
  const { files, concepts } = await scanKnowledge()
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
  built = { index, concepts: map }
  return built
}

/** 检索；`dir` 限定作用域目录（bundle 相对）。同一文件多个分节命中只保留最高分那条。 */
export async function searchKnowledge(
  query: string,
  opts: { limit: number; dir?: string }
): Promise<KnowledgeSearchHit[]> {
  const { index, concepts } = await getIndex()
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
    if (opts.dir && !path.startsWith(`${opts.dir}/`)) continue
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
