/**
 * 知识库检索 —— okf-minisearch（MiniSearch 之上的 OKF 专用索引，BM25+，模糊与前缀）。
 * **一个 bundle 一个索引**：检索面就是一个 bundle，跨 bundle 的检索不是同一件事（那是「在哪个库里
 * 找」，本期没有这个入口）。
 *
 * **索引里只有条目的「门面」：title / description / tags / type + 正文里的标题行。正文散文不进索引。**
 * 这是实际用下来改的（2026-09-17）：全文入索引时，一句常见的话就能把半个库拉回来，而每条命中还带一段
 * 正文片段 —— 结果又多又长，占满上下文，真正相关的那条反而被淹掉。检索因此只回答**第一步**：
 * 「哪几条可能相关」；第二步由 agent 看着标题与描述挑，再用 `read` 取正文。
 * 标题行留着是因为它们是作者自己写的主题标签（短、密度高，不是散文），而用户拷进来的笔记很多根本
 * 没有 description —— 只剩文件名可搜就太少了。
 * **要在正文里找一个字面串，用 `grep`**：库的绝对目录每条检索 / 盘点结果都印着，grep 比全文索引准，
 * 回来的也窄。
 *
 * 索引在内存里按需建、变更后整体失效重建 —— 单个库的规模不值得增量维护。
 *
 * 索引在内存里按需建、变更后整体失效重建 —— 单个库的规模不值得增量维护。
 *
 * **读宽：每条笔记都进索引，可 okf-minisearch 只收 OKF 概念。** 它遇到一份不合格的文档不是降级，而是
 * 整批抛错（没有 frontmatter、没有 `type`、文件名是 index.md / log.md，连开头多一个 BOM 的合规条目
 * 都算），所以每篇都**按笔记读出的字段重建**一份只有门面的文档再 `ingest`（原文一律不进 —— 它带着正文）：
 * 重建出来的恒合规，普通笔记的 `type` 用 `·` 占位（type 也是检索字段，写个真词会让所有普通笔记都命中它，
 * 而 `·` 切不出词）。万一仍然进不去就跳过并记一笔 —— 一篇笔记绝不能拖垮整个库的检索。
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
 * 索引端与查询端做同一个变换，两边的词才对得上；标记只活在喂给索引的那份文本里，文件本身不受影响
 * （结果里也不会带上它 —— 回包的标题与描述取自笔记本身，不是索引）。
 *
 * 为什么不 patch okf-minisearch：仓库没有 patch-package，根 `postinstall` 在 CI 里是跳过的，
 * 而 okf-minisearch 是内联进主进程产物的 —— 补丁得在 CI 里生效，还会在下次升级时静默失效。
 */
import { createOkfSearch, type OkfSearch } from 'okf-minisearch'
import {
  buildOkfConceptDocument,
  headingsOf,
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

/**
 * 一条笔记入索引的文本：门面字段 + 正文里的标题行，**没有散文**（见文件头）。
 *
 * 标题行原样按 `#` 级别写回去，让 okf-minisearch 照常按小节建记录 —— 命中哪一节，片段就是那一行标题，
 * 于是结果里每条至多多出一行短短的「命中的是这一节」，而不是一段正文。
 */
function indexTextOf(note: KnowledgeNote, text: string): string {
  const split = splitFrontmatter(text)
  const body = split ? split.body : text.replace(/^\uFEFF/, '')
  const headings = headingsOf(body)
    .map((h) => `${'#'.repeat(h.level)} ${h.text}`)
    .join('\n\n')
  const concept = note.concept
  return buildOkfConceptDocument(
    {
      type: note.type || PLAIN_NOTE_TYPE,
      title: note.title,
      description: note.description || undefined,
      tags: note.tags.length > 0 ? note.tags : undefined,
      status: note.status,
      // 定位符也是门面（okf-minisearch 给 resource 的权重是全部字段里最高的）：
      // 「哪一篇引了 conceptFile.ts」得搜得到 —— 它们是元数据，不是本轮要赶出去的散文
      resource: concept?.resource,
      sources: concept && concept.sources.length > 0 ? concept.sources : undefined
    },
    headings
  )
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
    try {
      index.ingest({ path, markdown: segmentCjk(indexTextOf(note, textOf.get(note.path) ?? '')) })
      byPath.set(path, note)
    } catch {
      skipped.push(note.path)
    }
  }
  if (skipped.length > 0) {
    log.warn(`knowledge search: left out of ${bundle}: ${skipped.join(', ')}`)
  }
  const entry = { index, notes: byPath }
  built.set(bundle, entry)
  return entry
}

/** 在一个 bundle 里检索 —— 一条笔记至多一条命中（库按文档去重），deprecated 在这里滤掉。 */
export async function searchBundle(
  bundle: string,
  query: string,
  opts: { limit: number }
): Promise<KnowledgeSearchHit[]> {
  const { index, notes } = await getIndex(bundle)
  // 多取一些再过滤：okf-minisearch 自己已按文档去重（去重发生在它应用 limit 之前，所以一条笔记至多
  // 一条命中），但 deprecated 与索引里认不出的路径是**这里**才滤掉的 —— 不留余量就会少给
  const hits = index.search(segmentCjk(query), {
    limit: Math.max(opts.limit * 4, 40),
    fuzzy: 0.2
  })
  const out: KnowledgeSearchHit[] = []
  for (const hit of hits) {
    const note = notes.get(hit.path.replace(/^\/+/, ''))
    if (!note || note.status === 'deprecated') continue
    out.push({
      path: note.path,
      title: note.title,
      description: note.description,
      status: note.status
    })
    if (out.length >= opts.limit) break
  }
  return out
}
