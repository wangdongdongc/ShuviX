/**
 * `knowledge` 工具 —— 知识库的检索、盘点、读条目，以及把要记的内容**交给知识库管理员**。
 *
 * **2026-11-08 改版：库目录只有管理员知道。** 别的 agent 眼里，知识库只有库名与条目名（库内路径，
 * `/auth/session.md` —— 条目之间的链接本来就这么写）：`bases` 不给目录，`search` / `list` 给条目名，
 * 正文经 `read` 看（读的是宿主的扫描缓存，与检索、盘点同一份，不经文件门）。它们也不再自己往库里写：
 * `submit` 交上来的是内容（`content`，可点名它更正 / 补充的那一条），宿主同步派管理员（内置
 * `knowledge-writer`），由它决定新建、改写、合并、改名、删除还是不收（review.ts）。为以后更复杂的组织
 * 方式做准备：库换一种存放方式、每个库配自己的管理员，非管理员这一侧都不用动。
 *
 * 管理员自己调这个工具时（宿主按调用方档案判）`bases` / `search` / `list` 印上目录 —— 它拿文件工具干活；
 * 它的 `submit` 一律拒（否则能把自己派下去，一层套一层）。
 *
 * 只是约定，不是卡点（2026-11-08 裁决）：非管理员经文件工具或命令直接碰库目录，不归这里管。
 *
 * 宿主无关：文件经 FileSystemPort，库的解析 / 列举 / 扫描 / 检索 / 管理员派发全部注入。
 */
import { Type } from 'typebox'
import type { ToolResult } from '../tools/toolResult'
import type { FileSystemPort } from '../fileTools/port'
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateLine
} from '../fileTools/truncate'
import { splitFrontmatter } from '../markdownFrontmatter'
import { BaseTool } from '../tools/baseTool'
import type { ToolCallScope } from '../tools/toolCall'
import {
  currentTrustTierOf,
  headingsOf,
  isOkfConceptText,
  isVerificationCurrent,
  type KnowledgeConcept,
  type KnowledgeNote
} from './conceptFile'
import { escapesBundle, normalizeBundlePath } from './bundlePaths'
import { isReservedFile, validateKnowledgeText, type BundleFile } from './validate'
import {
  stampKnowledgeReview,
  type KnowledgeAdminOutcome,
  type KnowledgeEntryChangeRecord,
  type KnowledgeSubmission
} from './review'

export const KNOWLEDGE_TOOL_NAME = 'knowledge'

const ACTIONS = ['bases', 'search', 'list', 'read', 'submit'] as const
export type KnowledgeAction = (typeof ACTIONS)[number]

export const KnowledgeParamsSchema = Type.Object({
  action: Type.Unsafe<KnowledgeAction>({
    type: 'string',
    enum: [...ACTIONS],
    description: 'See the tool description.'
  }),
  base: Type.Optional(
    Type.String({
      description:
        'A name from "bases". Required for "list", "read" and "submit"; "search" without it covers every base.'
    })
  ),
  query: Type.Optional(Type.String({ description: 'For "search": free-text query.' })),
  entry: Type.Optional(
    Type.String({
      description:
        'An entry\'s path inside its base, as "search" and "list" give it. For "read": the entry to read. For "submit": the entry the submission corrects or extends, if any.'
    })
  ),
  content: Type.Optional(
    Type.String({ description: 'For "submit": what to record, in markdown.' })
  ),
  offset: Type.Optional(
    Type.Number({ description: 'For "read": the line to start at (1-based).' })
  ),
  limit: Type.Optional(
    Type.Number({
      description:
        'For "search" / "list": max results (default 20 / 100). For "read": max lines (default 2000).'
    })
  )
})

export interface KnowledgeToolParams {
  action: KnowledgeAction
  base?: string
  query?: string
  entry?: string
  content?: string
  offset?: number
  limit?: number
}

/**
 * 工具描述只讲「怎么用」；「什么时候搜、什么值得记」住在 `<knowledge_bases>` 围栏（knowledgeGuide.ts）——
 * 围栏只在会话真有库时才注入，这份描述则只要档案带 `knowledge` 就恒付，所以压到最短。
 * 条目怎么组织、元数据怎么写都不在这里：那是管理员的事，住在它的提示词里（submit 时才付）。
 */
