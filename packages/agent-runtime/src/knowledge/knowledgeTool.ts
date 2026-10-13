/**
 * `knowledge` 工具 —— 知识库的检索、盘点，以及条目的**提交检查**。
 *
 * **条目的正文一律走文件工具**：主 agent 用 `write` 把一篇普通 md 写进库目录（不必带元数据），用
 * `edit` 改；写钩子回执诊断、给 OKF 条目刷新 `generated`，变更管线按 bundle 提交。工具本身不落正文 ——
 * 早先的 `create` 收 type / title / description / body / tags / sources / … 十来个参数，只为在主 agent
 * 这一侧担保元数据形状；那份担保现在挪到了 `submit`：宿主同步派内置 `knowledge-writer` 补齐元数据、
 * 判内容站不站得住，通过了由**宿主**在 `verified` 里记一笔机器确认（review.ts）。元数据的写法因此只
 * 住在写手的提示词里，只在真有条目要过门时才付。
 *
 * 安全：`submit` 以条目绝对路径走 `enforcePath('write')`（通过后宿主要回写章）—— 与文件工具同一道门。
 * 检索 / 盘点只读宿主的扫描缓存，不经门（与改版前一致）。
 *
 * **`submit` / `list` 必须点名一个 base**（`search` 省略即搜全部启用的库）：`project` 是本会话所属项目
 * 的库，其余名字是用户自己的知识库。目标由宿主解析（`resolveBase`）；列表与命中一律给**绝对路径**，
 * agent 直接拿去 `read` / `edit`。跨 bundle 的引用不走路径而走 `shuvix://` URI。
 *
 * 宿主无关：文件经 FileSystemPort，库的解析 / 列举 / 扫描 / 检索 / 写手派发全部注入。
 */
import { Type } from 'typebox'
import type { ToolResult } from '../tools/toolResult'
import type { FileSystemPort } from '../fileTools/port'
import { splitFrontmatter } from '../markdownFrontmatter'
import type { SecurityContext } from '../security/types'
import { BaseTool } from '../tools/baseTool'
import { callOwnerOf, type CallOwner, type ToolCallScope } from '../tools/toolCall'
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
  type KnowledgeReviewOutcome,
  type KnowledgeReviewRequest
} from './review'

/** 交给 PEP 的调用身份：provider 的 toolCallId + durable 的调用归属（taskId / conversationId） */
type PepCall = CallOwner & { toolCallId: string }

export const KNOWLEDGE_TOOL_NAME = 'knowledge'

const ACTIONS = ['bases', 'search', 'list', 'submit'] as const
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
        'A name from "bases". Required for "list" and "submit"; "search" without it covers every base.'
    })
  ),
  query: Type.Optional(Type.String({ description: 'For "search": free-text query.' })),
  path: Type.Optional(
    Type.String({
      description: 'For "submit": the entry\'s file — absolute, or relative to the base.'
    })
  ),
  limit: Type.Optional(
    Type.Number({ description: 'For "search" / "list": max results (default 20 / 100).' })
  )
})

export interface KnowledgeToolParams {
  action: KnowledgeAction
  base?: string
  query?: string
  path?: string
  limit?: number
}

/**
 * 工具描述只讲「怎么用」；「什么时候搜、什么值得记」住在 `<knowledge_bases>` 围栏（knowledgeGuide.ts）——
 * 围栏只在会话真有库时才注入，这份描述则只要档案带 `knowledge` 就恒付，所以压到最短。
 * 元数据的写法不在这里：它住在写手的提示词里（submit 时才付）。
 */
