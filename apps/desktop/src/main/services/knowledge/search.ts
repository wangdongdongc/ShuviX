/**
 * 知识库检索 —— okf-minisearch（MiniSearch 之上的 OKF 专用索引：title / description / tags /
 * type / 来源 / 正文分节，BM25+，模糊与前缀）。**一个 bundle 一个索引**：检索面就是一个 bundle，
 * 跨 bundle 的检索不是同一件事（那是「在哪个库里找」，本期没有这个入口）。
 *
 * 索引在内存里按需建、变更后整体失效重建 —— 单个库的规模不值得增量维护。
 *
 * **读宽：每条笔记都进索引，可 okf-minisearch 只收 OKF 概念。** 它遇到一份不合格的文档不是降级，而是
 * 整批抛错（没有 frontmatter、没有 `type`、文件名是 index.md / log.md，连开头多一个 BOM 的合规条目
 * 都算），所以这里逐篇 `ingest`，逐级退让：
 *   1. 合规条目给规整过的原文（去 BOM 与前导空白、闭合线不带尾随空白 —— 字段一个不丢）；
 *   2. 进不去、或者本来就不是条目的，用笔记读出的字段重建 frontmatter，正文照原样。普通笔记的 `type`
 *      用 `·` 占位：type 也是检索字段，写个真词会让所有普通笔记都命中它，而 `·` 切不出词；
 *   3. 仍然进不去的跳过并记一笔 —— 一篇笔记绝不能拖垮整个库的检索。
 * 保留名下用户手写的笔记换个隐藏的文件名入索引（`sub/index.md` → `sub/.index.md`）：扫描从不收隐藏
 * 文件，别名撞不上真实的笔记，结果再按别名表换回真实路径。ShuviX 早先生成的 index / log 不是笔记，
 * 本来就不进。deprecated 在结果侧过滤 —— okf-minisearch 的 status 过滤器会把没有 status 的文档一并
 * 刷掉，所以不用它。
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
 */
import { createOkfSearch, type OkfSearch } from 'okf-minisearch'
import {
  buildOkfConceptDocument,
  isReservedFile,
  splitFrontmatter,
  type KnowledgeNote,
  type KnowledgeSearchHit
} from '@shuvix/agent-runtime'
import { createLogger } from '../../logger'
import { scanBundle } from './scan'

const log = createLogger('Knowledge')

/** 词界标记：`\p{Zs}`，默认分词器会按它切；真实文本里几乎不出现，剥掉是无损的 */
const WORD_BREAK = '\u200A'
const WORD_BREAK_RE = /\u200A/g
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

/** 普通笔记入索引时的 `type` 占位：标点，切不出词（见文件头） */
const PLAIN_NOTE_TYPE = '·'

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

/** 入索引用的路径：保留名换成同目录下的隐藏文件名（okf-minisearch 拒收 index.md / log.md） */
function indexPathOf(rel: string): string {
  if (!isReservedFile(rel)) return rel
  const cut = rel.lastIndexOf('/') + 1
  return `${rel.slice(0, cut)}.${rel.slice(cut)}`
}

/** 一条笔记依次尝试入索引的文本（见文件头的逐级退让） */
function candidatesOf(note: KnowledgeNote, text: string): string[] {
  const split = splitFrontmatter(text)
  const rebuilt = buildOkfConceptDocument(
    {
      type: note.type || PLAIN_NOTE_TYPE,
      title: note.title,
      description: note.description || undefined,
      tags: note.tags.length > 0 ? note.tags : undefined,
      status: note.status
    },
    split ? split.body : text.replace(/^\uFEFF/, '')
  )
  return note.concept && split ? [`---\n${split.yaml}---\n${split.body}`, rebuilt] : [rebuilt]
}

interface Built {
  index: OkfSearch
  /** 入索引用的路径（保留名是别名）→ 笔记 */
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
  const textOf = new Map(files.map((f) => [f.path, f.text]))
  const index = createOkfSearch([])
  const byPath = new Map<string, KnowledgeNote>()
  const skipped: string[] = []
  for (const note of notes) {
    const path = indexPathOf(note.path)
    const ingested = candidatesOf(note, textOf.get(note.path) ?? '').some((markdown) => {
      try {
        index.ingest({ path, markdown: segmentCjk(markdown) })
        return true
      } catch {
        return false
      }
    })
    if (ingested) byPath.set(path, note)
    else skipped.push(note.path)
  }
  if (skipped.length > 0) {
    log.warn(`knowledge search: left out of ${bundle}: ${skipped.join(', ')}`)
  }
  const entry = { index, notes: byPath }
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
    const note = notes.get(hit.path.replace(/^\/+/, ''))
    if (!note || note.status === 'deprecated' || seen.has(note.path)) continue
    seen.add(note.path)
    out.push({
      path: note.path,
      title: note.title,
      description: note.description,
      status: note.status,
      snippet: hit.snippet?.replace(WORD_BREAK_RE, '')
    })
    if (out.length >= opts.limit) break
  }
  return out
}
