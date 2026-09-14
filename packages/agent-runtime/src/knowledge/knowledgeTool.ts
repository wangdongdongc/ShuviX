/**
 * `knowledge` 工具 —— 知识库的检索、盘点、取原文、校验，以及**新建条目**。
 *
 * 写入面**只有新建**，改动一律走普通 `edit`。这是两轮取舍之后的折中：
 *   - 新建交给宿主，是为了**担保元数据的形状** —— 自述行 `shuvix: okf v0.2`（属性卡的识别
 *     依据，少了它笔记本渲染不出卡）、固定键序、`type` 与 `status` 归一、`generated` 由宿主盖、
 *     `sources` 归一。让模型自己拼 frontmatter 就得把这张表塞进每会话
 *     必付的提示词，而且少一个键就少一份卡。
 *   - 改动交给 `edit`，是因为工具做不了局部编辑：给一条长条目补一段话，`edit` 三行 diff 够了，
 *     而工具那套只能整篇正文重发。改动路径与社区 skill、人工编辑同一条 —— 写钩子回执诊断并
 *     刷新 `generated`，变更管线投影 index/log、提交、广播。
 *
 * 新建还顺带解决两件寻址问题：库是懒建的（agent 直写一个不存在的目录会造出没有 `project.md`
 * 的半拉 bundle，下一次解析又建一个 `-2`），以及文件名去重（模型挑中已有名字时 `write` 会
 * 静默覆盖）。两件都由宿主在 `create` 里做掉，agent 从不需要知道库在哪。
 *
 * 安全：`create` 以目标绝对路径走 `enforcePath('write')`、`read` / `validate` 走
 * `enforcePath('read')` —— 与文件工具同一道门，将来给知识库写策略时两侧一起被盖住。
 *
 * **除 `bases` 外每个动作都必须点名一个 base**：`project` 是本会话所属项目的库，其余名字是用户
 * 自己的知识库（所有会话都看得见）。用户库是后面主推的形态，所以刻意**不给默认值** —— 一旦缺省
 * 落到项目库，agent 就永远想不起用户库。目标由宿主解析（`resolveBase`），路径一律是该 bundle 内
 * 的相对路径；跨 bundle 的引用不走路径而走 `shuvix://` URI。
 *
 * 宿主无关：文件经 FileSystemPort，库的解析 / 列举 / 扫描 / 检索全部注入。
 */
import { Type } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import {
  KNOWLEDGE_PROJECT_BASE,
  KNOWLEDGE_TYPES,
  OKF_STATUSES,
  type OkfStatus
} from '@shuvix/chat-protocol/knowledge'
import type { FileSystemPort } from '../fileTools/port'
import type { SecurityContext } from '../security/types'
import { BaseTool } from '../tools/baseTool'
import {
  buildConceptText,
  isVerificationCurrent,
  normalizeSources,
  type KnowledgeConcept,
  type KnowledgeSource
} from './conceptFile'
import { dedupeFileName, escapesBundle, normalizeBundlePath, slugify } from './bundlePaths'
import {
  isReservedFile,
  validateBundleFiles,
  validateConceptText,
  type BundleFile
} from './validate'

export const KNOWLEDGE_TOOL_NAME = 'knowledge'

const ACTIONS = ['bases', 'search', 'list', 'read', 'create', 'validate'] as const
export type KnowledgeAction = (typeof ACTIONS)[number]