export const KNOWLEDGE_DESCRIPTION = `Search this session's knowledge bases and submit entries for checking. An entry is one markdown file in a base's directory; the user picks which bases a session works with.

Actions:
- "bases": list this session's bases and their directories.
- "search": find entries by free text (\`query\`); leave \`base\` out to search every base. Only titles, descriptions, tags, types and headings are indexed, not the prose — pick by title and description, then \`read\` the file. For a literal string inside bodies, \`grep\` the base's directory.
- "list": list every entry in one base.
- "submit": have the knowledge writer check one entry (\`path\`) and complete its metadata. A passing entry is marked machine-confirmed; otherwise fix what the report says and submit again.

To record something, \`write\` it as plain markdown into the base's directory — one subject per file, named after that subject (the name is permanent), no frontmatter needed, saying in the body where each claim comes from (a path, URL or commit) — then submit it. Change an entry with \`edit\` and submit it again. Extend the entry that already covers a subject rather than adding a near-duplicate. A base may hold the user's own notes without metadata — leave them as they are. Never write \`verified\`. Point into another base with a \`shuvix://\` URI.`

/** 一个库都没启用时对 agent 说的话 —— 别让它以为是自己参数写错了 */
const NO_BASES =
  'This session has no knowledge bases — the user picks which ones a session works with in its settings.'

/** 宿主解析出的目标 bundle */
export interface KnowledgeBundleTarget {
  /** bundle 根的绝对路径（桌面）/ 句柄路径（扩展） */
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
  /** bundle 相对路径（工具回包时拼成绝对路径） */
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
  /** bundle 根的绝对路径；库暂不可用（会话不属于项目 / 项目库还没建）时缺省 */
  dir?: string
  /** 给 agent 的一句补充说明 */
  note?: string
}

export interface KnowledgeToolDeps {
  port: FileSystemPort
  security: SecurityContext
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
   * 调用方 actor 字符串（OKF §5.2：`shuvix-<profile>/<model>`）—— `submit` 通过后 `generated.by` 记它。
   * 收这次调用的 scope（`call.conversationId` 认得出发起调用的 agent；单测直接调时为 undefined）：
   * 会话级装配的工具被同一会话的每个 agent 共用，章要盖成**发起这次提交的** agent。
   */
  actor: (call: ToolCallScope | undefined) => string
  now: () => Date
  /**
   * 派写手检查一条（同步，宿主经派发路由跑完再回来）。宿主不注入（扩展端）则 `submit` 不可用。
   * `call` 是这次工具调用的 scope：写手那条对话归它所有，像 `agent` 工具派出的一样挂在这张卡片下。
   */
  review?: (
    req: KnowledgeReviewRequest,
    ctx: { call: ToolCallScope | undefined; toolCallId: string; signal?: AbortSignal }
  ) => Promise<KnowledgeReviewOutcome>
  /**
   * 这次调用来自写手自己（宿主按调用方档案判）：它拿着 `knowledge` 只为检索，`submit` 一律拒 ——
   * 否则写手能把自己派下去，一层套一层。缺省 = 按「不是」处理。
   */
  isReviewer?: (call: ToolCallScope | undefined) => boolean
  /**
   * 宿主回写了章之后（提交 / 事件由宿主完成）；`path` 是 `bundleDir` 内的相对路径。
   * 只有盖章这一笔要它 —— 条目正文走文件工具，那边自有 onFileChange 接同一条管线。
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

function joinRoot(root: string, rel: string): string {
  const base = root.replace(/[/\\]+$/, '')
  return `${base}/${rel}`
}

/** 列表 / 命中的一行：**绝对路径**（agent 直接拿去 read / edit）+ 状态记号 + 门面 */
function summaryLine(n: KnowledgeNote, dir: string): string {
  const marks: string[] = []
  if (n.status !== 'stable') marks.push(n.status)
  const c = n.concept
  if (c && c.verified.length > 0) {
    marks.push(isVerificationCurrent(c) ? currentTrustTierOf(c) : 'edited since checked')
  }
  const date = c?.generated?.at?.slice(0, 10)
  if (date) marks.push(date)
  const mark = marks.length ? ` (${marks.join(', ')})` : ''
  return `- ${joinRoot(dir, n.path)}${mark} — ${n.description || n.title}`
}

/** 正文（去掉 frontmatter；没有 frontmatter 就是全文） */
function bodyOf(text: string): string {
  return splitFrontmatter(text)?.body ?? text
}

/** 表头恒点名 bundle 的绝对目录 */
function whereLine(target: KnowledgeBundleTarget): string {
  return `${target.label} — ${target.dir}`
}

export class KnowledgeTool extends BaseTool<typeof KnowledgeParamsSchema> {
  readonly name = KNOWLEDGE_TOOL_NAME
  readonly label: string
  readonly description = KNOWLEDGE_DESCRIPTION
  readonly parameters = KnowledgeParamsSchema
  // 不能重跑（裁定 Q1）：一个工具兼管只读的 search / list 与会派写手、回写章的 submit，而 durable 的重跑
  // 策略是按工具、在调用意图落库时定死的 —— 只能取最保守的那个
  readonly replay = 'unsafe' as const

