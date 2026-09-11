/**
 * `knowledge` 工具 —— 知识库的**读侧**面：检索、盘点、取原文、校验、寻址。
 *
 * 它不写文件。条目由 agent 用普通 `write` / `edit` 写出来，走的是和社区 skill、人工编辑
 * 完全相同的那条路：写钩子（shuvixMdWrite 的 OKF 分支）回执诊断并盖 `generated`，
 * 变更管线投影 index/log、提交、广播。**一条写入路而不是两条** —— 两条并存时不变量只写在
 * 强的那条里，而 agent 手上恰好有弱的那条，等于没写。
 *
 * 于是本工具只保留文件工具做不到的四件事：
 *   - `search` / `list`：宿主的检索索引与带缓存的扫描（agent 不知道库在哪，grep 不出来）；
 *   - `read`：按 bundle 相对路径取原文；
 *   - `validate`：写完之后当场知道自己写废了没有（不写盘）；
 *   - `locate`：**寻址** —— 库的绝对目录，以及给定标题时一个没被占用的新条目路径。
 *     库还不存在时由宿主建出（目录 + 绑定概念 + git init），避免 agent 直写出一个没有
 *     `project.md` 的半拉 bundle，让下一次解析又建一个 `-2`。
 *
 * 安全：`read` / `validate` 以目标绝对路径走 `enforcePath('read')`。`locate` 自己不过 PEP ——
 * 它不写条目，真正的写入由 write/edit 那道门管；宿主建 bundle 是宿主动作（actor
 * `process:shuvix`），与改动前 write 先解析后过门的次序一致。
 *
 * **作用域就是一个 bundle**：本会话所属项目的那一个。工具因此没有 `scope` 参数 —— 目标由
 * 宿主按会话解析（`resolveBundle`），路径一律是该 bundle 内的相对路径。跨 bundle 的引用不走
 * 路径而走 `shuvix://` URI。
 *
 * 宿主无关：文件经 FileSystemPort，bundle 解析 / 扫描 / 检索全部注入。
 */
import { Type } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { KNOWLEDGE_TYPES } from '@shuvix/chat-protocol/knowledge'
import type { FileSystemPort } from '../fileTools/port'
import type { SecurityContext } from '../security/types'
import { BaseTool } from '../tools/baseTool'
import { isVerificationCurrent, type KnowledgeConcept } from './conceptFile'
import { dedupeFileName, escapesBundle, normalizeBundlePath, slugify } from './bundlePaths'
import {
  isReservedFile,
  validateBundleFiles,
  validateConceptText,
  type BundleFile
} from './validate'

export const KNOWLEDGE_TOOL_NAME = 'knowledge'

const ACTIONS = ['search', 'list', 'read', 'validate', 'locate'] as const
export type KnowledgeAction = (typeof ACTIONS)[number]

export const KnowledgeParamsSchema = Type.Object({
  action: Type.Unsafe<KnowledgeAction>({
    type: 'string',
    enum: [...ACTIONS],
    description: 'What to do. See the tool description for what each action does.'
  }),
  query: Type.Optional(Type.String({ description: 'For "search": free-text query.' })),
  path: Type.Optional(
    Type.String({
      description:
        'Bundle-relative path of an existing entry, e.g. "/token-refresh.md". Required for "read"; for "validate" it narrows the check to one entry.'
    })
  ),
  title: Type.Optional(
    Type.String({
      description:
        'For "locate": the title of the entry you are about to create — the answer is an unused file path derived from it. Nothing is written.'
    })
  ),
  limit: Type.Optional(
    Type.Number({ description: 'For "search" / "list": max results (default 20).' })
  )
})

export interface KnowledgeToolParams {
  action: KnowledgeAction
  query?: string
  path?: string
  title?: string
  limit?: number
}