export const KNOWLEDGE_DESCRIPTION = `Look things up in this session's knowledge bases, and hand what is worth keeping to their librarian. A base holds entries, each named by its path inside the base ("/auth/token-refresh.md"); the user picks which bases a session works with.

Actions:
- "bases": list this session's bases.
- "search": find entries by free text (\`query\`); leave \`base\` out to search every base. Only titles, descriptions, tags, types and headings are indexed, not the prose — pick by title and description, then "read" the entry.
- "list": list every entry in one base.
- "read": read one entry (\`base\`, \`entry\`); a long one pages with \`offset\` and \`limit\` (lines). A link inside an entry that starts with "/" names another entry of the same base.
- "submit": hand the base's librarian something worth looking up again (\`content\`, markdown): the subject, what holds, and where each claim comes from (a path, URL or commit). When it corrects or extends an entry that "search", "list" or "read" showed you, name that \`entry\`. The librarian decides how the base records it — a new entry, a change to existing ones, or nothing — and says what it did.`

/** 一个库都没启用时对 agent 说的话 —— 别让它以为是自己参数写错了 */
const NO_BASES =
  'This session has no knowledge bases — the user picks which ones a session works with in its settings.'

/** 宿主解析出的目标 bundle */
export interface KnowledgeBundleTarget {
  /** bundle 根的绝对路径（桌面）/ 句柄路径（扩展）—— 只印给管理员 */
  dir: string
  /** 人读标签，如 `project "Acme Corp"` */
  label: string
  /** 只读（宿主随应用发布的内置库）：`submit` 拒绝，其余动作照常 */
  readonly?: boolean
}

/**
 * 一条检索命中 —— **只有门面，没有正文片段**：检索回答的是「哪几条可能相关」，正文由 `read` 取。
 * 每条命中都拖一段正文，是全文入索引时最占上下文的那一半（工具描述据此教「先按门面挑、再 `read`」）。
 */
export interface KnowledgeSearchHit {
  /** bundle 相对路径（工具回包时拼成条目名 `/x.md`） */
  path: string
  title: string
  description?: string
  status?: string
}

/** 宿主的一次 bundle 扫描（带缓存）：全部 md 原文 + 解析成功的 OKF 条目 + 全部笔记 */
export interface KnowledgeBundleScan {
  files: readonly BundleFile[]
  concepts: readonly KnowledgeConcept[]
  /** 除 ShuviX 早先生成的 index.md / log.md 外的每个 md —— 合规条目与用户的普通笔记一视同仁 */
  notes: readonly KnowledgeNote[]
}

/** `bases` 的一行：一个可以点名的库 */
export interface KnowledgeBaseInfo {
  /** 传给 `base` 的名字 */
  base: string
  /** 人读标签，如 `project "Acme"` / `knowledge base "读书笔记"` */
  label: string
  /** bundle 根的绝对路径（只印给管理员）；库暂不可用时缺省 */
  dir?: string
  /** 给 agent 的一句补充说明 */
  note?: string
}

/** 交给管理员的那一半（工具补上库目录 / 标签再交宿主） */
export type KnowledgeAdminRun = (
  req: KnowledgeSubmission,
  ctx: { call: ToolCallScope | undefined; toolCallId: string; signal?: AbortSignal }
) => Promise<KnowledgeAdminOutcome>