  constructor(private readonly deps: KnowledgeToolDeps) {
    super()
    this.label = deps.label
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    /* submit 在 executeInternal 里按已解析的路径过 PEP */
  }

  protected async executeInternal(
    toolCallId: string,
    params: KnowledgeToolParams,
    signal?: AbortSignal,
    call?: ToolCallScope
  ): Promise<Result> {
    if (signal?.aborted) throw new Error(this.deps.abortError ?? 'Aborted')
    switch (params.action) {
      case 'bases':
        return this.bases()
      case 'search':
        return this.search(params)
      case 'list':
        return this.list(params)
      case 'submit':
        return this.submit(toolCallId, params, signal, call)
      default:
        throw new Error(`Unknown action "${String(params.action)}". Valid: ${ACTIONS.join(', ')}`)
    }
  }

  // ─── 准入 ─────────────────────────────────────────────

  /** 参数里的 base：`list` / `submit` 必须带 */
  private requireBase(params: KnowledgeToolParams): string {
    const base = params.base?.trim()
    if (!base) {
      throw new Error(
        `"${params.action}" needs \`base\` — one of the names "bases" lists for this session`
      )
    }
    return base
  }

  /**
   * `submit` 的 path → 库内相对路径。收绝对路径（落在库目录里）或库相对路径（`/x.md` / `x.md`，前导 `/`
   * 是库根 —— 与列表里的写法无关，是改版前的口径）。越界、非 .md、保留名（index.md / log.md 不是条目）
   * 一律拒绝；隐藏路径（任何一段以 `.` 开头，如 `.obsidian/x.md`）不是库内容（扫描与 locateBundle 都不认），
   * 同样拒绝。带盘符的绝对路径不在库里就直接拒（盘符大小写不敏感）；POSIX 的 `/…` 有歧义，留给 submit 按
   * 「库里没有、库外有」再判。
   */
  private entryPath(raw: string, target: KnowledgeBundleTarget): string {
    const dir = target.dir.replace(/[/\\]+$/, '').replace(/\\/g, '/')
    const slashed = raw.trim().replace(/\\/g, '/')
    const drive = /^[a-z]:\//i
    // Windows 的盘符不分大小写（`c:/` 与 `C:\` 是同一处）；其余照字面比
    const fold = (p: string): string => (drive.test(p) ? p[0].toLowerCase() + p.slice(1) : p)
    const insideDir = fold(slashed) === fold(dir) || fold(slashed).startsWith(`${fold(dir)}/`)
    if (!insideDir && drive.test(slashed)) {
      throw new Error(`"${raw}" is not inside ${whereLine(target)}`)
    }
    const rel = normalizeBundlePath(insideDir ? slashed.slice(dir.length) : slashed)
    if (!rel || escapesBundle(rel)) throw new Error(`"${raw}" is not inside ${whereLine(target)}`)
    if (rel.split('/').some((seg) => seg.startsWith('.'))) {
      throw new Error(`"${raw}" is a hidden path — it is not part of the knowledge base`)
    }
    if (!/\.md$/i.test(rel)) throw new Error(`"${raw}" is not a markdown entry (.md)`)
    if (isReservedFile(rel)) throw new Error(`/${rel} is a reserved name, not an entry`)
    return rel
  }