export const KnowledgeParamsSchema = Type.Object({
  action: Type.Unsafe<KnowledgeAction>({
    type: 'string',
    enum: [...ACTIONS],
    description: 'What to do. See the tool description for what each action does.'
  }),
  base: Type.Optional(
    Type.String({
      description:
        'Which knowledge base: "project" for the knowledge base of the project this session belongs to, or the name of one of the user\'s own knowledge bases (call "bases" to list them). Required for every action except "bases".'
    })
  ),
  query: Type.Optional(Type.String({ description: 'For "search": free-text query.' })),
  path: Type.Optional(
    Type.String({
      description:
        'Bundle-relative path of an existing entry, e.g. "/token-refresh.md". Required for "read"; for "validate" it narrows the check to one entry.'
    })
  ),
  type: Type.Optional(
    Type.String({
      description: `For "create": the entry type — one of ${KNOWLEDGE_TYPES.join(' / ')} (other values are allowed). Required.`
    })
  ),
  title: Type.Optional(
    Type.String({ description: 'For "create": display title; the file name is derived from it.' })
  ),
  description: Type.Optional(
    Type.String({
      description:
        'For "create": ONE line saying when this entry is worth opening — it is what the index shows and how later sessions decide to read it.'
    })
  ),
  body: Type.Optional(
    Type.String({
      description:
        'For "create": the entry itself in markdown (the knowledge, not the metadata). Link other entries with bundle-absolute markdown links like [title](/auth/session.md).'
    })
  ),
  tags: Type.Optional(Type.Array(Type.String(), { description: 'For "create": tags.' })),
  sources: Type.Optional(
    Type.Array(
      Type.Object({
        resource: Type.String({
          description:
            'Self-contained locator: absolute path (optionally with #symbol), full URL, <remote-url>@<commit>:<path>, or shuvix://session/<id>.'
        }),
        title: Type.Optional(Type.String()),
        id: Type.Optional(Type.String({ description: 'Short id for footnote citations [^id].' }))
      }),
      { description: 'For "create": where the entry\'s claims come from.' }
    )
  ),
  stale_after: Type.Optional(
    Type.String({
      description:
        'For "create": ISO date (YYYY-MM-DD) after which the entry needs re-verification.'
    })
  ),
  status: Type.Optional(
    Type.Unsafe<OkfStatus>({
      type: 'string',
      enum: [...OKF_STATUSES],
      description:
        'For "create": the entry lifecycle — "stable" (the default) once it is ready to be relied on, "draft" while it is still incomplete, "deprecated" for something kept only for its links and history.'
    })
  ),
  limit: Type.Optional(
    Type.Number({ description: 'For "search" / "list": max results (default 20).' })
  )
})

export interface KnowledgeToolParams {
  action: KnowledgeAction
  base?: string
  query?: string
  path?: string
  type?: string
  title?: string
  description?: string
  body?: string
  tags?: string[]
  sources?: { resource: string; title?: string; id?: string }[]
  stale_after?: string
  status?: OkfStatus
  limit?: number
}

export const KNOWLEDGE_DESCRIPTION = `Search, read, check and add to knowledge bases — OKF bundles of markdown entries that later sessions read.

Every action except "bases" names its knowledge base with \`base\`:
- \`"project"\` — the knowledge base of the project this session belongs to.
- any other name — one of the user's own knowledge bases. The user builds these on purpose and expects them to be used: when a subject belongs in one of them, search and record there rather than in the project's. Call "bases" to see which exist.

Actions:
- "bases": list the knowledge bases you can name (no other parameters).
- "search": find entries by free text (\`query\`, optional \`limit\`).
- "list": list the entries of the base.
- "read": return one entry by \`path\`.
- "create": add a new entry — \`type\`, \`title\`, \`description\`, \`body\`, optional \`tags\` / \`sources\` / \`stale_after\` / \`status\`. The host assembles the metadata, names the file after the title, and answers with the absolute path it wrote.
- "validate": report problems in one entry (\`path\`) or in the whole base (no \`path\`). Run it after editing an entry.

**Create entries here, change them with \`edit\`.** Only "create" writes through this tool; to revise an existing entry, \`edit\` the file at the absolute path that "search" / "list" / "read" / "create" gave you — a surgical diff beats re-sending the whole body. Never create an entry with \`write\`: the metadata (the self-description line, the key order, \`generated\`) would be yours to get right.

The metadata the host owns in every entry it writes: the \`shuvix\` self-description and \`generated\`. \`status\` is the entry's lifecycle and yours to judge — \`stable\` (the default) once it is ready to be relied on, \`draft\` while it is still incomplete, \`deprecated\` when it is superseded or wrong. \`verified\` is a different axis: the user's record of having checked the entry — **never write it**. \`index.md\` and \`log.md\` are host projections: read them, never write them.

Paths in this tool are relative to the base, e.g. "/token-refresh.md"; every listing names the base's absolute directory, which is what \`edit\` needs. To point at something in another base, use a \`shuvix://\` URI instead of a path.

Record what will be looked up again: decisions and why they went that way, pitfalls, conventions the code does not state, facts that took effort to establish. Search before creating and revise the entry that already covers the subject rather than adding a near-duplicate. Do not record what the repository already states, or what only matters to this conversation.`