export interface KnowledgeToolDeps {
  port: FileSystemPort
  /**
   * 解析一个 base。库目录可能还不存在（项目库在第一次写入时才出现），读起来就是空的；宿主从不「建库」。
   * 解析不出（会话不属于项目 / 没有这个库）返回一句可读的 error。
   */
  resolveBase: (base: string) => Promise<KnowledgeBundleTarget | { error: string }>
  /** 本会话可以点名的全部库（`project` 在前） */
  listBases: () => Promise<readonly KnowledgeBaseInfo[]>
  /** 该 bundle 的扫描结果（宿主缓存；路径 bundle 相对） */
  scan: (bundleDir: string) => Promise<KnowledgeBundleScan>
  /** 该 bundle 内的检索 */
  search?: (
    query: string,
    opts: { limit: number; bundleDir: string }
  ) => Promise<KnowledgeSearchHit[]>
  /**
   * 调用方 actor 字符串（OKF §5.2：`shuvix-<profile>/<model>`）—— 收录后 `generated.by` 记它。
   * 收这次调用的 scope（`call.conversationId` 认得出发起调用的 agent；单测直接调时为 undefined）：
   * 会话级装配的工具被同一会话的每个 agent 共用，章要盖成**发起这次提交的** agent。
   */
  actor: (call: ToolCallScope | undefined) => string
  now: () => Date
  /**
   * 派管理员收这一次提交（同步，宿主经派发路由跑完再回来）。宿主不注入（扩展端）则 `submit` 不可用。
   * `ctx.call` 是这次工具调用的 scope：管理员那条对话归它所有，像 `agent` 工具派出的一样挂在这张卡片下。
   */
  admin?: KnowledgeAdminRun
  /**
   * 这次调用来自管理员自己（宿主按调用方档案判）：它看得到库目录，它的 `submit` 一律拒。缺省 = 按「不是」处理。
   */
  isAdmin?: (call: ToolCallScope | undefined) => boolean
  /**
   * 宿主回写了章之后（提交 / 事件由宿主完成）；`path` 是 `bundleDir` 内的相对路径。
   * 只有盖章这一笔要它 —— 管理员的改动走文件工具，那边自有 onFileChange 接同一条管线。
   */
  afterWrite?: (
    e: { bundleDir: string; path: string },
    /** 这次调用的 scope（同 `actor` 的入参） */
    call: ToolCallScope | undefined
  ) => void | Promise<void>
  abortError?: string
  label: string
}

type Result = ToolResult<{ action: KnowledgeAction; path?: string } | undefined>

const DEFAULT_LIMIT = 20

/**
 * `limit` 收下限：小数截尾（`2.7` → 2），**截完不是正数**（0 / 负数 / `0.5` / NaN / Infinity）就回落缺省。
 * 表头报的是全部命中数、行数按它截，所以一个荒唐的 limit 会让两个数字对不上 —— 那种错最难查。
 */
function positiveLimit(raw: number | undefined, fallback: number): number {
  const n = Math.trunc(raw ?? fallback)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function text(lines: string[], details?: { action: KnowledgeAction; path?: string }): Result {
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    details
  }
}

/** 条目名：库内路径带前导 `/`（与条目之间的链接同一种写法） */
function entryLabel(rel: string): string {
  return `/${normalizeBundlePath(rel)}`
}

const stripDir = (dir: string): string => dir.replace(/[/\\]+$/, '')

/** 列表 / 命中的一行：条目名 + 状态记号 + 门面 */
function summaryLine(n: KnowledgeNote): string {
  const marks: string[] = []
  if (n.status !== 'stable') marks.push(n.status)
  const c = n.concept
  if (c && c.verified.length > 0) {
    marks.push(isVerificationCurrent(c) ? currentTrustTierOf(c) : 'edited since checked')
  }
  const date = c?.generated?.at?.slice(0, 10)
  if (date) marks.push(date)
  const mark = marks.length ? ` (${marks.join(', ')})` : ''
  return `- ${entryLabel(n.path)}${mark} — ${n.description || n.title}`
}

/** 正文（去掉 frontmatter；没有 frontmatter 就是全文） */
function bodyOf(text: string): string {
  return splitFrontmatter(text)?.body ?? text
}

export class KnowledgeTool extends BaseTool<typeof KnowledgeParamsSchema> {
  readonly name = KNOWLEDGE_TOOL_NAME
  readonly label: string
  readonly description = KNOWLEDGE_DESCRIPTION
  readonly parameters = KnowledgeParamsSchema
  // 不能重跑（裁定 Q1）：一个工具兼管只读的 search / list / read 与会派管理员、回写章的 submit，而 durable
  // 的重跑策略是按工具、在调用意图落库时定死的 —— 只能取最保守的那个
  readonly replay = 'unsafe' as const

