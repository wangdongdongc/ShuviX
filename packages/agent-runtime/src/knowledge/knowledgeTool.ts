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
 * **迁移（2026-11-11，docs/project-split-design.md §5）**：拆分项目时把另一个项目的项目库里的条目迁进本会话的库。
 * 两样新东西：`project` 参数 —— `list` / `search` / `read` 带上它，看的就是那个项目的库（只读，宿主过一次门）；
 * `migrate` —— 宿主读出点名条目的原文交给**目标库**的管理员（模型不重抄正文），它逐条决定收不收；收下的，宿主从
 * 源库删掉。管理员照旧只动自己那个库。宿主不注入 `resolveProjectBase`（扩展端）则两样都不可用。
 *
 * **把关与整理（2026-11-12）**：用户反馈库很容易劣化 —— 工作会话把中间过程当知识交上来，管理员照单全收。管理员的
 * md 现在按「对项目有没有长期保存价值」判断收不收、只留能留的那部分，并在每次提交时顺手整理提交落进去的那一块。
 * 这里配三样：`organize` —— 什么都不交，请管理员把一个库整个过一遍（用户说「整理一下知识库」时用）；提交与整理的
 * 请求里带上已经挤了的文件夹（review.ts `crowdedFolders`）—— 让它自己数条目，实测它不数；盖章跳过
 * 只挪了位置的条目（`stampChanged` 的 `before`）—— 管理员按主题分文件夹时挪的条目一字未改，不该被重新记成
 * 「刚由这次的提交者写下」，那会让人工核实过的条目变成「核实后又改过」。
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
import { extractConceptLinks } from './okfCodec'
import {
  isReservedFile,
  resolveLinkTarget,
  validateKnowledgeText,
  type BundleFile
} from './validate'
import {
  crowdedFolders,
  stampKnowledgeReview,
  type KnowledgeAdminOutcome,
  type KnowledgeCrowdedFolder,
  type KnowledgeEntryChangeRecord,
  type KnowledgeSubmission
} from './review'

export const KNOWLEDGE_TOOL_NAME = 'knowledge'

const ACTIONS = ['bases', 'search', 'list', 'read', 'submit', 'organize', 'migrate'] as const
export type KnowledgeAction = (typeof ACTIONS)[number]

/** 一次 `migrate` 最多点名多少条：每条的原文都进管理员那一轮的提示词，它还要逐条安放 */
export const KNOWLEDGE_MIGRATE_MAX_ENTRIES = 10
/** `migrate` 的目标库不对时补的一句：条目只能迁进发起迁移的那条会话自己的库 */
const MIGRATE_TARGET_HINT =
  '"migrate" brings entries into one of this session\'s own bases ("bases" lists them). To bring them into another project\'s base, the user asks from a session of that project.'
/** 一次 `migrate` 交给管理员的原文总量上限（字节） */
const MIGRATE_MAX_BYTES = 200 * 1024