/** 宿主解析出的目标 bundle */
export interface KnowledgeBundleTarget {
  /** bundle 根的绝对路径（桌面）/ 句柄路径（扩展） */
  dir: string
  /** 人读标签，如 `project "Acme Corp"` */
  label: string
}

export interface KnowledgeSearchHit {
  path: string
  title: string
  description?: string
  status?: string
  snippet?: string
}

/** 宿主的一次 bundle 扫描（带缓存）：全部 md 原文 + 解析成功的概念 */
export interface KnowledgeBundleScan {
  files: readonly BundleFile[]
  concepts: readonly KnowledgeConcept[]
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
   * 解析一个 base。`project` 在 `create` 为真时尚不存在由宿主建出（目录 + 绑定概念 + git init）；
   * 用户库从不由宿主建出。解析不出（会话不属于项目 / 没有这个库）返回一句可读的 error。
   */
  resolveBase: (
    base: string,
    opts: { create: boolean }
  ) => Promise<KnowledgeBundleTarget | { error: string }>
  /** 本会话可以点名的全部库（`project` 在前） */
  listBases: () => Promise<readonly KnowledgeBaseInfo[]>
  /** 该 bundle 的扫描结果（宿主缓存；路径 bundle 相对） */
  scan: (bundleDir: string) => Promise<KnowledgeBundleScan>
  /** 该 bundle 内的检索 */
  search?: (
    query: string,
    opts: { limit: number; bundleDir: string }
  ) => Promise<KnowledgeSearchHit[]>
  /** 写入者 actor 字符串（OKF §5.2：`shuvix-<profile>/<model>`）—— create 盖 `generated` 用 */
  actor: () => string
  now: () => Date
  /**
   * 新建之后（投影 / 提交 / 事件由宿主完成）；`path` 是 `bundleDir` 内的相对路径。
   * 只有 create 这一条路要它 —— `edit` 走文件工具，那边自有 onFileChange 接同一条管线。
   */
  afterWrite?: (e: { bundleDir: string; path: string; title: string }) => void | Promise<void>
  abortError?: string
  label: string
}

type Result = AgentToolResult<{ action: KnowledgeAction; path?: string } | undefined>

const DEFAULT_LIMIT = 20

function text(lines: string[], details?: { action: KnowledgeAction; path?: string }): Result {
  // 不过滤空串：read 用一行空行隔开表头与原文（过滤会把那一行吃掉）
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    details
  }
}