  constructor(private readonly deps: KnowledgeToolDeps) {
    super()
    this.label = deps.label
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    /* 读侧只读宿主的扫描缓存；submit 的写入由管理员的文件工具各自过门 */
  }

  protected async executeInternal(
    toolCallId: string,
    params: KnowledgeToolParams,
    signal?: AbortSignal,
    call?: ToolCallScope
  ): Promise<Result> {
    if (signal?.aborted) throw new Error(this.deps.abortError ?? 'Aborted')
    const admin = this.deps.isAdmin?.(call) === true
    switch (params.action) {
      case 'bases':
        return this.bases(admin)
      case 'search':
        return this.search(params, admin)
      case 'list':
        return this.list(params, admin)
      case 'read':
        return this.read(params)
      case 'submit':
        return this.submit(toolCallId, params, signal, call, admin)
      default:
        throw new Error(`Unknown action "${String(params.action)}". Valid: ${ACTIONS.join(', ')}`)
    }
  }

  // ─── 准入 ─────────────────────────────────────────────

  /** 参数里的 base：`list` / `read` / `submit` 必须带 */
  private requireBase(params: KnowledgeToolParams): string {
    const base = params.base?.trim()
    if (!base) {
      throw new Error(
        `"${params.action}" needs \`base\` — one of the names "bases" lists for this session`
      )
    }
    return base
  }

  /** 表头里点名的库：标签；管理员另带目录 */
  private where(target: KnowledgeBundleTarget, admin: boolean): string {
    return admin ? `${target.label} — ${stripDir(target.dir)}` : target.label
  }

