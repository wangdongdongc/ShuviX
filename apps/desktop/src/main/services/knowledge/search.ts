/**
 * 知识库检索 —— okf-minisearch（MiniSearch 之上的 OKF 专用索引：title / description / tags /
 * type / 正文分节，BM25+，模糊与前缀）。**一个 bundle 一个索引**：检索面就是一个 bundle，
 * 跨 bundle 的检索不是同一件事（那是「在哪个库里找」，本期没有这个入口）。
 *
 * 索引在内存里按需建、变更后整体失效重建 —— 单个库的规模不值得增量维护。
 * **读宽**：每条笔记都进索引，没有 frontmatter 的用户笔记走 okf-minisearch 的 degraded 模式；ShuviX 早先生成的
 * index / log 不进。deprecated 在结果侧过滤 —— okf-minisearch 的 status 过滤器会把没有 status 的
 * 普通笔记一并刷掉，所以不用它。
 *
 * **中文要先分词。** MiniSearch 默认只按空白与标点切词，中文句子里没有空格，于是两个标点之间
 * 的一整段成了**一个词**：「令牌」「刷新」这类段中间的词永远搜不到，双字词连在段首也够不着
 * okf-minisearch 的前缀门槛（≥ 3 字）。而 okf-minisearch 在内部自己 `new MiniSearch`、不暴露
 * `tokenize`，所以这里在**交给索引之前**预分词：用 `Intl.Segmenter`（Electron 自带 ICU，零依赖）
 * 在相邻的中日文词之间插一个 U+200A（hair space）。它属于 `\p{Zs}`，默认分词器本来就按它切 ——
 * 索引端与查询端做同一个变换，两边的词才对得上；片段出去时剥掉它，文件本身不受影响。
 *
 * 为什么不 patch okf-minisearch：仓库没有 patch-package，根 `postinstall` 在 CI 里是跳过的，
 * 而 okf-minisearch 是内联进主进程产物的 —— 补丁得在 CI 里生效，还会在下次升级时静默失效。
 * U+200A 不加换行，所以分节的起止行号不变。
 */
import { createOkfSearch, type OkfSearch } from 'okf-minisearch'
import type { KnowledgeNote, KnowledgeSearchHit } from '@shuvix/agent-runtime'
import { createLogger } from '../../logger'
import { scanBundle } from './scan'

const log = createLogger('Knowledge')

/** 词界标记：`\p{Zs}`，默认分词器会按它切；真实文本里几乎不出现，剥掉是无损的 */
const WORD_BREAK = '\u200A'
const WORD_BREAK_RE = /\u200A/g
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

/** 在相邻的两个词之间插词界标记 —— 仅当其中至少一个是中日文；其余文本原样透传 */
function segmentCjk(text: string): string {
  if (!CJK_RE.test(text)) return text
  let out = ''
  let prevWord = false
  let prevCjk = false
  for (const s of segmenter.segment(text)) {
    const cjk = CJK_RE.test(s.segment)
    if (s.isWordLike && prevWord && (cjk || prevCjk)) out += WORD_BREAK
    out += s.segment
    prevWord = s.isWordLike === true
    prevCjk = cjk
  }
  return out
}

interface Built {
  index: OkfSearch
  notes: Map<string, KnowledgeNote>
}

const built = new Map<string, Built>()

export function invalidateKnowledgeSearch(bundle?: string): void {
  if (bundle === undefined) built.clear()
  else built.delete(bundle)
}

async function getIndex(bundle: string): Promise<Built> {
  const hit = built.get(bundle)
  if (hit) return hit
  const { files, notes } = await scanBundle(bundle)
  const map = new Map(notes.map((n) => [n.path, n]))
  const index = createOkfSearch(
    files
      .filter((f) => map.has(f.path))
      .map((f) => ({ path: f.path, markdown: segmentCjk(f.text) }))
  )
  const degraded = index.listDegradedDocuments()
  if (degraded.length > 0) {
    log.info(
      `knowledge search: ${degraded.length} note(s) without OKF metadata indexed in degraded mode`
    )
  }
  const entry = { index, notes: map }
  built.set(bundle, entry)
  return entry
}

/** 在一个 bundle 里检索。同一文件多个分节命中只保留最高分那条。 */
export async function searchBundle(
  bundle: string,
  query: string,
  opts: { limit: number }
): Promise<KnowledgeSearchHit[]> {
  const { index, notes } = await getIndex(bundle)
  const hits = index.search(segmentCjk(query), {
    limit: Math.max(opts.limit * 4, 40),
    fuzzy: 0.2
  })
  const seen = new Set<string>()
  const out: KnowledgeSearchHit[] = []
  for (const hit of hits) {
    const path = hit.path.replace(/^\/+/, '')
    if (seen.has(path)) continue
    const note = notes.get(path)
    if (!note || note.status === 'deprecated') continue
    seen.add(path)
    out.push({
      path,
      title: note.title,
      description: note.description,
      status: note.status,
      snippet: hit.snippet?.replace(WORD_BREAK_RE, '')
    })
    if (out.length >= opts.limit) break
  }
  return out
}