function joinRoot(root: string, rel: string): string {
  const base = root.replace(/[/\\]+$/, '')
  return `${base}/${rel}`
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

function summaryLine(c: KnowledgeConcept): string {
  const marks: string[] = []
  if (c.status !== 'stable') marks.push(c.status)
  if (c.verified.length > 0 && isVerificationCurrent(c)) marks.push('verified')
  const date = c.generated?.at?.slice(0, 10)
  if (date) marks.push(date)
  const mark = marks.length ? ` (${marks.join(', ')})` : ''
  return `- /${c.path}${mark} — ${c.description || c.title}`
}

/** 表头恒点名 bundle 的绝对目录 —— agent 要拿它拼出 write/edit 用的绝对路径 */
function whereLine(target: KnowledgeBundleTarget): string {
  return `${target.label} — ${target.dir}`
}

export class KnowledgeTool extends BaseTool<typeof KnowledgeParamsSchema> {
  readonly name = KNOWLEDGE_TOOL_NAME
  readonly label: string
  readonly description = KNOWLEDGE_DESCRIPTION
  readonly parameters = KnowledgeParamsSchema

  constructor(private readonly deps: KnowledgeToolDeps) {
    super()
    this.label = deps.label
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    /* 逐 action 在 executeInternal 里按已解析的路径过 PEP */
  }

  protected async executeInternal(
    toolCallId: string,
    params: KnowledgeToolParams,
    signal?: AbortSignal
  ): Promise<Result> {
    if (signal?.aborted) throw new Error(this.deps.abortError ?? 'Aborted')
    switch (params.action) {
      case 'bases':
        return this.bases()
      case 'search':
        return this.search(params)
      case 'list':
        return this.list(params)
      case 'read':
        return this.read(toolCallId, params)
      case 'create':
        return this.create(toolCallId, params)
      case 'validate':
        return this.validate(toolCallId, params)
      default:
        throw new Error(`Unknown action "${String(params.action)}". Valid: ${ACTIONS.join(', ')}`)
    }
  }

  // ─── 路径与准入 ─────────────────────────────────────────────

  /** 参数里的 bundle 路径 → 归一相对路径；越界 / 非 .md 一律拒绝（保留文件可读可校验） */
  private bundlePath(raw: string): string {
    const rel = normalizeBundlePath(raw)
    if (!rel || escapesBundle(rel))
      throw new Error(`Path "${raw}" is not inside the knowledge base`)
    if (!/\.md$/i.test(rel)) throw new Error(`Path "${raw}" is not a markdown entry (.md)`)
    return rel
  }

  private async enforce(
    mode: 'read' | 'write',
    bundleDir: string,
    rel: string,
    toolCallId: string,
    action: string
  ): Promise<void> {
    await this.deps.security.enforcePath(mode, joinRoot(bundleDir, rel), {
      toolCallId,
      toolName: this.name,
      displayPath: `/${rel}`,
      abortError: this.deps.abortError ?? 'Aborted',
      operation: action
    })
  }

  private async exists(bundleDir: string, rel: string): Promise<boolean> {
    return (await this.deps.port.stat(joinRoot(bundleDir, rel))) !== null
  }

  /** 参数里的 base：除 `bases` 外每个动作都必须带 */
  private requireBase(params: KnowledgeToolParams): string {
    const base = params.base?.trim()
    if (!base) {
      throw new Error(
        `"${params.action}" needs \`base\` — "${KNOWLEDGE_PROJECT_BASE}" for this project's knowledge base, or the name of one of the user's (call "bases" to list them)`
      )
    }
    return base
  }

  /** 目标 bundle；解析不出（会话不属于项目 / 没有这个库）抛可读错误 */
  private async bundle(
    params: KnowledgeToolParams,
    create: boolean
  ): Promise<KnowledgeBundleTarget> {
    const target = await this.deps.resolveBase(this.requireBase(params), { create })
    if ('error' in target) throw new Error(target.error)
    return target
  }

  // ─── actions ───────────────────────────────────────────────

  private async bases(): Promise<Result> {
    const bases = await this.deps.listBases()
    const lines = bases.map(
      (b) => `- ${b.base} — ${b.label}${b.dir ? ` — ${b.dir}` : ''}${b.note ? ` (${b.note})` : ''}`
    )
    const userCount = bases.filter((b) => b.base !== KNOWLEDGE_PROJECT_BASE).length
    return text(
      [
        'Knowledge bases (pass the name as `base`):',
        ...lines,
        ...(userCount === 0 ? ['The user has no knowledge bases of their own yet.'] : [])
      ],
      { action: 'bases' }
    )
  }

  private async search(params: KnowledgeToolParams): Promise<Result> {
    const query = params.query?.trim()
    if (!query) throw new Error('"search" needs `query`')
    const limit = params.limit ?? DEFAULT_LIMIT
    // base 解析不出（会话不属于任何项目 / 没有这个库）对检索是软条件：回文字不抛错，与 list 同口径
    const resolved = await this.deps.resolveBase(this.requireBase(params), { create: false })
    if ('error' in resolved) return text([resolved.error], { action: 'search' })
    const bundleDir = resolved.dir
    if (this.deps.search) {
      const hits = await this.deps.search(query, { limit, bundleDir })
      if (hits.length === 0) return text([`No entries match "${query}".`], { action: 'search' })
      return text(
        [
          `${hits.length} result(s) for "${query}" in ${whereLine(resolved)}:`,
          ...hits.map(
            (h) =>
              `- /${normalizeBundlePath(h.path)}${h.status && h.status !== 'stable' ? ` (${h.status})` : ''} — ${h.description || h.title}${h.snippet ? `\n  ${h.snippet}` : ''}`
          )
        ],
        { action: 'search' }
      )
    }
    const needle = query.toLowerCase()
    const concepts = (await this.deps.scan(bundleDir)).concepts.filter(
      (c) =>
        c.status !== 'deprecated' &&
        [c.title, c.description, c.tags.join(' '), c.body].some((s) =>
          s.toLowerCase().includes(needle)
        )
    )
    if (concepts.length === 0) return text([`No entries match "${query}".`], { action: 'search' })
    return text(
      [
        `${concepts.length} result(s) for "${query}" in ${whereLine(resolved)}:`,
        ...concepts.slice(0, limit).map(summaryLine)
      ],
      { action: 'search' }
    )
  }

  private async list(params: KnowledgeToolParams): Promise<Result> {
    const limit = params.limit ?? DEFAULT_LIMIT * 5
    const resolved = await this.deps.resolveBase(this.requireBase(params), { create: false })
    if ('error' in resolved) return text([resolved.error], { action: 'list' })
    const { concepts } = await this.deps.scan(resolved.dir)
    if (concepts.length === 0) {
      return text([`No entries in ${whereLine(resolved)} yet.`], { action: 'list' })
    }
    const lines = concepts.slice(0, limit).map(summaryLine)
    if (concepts.length > limit) lines.push(`- … ${concepts.length - limit} more`)
    return text(
      [
        `${concepts.length} entr${concepts.length === 1 ? 'y' : 'ies'} in ${whereLine(resolved)}:`,
        ...lines
      ],
      { action: 'list' }
    )
  }

  private async read(toolCallId: string, params: KnowledgeToolParams): Promise<Result> {
    if (!params.path) throw new Error('"read" needs `path`')
    const rel = this.bundlePath(params.path)
    const target = await this.bundle(params, false)
    await this.enforce('read', target.dir, rel, toolCallId, params.action)
    if (!(await this.exists(target.dir, rel))) throw new Error(`No entry at /${rel}`)
    const raw = await this.deps.port.readFile(joinRoot(target.dir, rel))
    return text([`${joinRoot(target.dir, rel)}:`, '', raw.trimEnd()], {
      action: 'read',
      path: rel
    })
  }

  /**
   * 一条或整个 bundle 的诊断（不写盘）。整库校验多一项逐文件规则给不出的东西：
   * 正文里的条目链接是否解析得到。
   */
  private async validate(toolCallId: string, params: KnowledgeToolParams): Promise<Result> {
    const target = await this.bundle(params, false)
    if (params.path) {
      const rel = this.bundlePath(params.path)
      await this.enforce('read', target.dir, rel, toolCallId, params.action)
      if (!(await this.exists(target.dir, rel))) throw new Error(`No entry at /${rel}`)
      const raw = await this.deps.port.readFile(joinRoot(target.dir, rel))
      const diagnostics = validateConceptText(raw, rel)
      if (diagnostics.length === 0)
        return text([`/${rel}: no issues.`], { action: 'validate', path: rel })
      return text(
        [
          `${diagnostics.length} issue(s) in /${rel}:`,
          ...diagnostics.map((d) => `- [${d.level}] ${d.message}`)
        ],
        { action: 'validate', path: rel }
      )
    }

    await this.deps.security.enforcePath('read', target.dir, {
      toolCallId,
      toolName: this.name,
      displayPath: '/',
      abortError: this.deps.abortError ?? 'Aborted',
      operation: params.action
    })
    const { files } = await this.deps.scan(target.dir)
    const { diagnostics } = validateBundleFiles(files)
    if (diagnostics.length === 0) {
      return text([`${files.length} file(s) in ${whereLine(target)}: no issues.`], {
        action: 'validate'
      })
    }
    const byPath = new Map<string, string[]>()
    for (const d of diagnostics) {
      const list = byPath.get(d.path) ?? []
      list.push(`  - [${d.level}] ${d.message}`)
      byPath.set(d.path, list)
    }
    const lines: string[] = []
    for (const [path, messages] of byPath) {
      lines.push(`- /${path}`, ...messages)
    }
    return text(
      [
        `${diagnostics.length} issue(s) across ${byPath.size} file(s) in ${whereLine(target)}:`,
        ...lines
      ],
      { action: 'validate' }
    )
  }

  /**
   * 新建一条 —— 宿主拼 frontmatter（自述行 / 键序 / 归一 / `status` / `generated`）、按标题派生
   * 文件名并去重；`project` 库不存在时由宿主建出来（用户库从不建）。回执给**绝对路径**：同一轮里紧接着要 `edit`
   * 它，或者下一轮从 search 的表头再拼一次。
   *
   * 本期新条目一律落在 bundle 根 —— 没有 agent 可选的子目录层级。
   */
  private async create(toolCallId: string, params: KnowledgeToolParams): Promise<Result> {
    const type = params.type?.trim()
    const title = params.title?.trim()
    const description = params.description?.trim()
    const body = params.body
    const missing = [
      !params.base?.trim() && 'base',
      !type && 'type',
      !title && 'title',
      !description && 'description',
      !body?.trim() && 'body'
    ].filter(Boolean)
    if (missing.length) throw new Error(`Creating an entry needs: ${missing.join(', ')}`)

    const target = await this.bundle(params, true)
    const { concepts, files } = await this.deps.scan(target.dir)
    // 保留文件名同样算占用：slugify('Index') 正好撞上宿主投影的 index.md
    const taken = new Set<string>([
      ...concepts.filter((c) => dirOf(c.path) === '').map((c) => c.path),
      ...files.filter((f) => dirOf(f.path) === '').map((f) => f.path)
    ])
    const isTaken = (name: string): boolean => taken.has(name) || isReservedFile(name)
    let rel = dedupeFileName(`${slugify(title!)}.md`, isTaken)
    // 扫描可能没见过磁盘上的某个文件（缓存未刷新）—— 再确认一次，绝不覆盖既有条目
    if (await this.exists(target.dir, rel)) {
      rel = dedupeFileName(`${slugify(title!)}.md`, (name) => isTaken(name) || name === rel)
      if (await this.exists(target.dir, rel)) {
        throw new Error(`Could not find an unused file name for "${title}" — pick another title`)
      }
    }

    await this.enforce('write', target.dir, rel, toolCallId, params.action)

    const sources: KnowledgeSource[] = params.sources ? normalizeSources(params.sources) : []
    const content = buildConceptText(
      {
        type: type!,
        title: title!,
        description,
        tags: params.tags,
        // 生命周期由写的人判断，缺省即 OKF 的缺省（absent ⇒ stable）；
        // 「谁核实过」是另一根轴，由 `verified` 承担 —— 规范明说两者各自变动
        status: params.status ?? 'stable',
        staleAfter: params.stale_after,
        sources,
        generated: { by: this.deps.actor(), at: this.deps.now().toISOString() }
      },
      body!
    )
    await this.deps.port.writeFile(joinRoot(target.dir, rel), content)
    await this.deps.afterWrite?.({ bundleDir: target.dir, path: rel, title: title! })

    const warnings = validateConceptText(content, rel)
      .filter((d) => d.level === 'warning')
      .map((d) => `- ${d.message}`)
    return text(
      [
        `Created ${joinRoot(target.dir, rel)} (${params.status ?? 'stable'}). Revise it with \`edit\` at that path.`,
        ...(warnings.length ? ['Notes:', ...warnings] : [])
      ],
      { action: 'create', path: rel }
    )
  }
}

export function createKnowledgeTool(deps: KnowledgeToolDeps): KnowledgeTool {
  return new KnowledgeTool(deps)
}