export const KNOWLEDGE_DESCRIPTION = `Search, read and check this project's knowledge base — an OKF bundle of markdown entries that later sessions of the same project will read.

Actions:
- "search": find entries by free text (\`query\`, optional \`limit\`).
- "list": list the entries of the base.
- "read": return one entry by \`path\`.
- "validate": report problems in one entry (\`path\`) or in the whole base (no \`path\`). Run it after writing an entry.
- "locate": return the base's directory — with \`title\`, an unused file path for a new entry. Creates the base if this project has none yet; writes nothing.

**Entries are written with the \`write\` and \`edit\` tools, not with this one**: "locate" for the path, write the file, "validate" it. An entry is YAML frontmatter (\`type\` required — one of ${KNOWLEDGE_TYPES.join(' / ')}; plus \`title\`, \`description\`, \`tags\`, \`sources\`, \`status\`, \`stale_after\`) followed by a markdown body. New entries are \`draft\`; only the user makes an entry \`stable\`. Never write \`generated\` or \`verified\` — the host stamps \`generated\` for you, and verification is the user's claim to make. \`index.md\` and \`log.md\` are maintained by the host: read them, never write them.

Paths in this tool are relative to the base, e.g. "/token-refresh.md"; every listing names the base's absolute directory so you can build the path \`write\` / \`edit\` needs. To point at something in another base, use a \`shuvix://\` URI instead of a path.

Write entries worth carrying into later sessions: decisions, pitfalls, preferences, facts that took effort to establish. Search before writing and update an existing entry rather than adding a near-duplicate. Do not record what the repository already states, or what only matters to this conversation.`

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

export interface KnowledgeToolDeps {
  port: FileSystemPort
  security: SecurityContext
  /**
   * 本会话的目标 bundle。`create` 为真时尚不存在的 bundle 由宿主建出（目录 + 绑定概念 +
   * git init）；为假时不存在返回 error（如会话不属于任何项目）。
   */
  resolveBundle: (opts: { create: boolean }) => Promise<KnowledgeBundleTarget | { error: string }>
  /** 该 bundle 的扫描结果（宿主缓存；路径 bundle 相对） */
  scan: (bundleDir: string) => Promise<KnowledgeBundleScan>
  /** 该 bundle 内的检索 */
  search?: (
    query: string,
    opts: { limit: number; bundleDir: string }
  ) => Promise<KnowledgeSearchHit[]>
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
      case 'search':
        return this.search(params)
      case 'list':
        return this.list(params)
      case 'read':
        return this.read(toolCallId, params)
      case 'validate':
        return this.validate(toolCallId, params)
      case 'locate':
        return this.locate(params)
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

  /** 目标 bundle；解析不出（会话不属于任何项目）抛可读错误 */
  private async bundle(create: boolean): Promise<KnowledgeBundleTarget> {
    const target = await this.deps.resolveBundle({ create })
    if ('error' in target) throw new Error(target.error)
    return target
  }

  // ─── actions ───────────────────────────────────────────────

  private async search(params: KnowledgeToolParams): Promise<Result> {
    const query = params.query?.trim()
    if (!query) throw new Error('"search" needs `query`')
    const limit = params.limit ?? DEFAULT_LIMIT
    // bundle 解析不出（会话不属于任何项目）对检索是软条件：回文字不抛错，与 list 同口径
    const resolved = await this.deps.resolveBundle({ create: false })
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
    const resolved = await this.deps.resolveBundle({ create: false })
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
    const target = await this.bundle(false)
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
    const target = await this.bundle(false)
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
   * 寻址 —— 库的绝对目录；给了 `title` 再给一个没被占用的新条目绝对路径。
   * 本期新条目一律落在 bundle 根（没有 agent 可选的子目录层级）。
   */
  private async locate(params: KnowledgeToolParams): Promise<Result> {
    const title = params.title?.trim()
    const target = await this.bundle(true)
    if (!title) {
      return text(
        [
          `${whereLine(target)}`,
          'Write entries into this directory with the `write` tool, then "validate" them.'
        ],
        { action: 'locate' }
      )
    }

    const { concepts, files } = await this.deps.scan(target.dir)
    const taken = new Set<string>([
      ...concepts.filter((c) => dirOf(c.path) === '').map((c) => c.path),
      ...files.filter((f) => dirOf(f.path) === '').map((f) => f.path)
    ])
    // 保留文件名同样算占用：slugify('Index') 正好撞上宿主投影的 index.md
    const rel = dedupeFileName(
      `${slugify(title)}.md`,
      (name) => taken.has(name) || isReservedFile(name)
    )
    const fresh = !(await this.exists(target.dir, rel))
    return text(
      [
        `${joinRoot(target.dir, rel)}`,
        fresh
          ? 'Nothing was written — create the entry there with the `write` tool, then "validate" it.'
          : 'A file already exists at that path; pick another title or update the existing entry.'
      ],
      { action: 'locate', path: rel }
    )
  }
}

export function createKnowledgeTool(deps: KnowledgeToolDeps): KnowledgeTool {
  return new KnowledgeTool(deps)
}