  /**
   * `entry` → 库内相对路径（不带前导 `/`），且必须是这个库里一条**在册**的笔记（扫描见过的 md）。
   * 收 `/x.md`、`x.md`、省掉 `.md` 的写法；旧对话里留下的绝对路径（落在库目录里）也认。
   * 越界、隐藏路径、保留名、不在册一律拒 —— 只认扫描清单，所以库里的符号链接、隐藏目录从来够不着。
   */
  private async locateEntry(
    raw: string,
    target: KnowledgeBundleTarget,
    base: string
  ): Promise<{ rel: string; scan: KnowledgeBundleScan }> {
    // Windows 的盘符不分大小写（`c:/` 与 `C:\` 是同一处）；其余照字面比
    const fold = (p: string): string => (/^[a-z]:\//i.test(p) ? p[0].toLowerCase() + p.slice(1) : p)
    const dir = fold(stripDir(target.dir).replace(/\\/g, '/'))
    let slashed = raw.trim().replace(/\\/g, '/')
    if (dir && (fold(slashed) === dir || fold(slashed).startsWith(`${dir}/`))) {
      slashed = slashed.slice(dir.length)
    }
    const rel = normalizeBundlePath(slashed)
    if (!rel || escapesBundle(rel)) throw new Error(`"${raw}" is not an entry name`)
    const scan = await this.deps.scan(target.dir)
    const known = new Set(scan.notes.map((n) => n.path))
    if (known.has(rel)) return { rel, scan }
    if (!/\.md$/i.test(rel) && known.has(`${rel}.md`)) return { rel: `${rel}.md`, scan }
    throw new Error(
      `No entry ${entryLabel(rel)} in base "${base}" — "search" or "list" it for the right name`
    )
  }

  // ─── actions ───────────────────────────────────────────────

  private async bases(admin: boolean): Promise<Result> {
    const bases = await this.deps.listBases()
    if (bases.length === 0) {
      return text([NO_BASES], { action: 'bases' })
    }
    return text(
      [
        'Knowledge bases in this session (pass the name as `base`):',
        ...bases.map(
          (b) =>
            `- ${b.base} — ${b.label}${admin && b.dir ? ` — ${stripDir(b.dir)}` : ''}${b.note ? ` (${b.note})` : ''}`
        )
      ],
      { action: 'bases' }
    )
  }

  /**
   * 一个库里的命中。`total` 是**全部**命中数、`lines` 按 limit 截 —— 表头报总数、正文只印前几条，
   * 「还有更多」才一眼看得出来（注入了检索时后端已按 limit 截，两者相等）。
   */
  private async searchOne(
    target: KnowledgeBundleTarget,
    query: string,
    limit: number
  ): Promise<{ total: number; lines: string[] }> {
    if (this.deps.search) {
      const hits = await this.deps.search(query, { limit, bundleDir: target.dir })
      return {
        total: hits.length,
        lines: hits.map(
          (h) =>
            `- ${entryLabel(h.path)}${h.status && h.status !== 'stable' ? ` (${h.status})` : ''} — ${h.description || h.title}`
        )
      }
    }
    // 宿主没注入检索（扩展端）时的兜底。**面与宿主索引一致：门面 + 正文标题行，不看散文** ——
    // 两端对同一个查询的召回口径不该差一整个数量级
    const needle = query.toLowerCase()
    const { files, notes } = await this.deps.scan(target.dir)
    const textOf = new Map(files.map((f) => [f.path, f.text]))
    const matches = notes.filter((n) => {
      if (n.status === 'deprecated') return false
      const headings = headingsOf(bodyOf(textOf.get(n.path) ?? ''))
        .map((h) => h.text)
        .join(' ')
      return [n.title, n.description, n.type, n.tags.join(' '), headings].some((s) =>
        s.toLowerCase().includes(needle)
      )
    })
    return {
      total: matches.length,
      lines: matches.slice(0, limit).map((n) => summaryLine(n))
    }
  }

  /**
   * 检索。点名 `base` 就只搜那一个；**省略 `base` 就搜这条会话启用的全部库**，按库分组 ——
   * 范围是用户自己圈定的，圈定之后一起搜才有意义。不做跨库分数归一：每个库一套 BM25 索引，
   * 分数不可比，硬排会骗人。
   */
  private async search(params: KnowledgeToolParams, admin: boolean): Promise<Result> {
    const query = params.query?.trim()
    if (!query) throw new Error('"search" needs `query`')
    const limit = positiveLimit(params.limit, DEFAULT_LIMIT)
    const named = params.base?.trim()

    if (named) {
      // base 解析不出（没启用 / 没有这个库）对检索是软条件：回文字不抛错，与 list 同口径
      const resolved = await this.deps.resolveBase(named)
      if ('error' in resolved) return text([resolved.error], { action: 'search' })
      const { total, lines } = await this.searchOne(resolved, query, limit)
      if (total === 0) return text([`No entries match "${query}".`], { action: 'search' })
      return text(
        [
          `${total} result(s) for "${query}" in base "${named}" (${this.where(resolved, admin)}):`,
          ...lines
        ],
        { action: 'search' }
      )
    }

    const bases = await this.deps.listBases()
    const usable = bases.filter((b) => b.dir)
    if (usable.length === 0) return text([NO_BASES], { action: 'search' })
    const blocks: string[] = []
    let total = 0
    for (const b of usable) {
      const target = { dir: b.dir!, label: b.label }
      const hit = await this.searchOne(target, query, limit)
      if (hit.total === 0) continue
      total += hit.total
      blocks.push(`base "${b.base}" (${this.where(target, admin)}):`, ...hit.lines)
    }
    if (total === 0) {
      return text([`No entries match "${query}" in any of this session's knowledge bases.`], {
        action: 'search'
      })
    }
    return text([`${total} result(s) for "${query}" across ${usable.length} base(s):`, ...blocks], {
      action: 'search'
    })
  }

  private async list(params: KnowledgeToolParams, admin: boolean): Promise<Result> {
    const limit = positiveLimit(params.limit, DEFAULT_LIMIT * 5)
    const base = this.requireBase(params)
    const resolved = await this.deps.resolveBase(base)
    if ('error' in resolved) return text([resolved.error], { action: 'list' })
    const where = `base "${base}" (${this.where(resolved, admin)})`
    const { notes } = await this.deps.scan(resolved.dir)
    if (notes.length === 0) {
      return text([`No entries in ${where} yet.`], { action: 'list' })
    }
    const lines = notes.slice(0, limit).map((n) => summaryLine(n))
    if (notes.length > limit) lines.push(`- … ${notes.length - limit} more`)
    return text(
      [`${notes.length} entr${notes.length === 1 ? 'y' : 'ies'} in ${where}:`, ...lines],
      { action: 'list' }
    )
  }

  /**
   * 读一条：扫描缓存里的原文（frontmatter 一并给 —— `sources`、`status` 对读的人有用），按行分页、
   * 单行截断、字节上限与文件 `read` 同一套口径，只是不印行号（没有人拿它去 edit）。
   */
  private async read(params: KnowledgeToolParams): Promise<Result> {
    const base = this.requireBase(params)
    const raw = params.entry?.trim()
    if (!raw) throw new Error('"read" needs `entry` — an entry\'s path inside the base')
    const target = await this.deps.resolveBase(base)
    if ('error' in target) throw new Error(target.error)
    const { rel, scan } = await this.locateEntry(raw, target, base)
    const content = scan.files.find((f) => f.path === rel)?.text ?? ''
    const all = content.replace(/\r\n/g, '\n').split('\n')
    if (all.length > 1 && all[all.length - 1] === '') all.pop()
    const total = all.length
    const start = Math.max(1, Math.trunc(params.offset ?? 1) || 1)
    const limit = positiveLimit(params.limit, DEFAULT_MAX_LINES)
    const out: string[] = []
    let bytes = 0
    let cappedByBytes = false
    for (let i = start - 1; i < total && out.length < limit; i++) {
      const line = truncateLine(all[i])
      const size = new TextEncoder().encode(line).length + 1
      if (bytes + size > DEFAULT_MAX_BYTES && out.length > 0) {
        cappedByBytes = true
        break
      }
      out.push(line)
      bytes += size
    }
    const last = start + out.length - 1
    const header = `Entry ${entryLabel(rel)} in base "${base}" (${target.label}) — ${total} lines`
    let tail: string
    if (start > total) tail = `(The entry has ${total} lines.)`
    else if (cappedByBytes)
      tail = `(Output capped at ${formatSize(DEFAULT_MAX_BYTES)}. Showing lines ${start}-${last}. Use offset=${last + 1} to continue.)`
    else if (last < total)
      tail = `(Showing lines ${start}-${last} of ${total}. Use offset=${last + 1} to continue.)`
    else tail = start > 1 ? `(Lines ${start}-${last}, end of entry.)` : '(End of entry.)'
    return text([header, '', ...out, '', tail], { action: 'read', path: rel })
  }

  /**
   * 提交：同步派管理员。它收了，宿主给它动过、且仍合规的条目盖章（`generated` 记提交者、`verified` 记
   * 管理员的机器确认，见 review.ts）；不合规的不盖 —— 管理员的一句「收了」不能替校验作证。回给提交者的
   * 话只说条目名，管理员报告里漏出来的库目录换成条目名的写法。
   */
  private async submit(
    toolCallId: string,
    params: KnowledgeToolParams,
    signal: AbortSignal | undefined,
    call: ToolCallScope | undefined,
    admin: boolean
  ): Promise<Result> {
    if (admin) {
      throw new Error(
        'You are the librarian: record the submission yourself with the file tools, and answer with `next`.'
      )
    }
    const content = params.content?.trim()
    if (!content) throw new Error('"submit" needs `content` — what to record, in markdown')
    const base = this.requireBase(params)
    const target = await this.deps.resolveBase(base)
    if ('error' in target) throw new Error(target.error)
    // 只读的库（宿主随应用发布的说明书）：在这里拒，回给模型的话说得清「该记到哪里去」
    if (target.readonly) {
      throw new Error(
        `"${base}" is read-only — it is ShuviX's own reference, shipped with the app. Submit to one of the user's knowledge bases instead ("bases" lists them).`
      )
    }
    if (!this.deps.admin)
      throw new Error('Submitting to a knowledge base is not available on this host')
    const entry = params.entry?.trim()
      ? (await this.locateEntry(params.entry, target, base)).rel
      : undefined

    const submittedBy = this.deps.actor(call)
    const outcome = await this.deps.admin(
      {
        base,
        label: target.label,
        bundleDir: target.dir,
        content,
        ...(entry ? { entry } : {}),
        submittedBy
      },
      { call, toolCallId, signal }
    )
    if (signal?.aborted) throw new Error(this.deps.abortError ?? 'Aborted')
    if ('error' in outcome) {
      throw new Error(
        `The knowledge librarian could not take the submission: ${this.scrubDir(outcome.error, target)}`
      )
    }
    const report = this.scrubDir(outcome.report, target) || '(no report)'
    if (!outcome.accepted) {
      return text([`Not recorded in base "${base}".`, '', report], { action: 'submit' })
    }

    const stamped = await this.stampChanged(
      outcome.entries,
      target,
      submittedBy,
      outcome.admin,
      call
    )
    const lines = outcome.entries.map((e) => {
      const flag = stamped.problems.get(e.entry)
      return `- ${entryLabel(e.entry)} (${e.change}${flag ? `; ${flag}` : ''})`
    })
    return text([`Recorded in base "${base}"${lines.length ? ':' : '.'}`, ...lines, '', report], {
      action: 'submit',
      ...(outcome.entries[0] ? { path: outcome.entries[0].entry } : {})
    })
  }

  /** 管理员的报告给提交者看：库目录（它拿文件工具干活时写顺手了）换成条目名的写法 */
  private scrubDir(report: string, target: KnowledgeBundleTarget): string {
    const dir = stripDir(target.dir)
    if (!dir) return report
    const variants = new Set([dir, dir.replace(/\\/g, '/')])
    let out = report
    for (const v of variants)
      out = out.split(`${v}/`).join('/').split(`${v}\\`).join('/').split(v).join('/')
    return out
  }

  /**
   * 给管理员报了 created / updated、此刻仍在、且是合规 OKF 条目的那几条盖章。没盖上的记一句原因
   * （列在回包那一行里）：普通笔记（没有元数据）照用户的写法留着，不算问题，不记。
   */
  private async stampChanged(
    entries: readonly KnowledgeEntryChangeRecord[],
    target: KnowledgeBundleTarget,
    submittedBy: string,
    adminActor: string,
    call: ToolCallScope | undefined
  ): Promise<{ problems: Map<string, string> }> {
    const problems = new Map<string, string>()
    const at = this.deps.now().toISOString()
    const dir = stripDir(target.dir)
    for (const e of entries) {
      if (e.change === 'deleted') continue
      const rel = normalizeBundlePath(e.entry)
      if (!rel || escapesBundle(rel) || !/\.md$/i.test(rel)) {
        problems.set(e.entry, 'not an entry name')
        continue
      }
      // 保留名（index.md / log.md）不是条目：不盖章
      if (isReservedFile(rel)) {
        problems.set(e.entry, 'a reserved name, not an entry')
        continue
      }
      const abs = `${dir}/${rel}`
      // 符号链接不跟：章会写进它通向的那头
      if (await this.deps.port.readLink?.(abs)) {
        problems.set(e.entry, 'a symbolic link, not confirmed')
        continue
      }
      if ((await this.deps.port.stat(abs)) === null) {
        problems.set(e.entry, 'not found')
        continue
      }
      const current = await this.deps.port.readFile(abs)
      // 先校验、再判是不是 OKF 条目：带了自述行却写坏了 frontmatter（缺 `type`、YAML 解析不了）的文件
      // isOkfConceptText 认不出，不先校验就会被当成普通笔记悄悄放过
      const errors = validateKnowledgeText(current, rel).filter((d) => d.level === 'error')
      if (errors.length > 0) {
        problems.set(e.entry, `not confirmed — ${errors.map((d) => d.message).join('; ')}`)
        continue
      }
      // 用户自己的普通笔记（没有元数据）：照用户的写法留着，不盖章、不算问题
      if (!isOkfConceptText(current)) continue
      const next = stampKnowledgeReview(current, { submittedBy, reviewer: adminActor, at })
      if (next !== null && next !== current) {
        await this.deps.port.writeFile(abs, next)
        await this.deps.afterWrite?.({ bundleDir: target.dir, path: rel }, call)
      }
    }
    return { problems }
  }
}

export function createKnowledgeTool(deps: KnowledgeToolDeps): KnowledgeTool {
  return new KnowledgeTool(deps)
}