export const KnowledgeParamsSchema = Type.Object({
  action: Type.Unsafe<KnowledgeAction>({
    type: 'string',
    enum: [...ACTIONS],
    description: 'See the tool description.'
  }),
  base: Type.Optional(
    Type.String({
      description:
        'A name from "bases". Required for "list", "read", "submit", "organize" and "migrate" (where the entries go); "search" without it covers every base.'
    })
  ),
  query: Type.Optional(Type.String({ description: 'For "search": free-text query.' })),
  entry: Type.Optional(
    Type.String({
      description:
        'An entry\'s path inside its base, as "search" and "list" give it. For "read": the entry to read. For "submit": the entry the submission corrects or extends, if any.'
    })
  ),
  project: Type.Optional(
    Type.String({
      description:
        'Another project, by its name: its own knowledge base. With "list", "search" or "read" it takes the place of `base`. With "migrate" it is the project the entries come from.'
    })
  ),
  entries: Type.Optional(
    Type.Array(Type.String(), {
      description: `For "migrate": the entries to bring over (at most ${KNOWLEDGE_MIGRATE_MAX_ENTRIES}), each by its path inside that project's base; a folder path takes every entry under it, and "/" is the whole base.`
    })
  ),
  content: Type.Optional(
    Type.String({
      description:
        'For "submit": what to record, in markdown. For "organize": what the user asked for in particular, if anything.'
    })
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
  project?: string
  entries?: string[]
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
- "submit": hand the base's librarian something a later session will need (\`content\`, markdown): the subject, what holds, and where each claim comes from (a path, URL or commit). When it corrects or extends an entry that "search", "list" or "read" showed you, name that \`entry\`. The librarian decides what the base keeps — a new entry, a change to existing ones, part of what you sent, or nothing — and says what it did and why.
- "organize": when the user wants a base tidied up, have its librarian go through all of it (\`base\`) — merging entries on the same subject, removing what has no lasting value, grouping the rest into folders. Put what the user asked for in particular in \`content\`. It says what it changed.
- "migrate": bring entries of another project's own base into one of this session's bases — \`project\` is the project they come from, \`entries\` their paths there, \`base\` where they go (a name from "bases"). ShuviX hands the librarian the entries as they are; do not copy their text. The librarian takes each one in, merges it or turns it down, and the ones it took are removed from the other project's base.

To see what another project's base holds — to choose what to migrate — pass \`project\` with "list", "search" or "read" in place of \`base\`. The user is asked before another project's base is read or changed.`

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
  /**
   * 另一个项目的项目库（`project` 参数）：按项目名解析。宿主不注入（扩展端）则 `project` 与 `migrate` 不可用。
   * 解析不出（没有这个项目、重名、就是本会话自己的项目）返回一句可读的 error。
   */
  resolveProjectBase?: (project: string) => Promise<KnowledgeBundleTarget | { error: string }>
  /**
   * 读（`read`）或改（`write` —— 迁移收尾要从里面删条目）另一个项目的库之前过宿主的门；那个库不在本会话的
   * 权限表里。被拒时抛错，文案给模型（不带库目录）。不注入 = 不设门（单测）。
   */
  authorizeProjectBase?: (
    target: KnowledgeBundleTarget,
    access: 'read' | 'write',
    ctx: KnowledgeProjectBaseAccess
  ) => Promise<void>
  /**
   * 迁移收尾：把管理员收下的条目从源库删掉（宿主记一笔变更、提交）。回没删成的那几条与原因。
   * 不注入则 `migrate` 不可用 —— 只收不删就成了两边各一份。
   */
  removeEntries?: (
    source: KnowledgeBundleTarget,
    entries: readonly string[],
    ctx: { call: ToolCallScope | undefined; movedTo: string }
  ) => Promise<Array<{ entry: string; reason: string }>>
  abortError?: string
  label: string
}

/** 过门时交给宿主的：这次调用是谁的，以及（迁移时）给人看的一句话 */
export interface KnowledgeProjectBaseAccess {
  call: ToolCallScope | undefined
  toolCallId: string
  signal?: AbortSignal
  /** 迁移：卡片上的一句说明（几条、从哪个库到哪个库） */
  purpose?: string
}

type Result = ToolResult<{ action: KnowledgeAction; path?: string } | undefined>

/** 派管理员之前库的样子：有哪些文件（库内相对路径）、各是什么原文，以及哪些文件夹已经挤了 */
interface BaseSnapshot {
  paths: ReadonlySet<string>
  texts: ReadonlySet<string>
  crowded: KnowledgeCrowdedFolder[]
}

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
        return this.search(params, admin, { call, toolCallId, signal })
      case 'list':
        return this.list(params, admin, { call, toolCallId, signal })
      case 'read':
        return this.read(params, admin, { call, toolCallId, signal })
      case 'submit':
        return this.submit(toolCallId, params, signal, call, admin)
      case 'organize':
        return this.organize(toolCallId, params, signal, call, admin)
      case 'migrate':
        return this.migrate(toolCallId, params, signal, call, admin)
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
   * `project` 给了：这次看的是那个项目的项目库（为挑要迁移的条目）。解析 → 过宿主的读门 → 交回目标；没给 → null。
   * 管理员自己不许用（它只动任务点名的那个库）。`base` 这时不看：`project` 顶替它，一起写了也照 `project` 的来
   * （实测模型常顺手把项目名也填进 `base`，为这个报错只是白费一次调用）。
   */
  private async projectBase(
    params: KnowledgeToolParams,
    admin: boolean,
    access: KnowledgeProjectBaseAccess
  ): Promise<KnowledgeBundleTarget | { error: string } | null> {
    const project = params.project?.trim()
    if (!project) return null
    if (admin) {
      throw new Error('You are the librarian: work only inside the base the task names.')
    }
    if (!this.deps.resolveProjectBase) {
      return { error: "Another project's knowledge base cannot be read on this host." }
    }
    const target = await this.deps.resolveProjectBase(project)
    if ('error' in target) return target
    await this.deps.authorizeProjectBase?.(target, 'read', access)
    return target
  }

  /**
   * `entry` → 库内相对路径（不带前导 `/`），且必须是这个库里一条**在册**的笔记（扫描见过的 md）。
   * 收 `/x.md`、`x.md`、省掉 `.md` 的写法；旧对话里留下的绝对路径（落在库目录里）也认。
   * 越界、隐藏路径、保留名、不在册一律拒 —— 只认扫描清单，所以库里的符号链接、隐藏目录从来够不着。
   */
  private async locateEntry(
    raw: string,
    target: KnowledgeBundleTarget,
    base: string,
    /** 报错里点名这个库的写法；缺省 `base "<base>"`（另一个项目的库写成 `the base of project "x"`） */
    where = `base "${base}"`
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
      `No entry ${entryLabel(rel)} in ${where} — "search" or "list" it for the right name`
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
  private async search(
    params: KnowledgeToolParams,
    admin: boolean,
    access: KnowledgeProjectBaseAccess
  ): Promise<Result> {
    const query = params.query?.trim()
    if (!query) throw new Error('"search" needs `query`')
    const limit = positiveLimit(params.limit, DEFAULT_LIMIT)
    const foreign = await this.projectBase(params, admin, access)
    if (foreign) {
      if ('error' in foreign) return text([foreign.error], { action: 'search' })
      const { total, lines } = await this.searchOne(foreign, query, limit)
      if (total === 0) {
        return text([`No entries match "${query}" in the base of ${foreign.label}.`], {
          action: 'search'
        })
      }
      return text(
        [`${total} result(s) for "${query}" in the base of ${foreign.label}:`, ...lines],
        { action: 'search' }
      )
    }
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

  private async list(
    params: KnowledgeToolParams,
    admin: boolean,
    access: KnowledgeProjectBaseAccess
  ): Promise<Result> {
    const limit = positiveLimit(params.limit, DEFAULT_LIMIT * 5)
    const foreign = await this.projectBase(params, admin, access)
    if (foreign && 'error' in foreign) return text([foreign.error], { action: 'list' })
    const base = foreign ? 'project' : this.requireBase(params)
    const resolved = foreign ?? (await this.deps.resolveBase(base))
    if ('error' in resolved) return text([resolved.error], { action: 'list' })
    const where = foreign
      ? `the base of ${foreign.label}`
      : `base "${base}" (${this.where(resolved, admin)})`
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
  private async read(
    params: KnowledgeToolParams,
    admin: boolean,
    access: KnowledgeProjectBaseAccess
  ): Promise<Result> {
    // 缺参先报 base、再报 entry（点了 `project` 就不需要 base）；都齐了才去解析、过门
    if (!params.project?.trim()) this.requireBase(params)
    const raw = params.entry?.trim()
    if (!raw) throw new Error('"read" needs `entry` — an entry\'s path inside the base')
    const foreign = await this.projectBase(params, admin, access)
    if (foreign && 'error' in foreign) throw new Error(foreign.error)
    const base = foreign ? 'project' : this.requireBase(params)
    const target = foreign ?? (await this.deps.resolveBase(base))
    if ('error' in target) throw new Error(target.error)
    const where = foreign ? `the base of ${foreign.label}` : undefined
    const { rel, scan } = await this.locateEntry(raw, target, base, where)
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
    const header = `Entry ${entryLabel(rel)} in ${where ?? `base "${base}" (${target.label})`} — ${total} lines`
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
    const before = await this.snapshot(target)
    const outcome = await this.deps.admin(
      {
        base,
        label: target.label,
        bundleDir: target.dir,
        content,
        ...(entry ? { entry } : {}),
        submittedBy,
        ...(before.crowded.length > 0 ? { crowded: before.crowded } : {})
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
      call,
      before
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

  /**
   * 整理：什么都不交，同步派管理员把这个库整个过一遍（合并、删掉没有长期价值的、按主题分文件夹）。它改写过的条目
   * 照提交那样盖章，只是 `generated` 记管理员自己 —— 合并出来的正文是它写的，不是发起整理的那个 agent；只是挪了
   * 位置的条目不盖（原文没变）。
   */
  private async organize(
    toolCallId: string,
    params: KnowledgeToolParams,
    signal: AbortSignal | undefined,
    call: ToolCallScope | undefined,
    admin: boolean
  ): Promise<Result> {
    if (admin) {
      throw new Error(
        'You are the librarian: reorganize the base yourself with the file tools, and answer with `next`.'
      )
    }
    const base = this.requireBase(params)
    const target = await this.deps.resolveBase(base)
    if ('error' in target) throw new Error(target.error)
    if (target.readonly) {
      throw new Error(
        `"${base}" is read-only — it is ShuviX's own reference, shipped with the app. Only the user's knowledge bases can be reorganized ("bases" lists them).`
      )
    }
    if (!this.deps.admin)
      throw new Error('Reorganizing a knowledge base is not available on this host')
    const before = await this.snapshot(target)
    if (before.paths.size === 0) {
      return text([`Base "${base}" has no entries yet — there is nothing to reorganize.`], {
        action: 'organize'
      })
    }
    const outcome = await this.deps.admin(
      {
        base,
        label: target.label,
        bundleDir: target.dir,
        content: params.content?.trim() ?? '',
        submittedBy: this.deps.actor(call),
        organize: true,
        ...(before.crowded.length > 0 ? { crowded: before.crowded } : {})
      },
      { call, toolCallId, signal }
    )
    if (signal?.aborted) throw new Error(this.deps.abortError ?? 'Aborted')
    if ('error' in outcome) {
      throw new Error(
        `The knowledge librarian could not reorganize the base: ${this.scrubDir(outcome.error, target)}`
      )
    }
    const report = this.scrubDir(outcome.report, target) || '(no report)'
    if (outcome.entries.length === 0) {
      return text([`Nothing was changed in base "${base}".`, '', report], { action: 'organize' })
    }
    const stamped = await this.stampChanged(
      outcome.entries,
      target,
      outcome.admin,
      outcome.admin,
      call,
      before
    )
    const lines = outcome.entries.map((e) => {
      const flag = stamped.problems.get(e.entry)
      return `- ${entryLabel(e.entry)} (${e.change}${flag ? `; ${flag}` : ''})`
    })
    const { notes } = await this.deps.scan(target.dir)
    return text(
      [
        `Reorganized base "${base}" — ${before.paths.size} file(s) before, ${notes.length} now:`,
        ...lines,
        '',
        report
      ],
      { action: 'organize' }
    )
  }

  /**
   * 派管理员之前库里有哪些文件、各是什么原文。之后它报上来的条目里，**路径是新的、原文却与当时某个文件一字不差**
   * 的就是只挪了位置（改名、按主题分进文件夹）：不盖章。
   */
  private async snapshot(target: KnowledgeBundleTarget): Promise<BaseSnapshot> {
    const { files, notes } = await this.deps.scan(target.dir)
    return {
      paths: new Set(files.map((f) => normalizeBundlePath(f.path))),
      texts: new Set(files.map((f) => f.text)),
      crowded: crowdedFolders(notes.map((n) => n.path))
    }
  }

  /**
   * 迁移：把另一个项目的项目库里点名的条目交给**目标库**的管理员。先后：
   *   准入（管理员自己、缺参数、目标库解析 / 只读、宿主不支持、源库解析、两头是同一个库）
   *   → 落定条目（扫描在册的；文件夹展开；不在册的记下）→ 过源库的写门（收下的要从那里删）
   *   → 派管理员（原文由这里读，不经发起者重抄）→ 给它动过的条目盖章 → 它点名收下的从源库删掉 → 断链只报告。
   * 管理员没跑成、或说一条都不收：源库一个字不动。它没点名的条目留在源库 —— 宁可两边各一份，不丢。
   */
  private async migrate(
    toolCallId: string,
    params: KnowledgeToolParams,
    signal: AbortSignal | undefined,
    call: ToolCallScope | undefined,
    admin: boolean
  ): Promise<Result> {
    if (admin) {
      throw new Error(
        'You are the librarian: record the entries the task gives you with the file tools, and answer with `next`.'
      )
    }
    const project = params.project?.trim()
    if (!project) {
      throw new Error('"migrate" needs `project` — the project whose base the entries come from')
    }
    const wanted = [
      ...new Set(
        (Array.isArray(params.entries) ? params.entries : [])
          .filter((e): e is string => typeof e === 'string')
          .map((e) => e.trim())
          .filter(Boolean)
      )
    ]
    if (wanted.length === 0) {
      throw new Error(
        '"migrate" needs `entries` — the paths of the entries to bring over, as "list" or "search" with `project` shows them'
      )
    }
    const base = this.requireBase(params)
    const target = await this.deps.resolveBase(base)
    if ('error' in target) throw new Error(`${target.error} ${MIGRATE_TARGET_HINT}`)
    if (target.readonly) {
      throw new Error(
        `"${base}" is read-only — it is ShuviX's own reference, shipped with the app. ${MIGRATE_TARGET_HINT}`
      )
    }
    const { admin: runAdmin, resolveProjectBase, removeEntries } = this.deps
    if (!runAdmin || !resolveProjectBase || !removeEntries) {
      throw new Error('Migrating knowledge entries is not available on this host')
    }
    const source = await resolveProjectBase(project)
    if ('error' in source) throw new Error(source.error)
    if (stripDir(source.dir) === stripDir(target.dir)) {
      throw new Error(
        `The base of ${source.label} is base "${base}" itself — there is nothing to migrate.`
      )
    }
    const from = `the base of ${source.label}`

    // 落定条目：扫描在册的笔记；点名一个文件夹就是它底下的每一条
    const scan = await this.deps.scan(source.dir)
    const known = scan.notes.map((n) => n.path)
    const knownSet = new Set(known)
    const picked: string[] = []
    const missing: string[] = []
    for (const raw of wanted) {
      const rel = normalizeBundlePath(raw.replace(/\\/g, '/'))
      // `/` = 整个库（实测模型要迁整个库时就这么写）
      if (/^[./\\]+$/.test(raw) && !raw.includes('..')) picked.push(...known)
      else if (!rel || escapesBundle(rel)) missing.push(raw)
      else if (knownSet.has(rel)) picked.push(rel)
      else if (!/\.md$/i.test(rel) && knownSet.has(`${rel}.md`)) picked.push(`${rel}.md`)
      else {
        const under = known.filter((path) => path.startsWith(`${rel}/`))
        if (under.length > 0) picked.push(...under)
        else missing.push(entryLabel(rel))
      }
    }
    const entries = [...new Set(picked)]
    if (entries.length === 0) {
      throw new Error(
        `None of these is an entry in ${from}: ${missing.join(', ')} — "list" it with \`project\` for the right names`
      )
    }
    if (entries.length > KNOWLEDGE_MIGRATE_MAX_ENTRIES) {
      throw new Error(
        `That is ${entries.length} entries; one "migrate" takes at most ${KNOWLEDGE_MIGRATE_MAX_ENTRIES}. Bring them over in several calls.`
      )
    }
    const textOf = new Map(scan.files.map((f) => [f.path, f.text]))
    const migrated = entries.map((entry) => ({ entry, text: textOf.get(entry) ?? '' }))
    const bytes = migrated.reduce((n, e) => n + new TextEncoder().encode(e.text).length, 0)
    if (bytes > MIGRATE_MAX_BYTES) {
      throw new Error(
        `These entries are ${formatSize(bytes)} together; one "migrate" takes at most ${formatSize(MIGRATE_MAX_BYTES)}. Bring fewer over per call.`
      )
    }

    // 收下的条目之后要从源库删掉：先过它的写门（用户点头的是这一整件事）。被拒时把话说全 —— 宿主那句只说「拒了
    // 访问某个库」，实测模型会当成读被拒、或再来一次
    try {
      await this.deps.authorizeProjectBase?.(source, 'write', {
        call,
        toolCallId,
        signal,
        purpose: `Migrate ${entries.length} knowledge entr${entries.length === 1 ? 'y' : 'ies'} from ${source.label} into base "${base}" (${target.label}). The ones the librarian takes in are removed from ${source.label}.`
      })
    } catch (err) {
      if (signal?.aborted) throw err
      const why = err instanceof Error ? err.message : String(err)
      throw new Error(
        `${why}\nThat was the permission to change ${from}: migrated entries are removed from it. Nothing was migrated; do not try again unless the user asks.`
      )
    }
    if (signal?.aborted) throw new Error(this.deps.abortError ?? 'Aborted')

    const submittedBy = this.deps.actor(call)
    const before = await this.snapshot(target)
    const outcome = await runAdmin(
      {
        base,
        label: target.label,
        bundleDir: target.dir,
        content: '',
        submittedBy,
        migration: { from: source.label, entries: migrated }
      },
      { call, toolCallId, signal }
    )
    if (signal?.aborted) throw new Error(this.deps.abortError ?? 'Aborted')
    if ('error' in outcome) {
      throw new Error(
        `The knowledge librarian could not take the entries: ${this.scrubDir(outcome.error, target)}. Nothing was removed from ${from}.`
      )
    }
    const report = this.scrubDir(outcome.report, target) || '(no report)'
    if (!outcome.accepted) {
      return text(
        [`Nothing was migrated into base "${base}"; the entries stay in ${from}.`, '', report],
        { action: 'migrate' }
      )
    }

    // 只认它点名收下、且确是这次交过去的那几条（名字省了 `.md` 也认）
    const named = new Set(
      (outcome.taken ?? []).map((t) => (entries.includes(t) || /\.md$/i.test(t) ? t : `${t}.md`))
    )
    const taken = entries.filter((e) => named.has(e))
    const left = entries.filter((e) => !named.has(e))

    const stamped = await this.stampChanged(
      outcome.entries,
      target,
      submittedBy,
      outcome.admin,
      call,
      before
    )
    const failed =
      taken.length > 0 ? await removeEntries(source, taken, { call, movedTo: target.label }) : []
    const failedReason = new Map(failed.map((f) => [normalizeBundlePath(f.entry), f.reason]))
    const removed = taken.filter((e) => !failedReason.has(e))

    // 源库里留下的条目指向被删掉的：只报告，不改写正文
    const gone = new Set(removed)
    const broken: string[] = []
    for (const file of scan.files) {
      if (gone.has(file.path)) continue
      for (const link of extractConceptLinks(bodyOf(file.text))) {
        const to = resolveLinkTarget(file.path, link.path)
        if (to && gone.has(to)) broken.push(`- ${entryLabel(file.path)} → ${entryLabel(to)}`)
      }
    }

    const changes = outcome.entries.map((e) => {
      const flag = stamped.problems.get(e.entry)
      return `- ${entryLabel(e.entry)} (${e.change}${flag ? `; ${flag}` : ''})`
    })
    const lines = [
      `Migrated into base "${base}" from ${from}${changes.length ? ':' : '.'}`,
      ...changes
    ]
    lines.push(
      '',
      removed.length > 0
        ? `Removed from ${from}: ${removed.map(entryLabel).join(', ')}.`
        : `Nothing was removed from ${from}.`
    )
    if (left.length > 0) {
      lines.push(
        `Left in ${from} (the librarian did not take them): ${left.map(entryLabel).join(', ')}.`
      )
    }
    if (missing.length > 0) lines.push(`Not found in ${from}: ${missing.join(', ')}.`)
    if (failedReason.size > 0) {
      lines.push(
        `Taken in but still in ${from}: ${[...failedReason].map(([e, why]) => `${entryLabel(e)} (${why})`).join(', ')}.`
      )
    }
    if (broken.length > 0) {
      lines.push(`Links in ${from} that now point at removed entries:`, ...[...new Set(broken)])
    }
    lines.push('', report)
    return text(lines, {
      action: 'migrate',
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
   *
   * `before`：派管理员之前库的样子。路径是新的、原文却与当时某个文件一字不差的条目不盖 —— 它只是被挪了位置
   * （改名、按主题分进文件夹），内容不是这次写下的；盖了会把 `generated` 改成这次的提交者，人工核实过的条目随之
   * 变成「核实后又改过」。
   */
  private async stampChanged(
    entries: readonly KnowledgeEntryChangeRecord[],
    target: KnowledgeBundleTarget,
    submittedBy: string,
    adminActor: string,
    call: ToolCallScope | undefined,
    before?: BaseSnapshot
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
      if (before && !before.paths.has(rel) && before.texts.has(current)) continue
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