  // ─── actions ───────────────────────────────────────────────

  private async bases(): Promise<Result> {
    const bases = await this.deps.listBases()
    if (bases.length === 0) {
      return text([NO_BASES], { action: 'bases' })
    }
    return text(
      [
        'Knowledge bases in this session (pass the name as `base`):',
        ...bases.map(
          (b) =>
            `- ${b.base} — ${b.label}${b.dir ? ` — ${b.dir}` : ''}${b.note ? ` (${b.note})` : ''}`
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
            `- ${joinRoot(target.dir, normalizeBundlePath(h.path))}${h.status && h.status !== 'stable' ? ` (${h.status})` : ''} — ${h.description || h.title}`
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
      lines: matches.slice(0, limit).map((n) => summaryLine(n, target.dir))
    }
  }

  /**
   * 检索。点名 `base` 就只搜那一个；**省略 `base` 就搜这条会话启用的全部库**，按库分组 ——
   * 范围是用户自己圈定的，圈定之后一起搜才有意义。不做跨库分数归一：每个库一套 BM25 索引，
   * 分数不可比，硬排会骗人。
   */
  private async search(params: KnowledgeToolParams): Promise<Result> {
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
      return text([`${total} result(s) for "${query}" in ${whereLine(resolved)}:`, ...lines], {
        action: 'search'
      })
    }

    const bases = await this.deps.listBases()
    const usable = bases.filter((b) => b.dir)
    if (usable.length === 0) return text([NO_BASES], { action: 'search' })
    const blocks: string[] = []
    let total = 0
    for (const b of usable) {
      const hit = await this.searchOne({ dir: b.dir!, label: b.label }, query, limit)
      if (hit.total === 0) continue
      total += hit.total
      blocks.push(`base "${b.base}" — ${b.dir}:`, ...hit.lines)
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

  private async list(params: KnowledgeToolParams): Promise<Result> {
    const limit = positiveLimit(params.limit, DEFAULT_LIMIT * 5)
    const resolved = await this.deps.resolveBase(this.requireBase(params))
    if ('error' in resolved) return text([resolved.error], { action: 'list' })
    const { notes } = await this.deps.scan(resolved.dir)
    if (notes.length === 0) {
      return text([`No entries in ${whereLine(resolved)} yet.`], { action: 'list' })
    }
    const lines = notes.slice(0, limit).map((n) => summaryLine(n, resolved.dir))
    if (notes.length > limit) lines.push(`- … ${notes.length - limit} more`)
    return text(
      [
        `${notes.length} entr${notes.length === 1 ? 'y' : 'ies'} in ${whereLine(resolved)}:`,
        ...lines
      ],
      { action: 'list' }
    )
  }

  /**
   * 提交检查 —— 同步派写手补元数据、判内容；**通过才由宿主盖章**（`generated` 记提交者、`verified` 记写手
   * 的机器确认，见 review.ts）。写手判了通过、可文件仍过不了严格校验（或压根不是 OKF 条目）时不盖：
   * 章是给「合规且站得住」的条目的，写手的一句话不能替校验作证。
   */
  private async submit(
    toolCallId: string,
    params: KnowledgeToolParams,
    signal: AbortSignal | undefined,
    call: ToolCallScope | undefined
  ): Promise<Result> {
    if (this.deps.isReviewer?.(call)) {
      throw new Error(
        'The knowledge writer does not submit entries — edit the entry you were given and answer with `next`.'
      )
    }
    if (!params.path?.trim()) throw new Error('"submit" needs `path` — the entry\'s file')
    const base = this.requireBase(params)
    const target = await this.deps.resolveBase(base)
    if ('error' in target) throw new Error(target.error)
    // 只读的库（宿主随应用发布的说明书）：在这里拒，而不是留给安全策略 —— 策略拒的是路径，
    // 回给模型的话说不清「该记到哪里去」
    if (target.readonly) {
      throw new Error(
        `"${base}" is read-only — it is ShuviX's own reference, shipped with the app. Record the entry in one of the user's knowledge bases instead ("bases" lists them).`
      )
    }
    if (!this.deps.review) throw new Error('Submitting entries is not available on this host')
    const rel = this.entryPath(params.path, target)
    const abs = joinRoot(target.dir, rel)
    if ((await this.deps.port.stat(abs)) === null) {
      // 一个库外的绝对路径（`/Users/…/draft.md`）按库相对读成了库里一个不存在的文件：说清是「不在库里」
      const raw = params.path.trim()
      if (raw.startsWith('/') && (await this.deps.port.stat(raw)) !== null) {
        throw new Error(
          `"${raw}" is not inside ${whereLine(target)} — write the entry into the base's directory`
        )
      }
      throw new Error(`No file at ${abs} — write the entry there first, then submit it`)
    }
    // 符号链接不跟（与文件工具同一条规矩）：门看的是链接这条路径，章却会写进它通向的那头
    const link = await this.deps.port.readLink?.(abs)
    if (link) {
      throw new Error(
        `${abs} is a symbolic link to ${link.resolved} — entries must be real files inside the base`
      )
    }

    // 通过之后宿主要回写章：按写入过门（与文件工具同一道门）
    const pep: PepCall = { toolCallId, ...callOwnerOf(call) }
    await this.deps.security.enforcePath('write', abs, {
      ...pep,
      toolName: this.name,
      displayPath: abs,
      abortError: this.deps.abortError ?? 'Aborted',
      operation: params.action,
      signal
    })

    const submittedBy = this.deps.actor(call)
    const outcome = await this.deps.review(
      { base, label: target.label, bundleDir: target.dir, path: abs, rel, submittedBy },
      { call, toolCallId, signal }
    )
    if (signal?.aborted) throw new Error(this.deps.abortError ?? 'Aborted')
    if ('error' in outcome) {
      throw new Error(`The knowledge writer could not check ${abs}: ${outcome.error}`)
    }
    const report = outcome.report || '(no report)'
    if (!outcome.passed) {
      return text(
        [
          `Not confirmed: ${abs}`,
          '',
          report,
          '',
          'Fix the entry and submit it again. Re-read it first — the writer may have edited its metadata.'
        ],
        { action: 'submit', path: rel }
      )
    }

    // 写手说通过：落章之前自己再验一遍 —— 它的话不能替校验作证
    const current = await this.deps.port.readFile(abs)
    const errors = validateKnowledgeText(current, rel).filter((d) => d.level === 'error')
    if (!isOkfConceptText(current) || errors.length > 0) {
      const why = errors.length
        ? errors.map((d) => `- ${d.message}`)
        : ['- it has no OKF frontmatter with a `type`']
      return text(
        [
          `Not confirmed: ${abs} — the writer passed it, but the file still breaks the format:`,
          ...why,
          '',
          report,
          '',
          'Submit it again.'
        ],
        { action: 'submit', path: rel }
      )
    }
    const stamped = stampKnowledgeReview(current, {
      submittedBy,
      reviewer: outcome.reviewer,
      at: this.deps.now().toISOString()
    })
    if (stamped !== null && stamped !== current) {
      await this.deps.port.writeFile(abs, stamped)
      await this.deps.afterWrite?.({ bundleDir: target.dir, path: rel }, call)
    }
    return text(
      [
        `Confirmed: ${abs} (machine-confirmed by ${outcome.reviewer}). Re-read it before editing it again.`,
        '',
        report
      ],
      { action: 'submit', path: rel }
    )
  }
}

export function createKnowledgeTool(deps: KnowledgeToolDeps): KnowledgeTool {
  return new KnowledgeTool(deps)
}
