/**
 * `knowledge` 工具 —— 知识库的结构化读写面（设计 §6.1，决策 D4）。
 *
 * 为什么有专用工具而不只靠 write/edit：agent 只给正文与几个字段，宿主拼 frontmatter、盖
 * `generated`、跑投影、提交一次做完；工作流在策略允许时可以无询问写入（会话摘要）。
 * 文件工具仍然能写（写钩子盖章 + 投影照跑），社区 skill 与人工编辑因此不受影响。
 *
 * 安全：write / set-status 以目标绝对路径调用与文件写入**同一个** PEP（`enforcePath('write')`），
 * 所以 review-knowledge-writes 策略同时覆盖工具与直接写文件；read 走 `enforcePath('read')`。
 * 无专属客体 —— 状态感知的同意（改一份 stable 条目）留给后续，本期由策略按路径判定。
 *
 * 宿主无关：文件经 FileSystemPort，扫描 / 作用域解析 / 检索 / 写后处理全部注入。
 */
import { Type } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import {
  KNOWLEDGE_SCOPE_KINDS,
  KNOWLEDGE_TYPES,
  OKF_INDEX_FILE,
  OKF_LOG_FILE,
  type KnowledgeScopeKind
} from '@shuvix/chat-protocol/knowledge'
import type { FileSystemPort } from '../fileTools/port'
import type { SecurityContext } from '../security/types'
import { BaseTool } from '../tools/baseTool'
import {
  buildConceptText,
  isVerificationCurrent,
  normalizeSources,
  parseConceptText,
  type KnowledgeConcept,
  type KnowledgeSource
} from './conceptFile'
import {
  dedupeFileName,
  escapesBundle,
  normalizeBundlePath,
  sessionSummaryFileName,
  slugify
} from './scopes'
import { validateConceptText } from './validate'

export const KNOWLEDGE_TOOL_NAME = 'knowledge'

const ACTIONS = ['search', 'read', 'write', 'set-status', 'list'] as const
export type KnowledgeAction = (typeof ACTIONS)[number]

const AGENT_STATUSES = ['draft', 'deprecated'] as const

export const KnowledgeParamsSchema = Type.Object({
  action: Type.Unsafe<KnowledgeAction>({
    type: 'string',
    enum: [...ACTIONS],
    description: 'What to do. See the tool description for what each action does.'
  }),
  query: Type.Optional(Type.String({ description: 'For "search": free-text query.' })),
  scope: Type.Optional(
    Type.Unsafe<KnowledgeScopeKind>({
      type: 'string',
      enum: [...KNOWLEDGE_SCOPE_KINDS],
      description:
        'Where the entry lives / which scope to list: "global" (every session reads it), "project" (this session\'s project), "session" (this session\'s summary), "bot" (this session\'s bot), "wiki" (curated topics — also pass `topic`), "raw" (immutable sources). Required for "write" when creating; optional for "list" / "search".'
    })
  ),
  topic: Type.Optional(
    Type.String({ description: 'For scope "wiki": the topic directory (created when missing).' })
  ),
  path: Type.Optional(
    Type.String({
      description:
        'Bundle-absolute path of an existing entry, e.g. "/projects/acme/token-refresh.md". Required for "read" and "set-status"; for "write" it selects the entry to update (omit to create a new one).'
    })
  ),
  type: Type.Optional(
    Type.String({
      description: `For "write": the entry type — one of ${KNOWLEDGE_TYPES.join(' / ')} (other values are allowed). Required when creating.`
    })
  ),
  title: Type.Optional(
    Type.String({ description: 'For "write": display title. Required when creating.' })
  ),
  description: Type.Optional(
    Type.String({
      description:
        'For "write": ONE line saying when this entry is worth opening — it is what the index shows and how later sessions decide to read it. Required when creating.'
    })
  ),
  body: Type.Optional(
    Type.String({
      description:
        'For "write": the entry itself in markdown (the knowledge, not the metadata). Link other entries with bundle-absolute markdown links like [title](/global/x.md). Required when creating; replaces the body when updating.'
    })
  ),
  tags: Type.Optional(Type.Array(Type.String(), { description: 'For "write": tags.' })),
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
      { description: 'For "write": where the entry\'s claims come from.' }
    )
  ),
  stale_after: Type.Optional(
    Type.String({
      description: 'For "write": ISO date (YYYY-MM-DD) after which the entry needs re-verification.'
    })
  ),
  pinned: Type.Optional(
    Type.Boolean({
      description:
        'For "write": keep the whole body in every session\'s system prompt (only for rules that must always apply; costs context every turn).'
    })
  ),
  status: Type.Optional(
    Type.Unsafe<(typeof AGENT_STATUSES)[number]>({
      type: 'string',
      enum: [...AGENT_STATUSES],
      description:
        'For "set-status": "deprecated" (superseded or wrong) or "draft" (needs review again). Entries become "stable" only when the user verifies them.'
    })
  ),
  successor: Type.Optional(
    Type.String({
      description:
        'For "set-status" deprecated: bundle-absolute path of the entry that replaces it.'
    })
  ),
  limit: Type.Optional(
    Type.Number({ description: 'For "search" / "list": max results (default 20).' })
  )
})

export interface KnowledgeToolParams {
  action: KnowledgeAction
  query?: string
  scope?: KnowledgeScopeKind
  topic?: string
  path?: string
  type?: string
  title?: string
  description?: string
  body?: string
  tags?: string[]
  sources?: { resource: string; title?: string; id?: string }[]
  stale_after?: string
  pinned?: boolean
  status?: (typeof AGENT_STATUSES)[number]
  successor?: string
  limit?: number
}

export const KNOWLEDGE_DESCRIPTION = `Search, read and write the knowledge base — an OKF bundle of markdown entries shared across sessions: global memory, this project's memory, session summaries, this bot's memory, and curated wiki topics.

Actions:
- "search": find entries by free text (\`query\`, optional \`scope\`, \`limit\`).
- "list": list the entries of a \`scope\` (or the whole bundle).
- "read": return one entry by \`path\`.
- "write": create an entry (\`scope\`, \`type\`, \`title\`, \`description\`, \`body\`, optional \`tags\` / \`sources\` / \`stale_after\` / \`pinned\` / \`topic\`) or update one (\`path\` plus the fields to change). New entries are drafts; the user reviews them in the knowledge page. Scope "session" keeps ONE summary per session — writing it again updates it.
- "set-status": mark an entry "deprecated" (optionally naming a \`successor\`) or back to "draft". You cannot mark entries stable — only the user can.

Write entries worth carrying into later sessions: decisions, pitfalls, preferences, facts that took effort to establish. Search before writing and update an existing entry rather than adding a near-duplicate. Do not record what the repository already states, or what only matters to this conversation. The host stamps provenance (\`generated\`) — never claim verification yourself.`

/** 宿主解析出的作用域目标 */
export interface KnowledgeScopeTarget {
  /** 作用域目录（bundle 相对） */
  dir: string
  label: string
  /** scope=session 时：本会话的资源 URI（同一会话只有一份摘要，按它 upsert） */
  sessionResource?: string
}

export interface KnowledgeSearchHit {
  path: string
  title: string
  description?: string
  status?: string
  snippet?: string
}

export interface KnowledgeToolDeps {
  /** 根目录（桌面绝对路径；扩展为句柄根 '/'） */
  root: string
  port: FileSystemPort
  security: SecurityContext
  /** 全库概念（宿主扫描，含缓存） */
  listConcepts: () => Promise<readonly KnowledgeConcept[]>
  /**
   * 本会话的作用域 → 目标目录。`create` 为真时不存在的项目 / bot / wiki 主题目录由宿主
   * 建出（含绑定概念）；为假时不存在返回 error。
   */
  resolveScope: (
    scope: KnowledgeScopeKind,
    opts: { topic?: string; create: boolean }
  ) => Promise<KnowledgeScopeTarget | { error: string }>
  /** 检索（缺省：标题 / 描述 / 标签 / 正文子串匹配） */
  search?: (query: string, opts: { limit: number; dir?: string }) => Promise<KnowledgeSearchHit[]>
  /** 写入者 actor 字符串（OKF §5.2：`shuvix-<profile>/<model>`） */
  actor: () => string
  now: () => Date
  /** 写入后（投影 / 提交 / 事件由宿主完成） */
  afterWrite?: (e: {
    path: string
    op: 'create' | 'update' | 'set-status'
    title: string
    /** set-status 时的新状态（宿主据此把日志记成 Deprecation / Update） */
    status?: string
  }) => void | Promise<void>
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

function dateStamp(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function summaryLine(c: KnowledgeConcept, now: Date): string {
  const marks: string[] = []
  if (c.status !== 'stable') marks.push(c.status)
  if (c.verified.length > 0 && isVerificationCurrent(c)) marks.push('verified')
  const date = c.generated?.at?.slice(0, 10)
  if (date) marks.push(date)
  void now
  const mark = marks.length ? ` (${marks.join(', ')})` : ''
  return `- /${c.path}${mark} — ${c.description || c.title}`
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
    /* 逐 action 在 executeInternal 里按已解析的路径过 PEP（写入目标要先算出来） */
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
      case 'write':
        return this.write(toolCallId, params)
      case 'set-status':
        return this.setStatus(toolCallId, params)
      default:
        throw new Error(`Unknown action "${String(params.action)}". Valid: ${ACTIONS.join(', ')}`)
    }
  }

  // ─── 路径与准入 ─────────────────────────────────────────────

  /** 参数里的 bundle 路径 → 归一相对路径；越界 / 保留文件 / 非 .md 一律拒绝 */
  private bundlePath(raw: string, forWrite: boolean): string {
    const rel = normalizeBundlePath(raw)
    if (!rel || escapesBundle(rel))
      throw new Error(`Path "${raw}" is not inside the knowledge base`)
    if (!/\.md$/i.test(rel)) throw new Error(`Path "${raw}" is not a markdown entry (.md)`)
    const base = rel.split('/').pop() ?? rel
    if (forWrite && (base === OKF_INDEX_FILE || base === OKF_LOG_FILE)) {
      throw new Error(`"${base}" is a reserved file maintained by the host; write entries instead`)
    }
    return rel
  }

  private async enforce(
    mode: 'read' | 'write',
    rel: string,
    toolCallId: string,
    action: string
  ): Promise<void> {
    await this.deps.security.enforcePath(mode, joinRoot(this.deps.root, rel), {
      toolCallId,
      toolName: this.name,
      displayPath: `/${rel}`,
      abortError: this.deps.abortError ?? 'Aborted',
      operation: action
    })
  }

  private async exists(rel: string): Promise<boolean> {
    return (await this.deps.port.stat(joinRoot(this.deps.root, rel))) !== null
  }

  private async readConcept(rel: string): Promise<KnowledgeConcept | null> {
    if (!(await this.exists(rel))) return null
    const raw = await this.deps.port.readFile(joinRoot(this.deps.root, rel))
    return parseConceptText(raw, rel)
  }

  private async scopeTarget(
    params: KnowledgeToolParams,
    create: boolean
  ): Promise<KnowledgeScopeTarget | null> {
    if (!params.scope) return null
    const target = await this.deps.resolveScope(params.scope, { topic: params.topic, create })
    if ('error' in target) throw new Error(target.error)
    return target
  }

  // ─── actions ───────────────────────────────────────────────

  private async search(params: KnowledgeToolParams): Promise<Result> {
    const query = params.query?.trim()
    if (!query) throw new Error('"search" needs `query`')
    const limit = params.limit ?? DEFAULT_LIMIT
    // 作用域解析不到（项目还没条目 / 不是 bot 会话）对检索是软条件：回文字不抛错，与 list 同口径
    let dir: string | undefined
    if (params.scope) {
      const resolved = await this.deps.resolveScope(params.scope, {
        topic: params.topic,
        create: false
      })
      if ('error' in resolved) return text([resolved.error], { action: 'search' })
      dir = resolved.dir
    }
    if (this.deps.search) {
      const hits = await this.deps.search(query, { limit, dir })
      if (hits.length === 0) return text([`No entries match "${query}".`], { action: 'search' })
      return text(
        [
          `${hits.length} result(s) for "${query}":`,
          ...hits.map(
            (h) =>
              `- /${normalizeBundlePath(h.path)}${h.status && h.status !== 'stable' ? ` (${h.status})` : ''} — ${h.description || h.title}${h.snippet ? `\n  ${h.snippet}` : ''}`
          )
        ],
        { action: 'search' }
      )
    }
    const needle = query.toLowerCase()
    const concepts = (await this.deps.listConcepts()).filter(
      (c) =>
        c.status !== 'deprecated' &&
        (!dir || c.path.startsWith(`${dir}/`)) &&
        [c.title, c.description, c.tags.join(' '), c.body].some((s) =>
          s.toLowerCase().includes(needle)
        )
    )
    if (concepts.length === 0) return text([`No entries match "${query}".`], { action: 'search' })
    const now = this.deps.now()
    return text(
      [
        `${concepts.length} result(s) for "${query}":`,
        ...concepts.slice(0, limit).map((c) => summaryLine(c, now))
      ],
      { action: 'search' }
    )
  }

  private async list(params: KnowledgeToolParams): Promise<Result> {
    const limit = params.limit ?? DEFAULT_LIMIT * 5
    let target: KnowledgeScopeTarget | null = null
    if (params.scope) {
      const resolved = await this.deps.resolveScope(params.scope, {
        topic: params.topic,
        create: false
      })
      if ('error' in resolved) return text([resolved.error], { action: 'list' })
      target = resolved
    }
    const concepts = (await this.deps.listConcepts()).filter(
      (c) => !target || c.path.startsWith(`${target.dir}/`)
    )
    if (concepts.length === 0) {
      return text(
        [target ? `No entries in ${target.label} yet.` : 'The knowledge base is empty.'],
        {
          action: 'list'
        }
      )
    }
    const now = this.deps.now()
    const lines = concepts.slice(0, limit).map((c) => summaryLine(c, now))
    if (concepts.length > limit) lines.push(`- … ${concepts.length - limit} more`)
    return text(
      [
        `${concepts.length} entr${concepts.length === 1 ? 'y' : 'ies'}${target ? ` in ${target.label}` : ''}:`,
        ...lines
      ],
      {
        action: 'list'
      }
    )
  }

  private async read(toolCallId: string, params: KnowledgeToolParams): Promise<Result> {
    if (!params.path) throw new Error('"read" needs `path`')
    const rel = this.bundlePath(params.path, false)
    await this.enforce('read', rel, toolCallId, params.action)
    if (!(await this.exists(rel))) throw new Error(`No entry at /${rel}`)
    const raw = await this.deps.port.readFile(joinRoot(this.deps.root, rel))
    return text([`/${rel}:`, '', raw.trimEnd()], { action: 'read', path: rel })
  }

  private async write(toolCallId: string, params: KnowledgeToolParams): Promise<Result> {
    const now = this.deps.now()
    const actor = this.deps.actor()
    const generated = { by: actor, at: now.toISOString() }

    // 目标：给了 path 就是更新；否则按作用域定位（session 作用域按资源 URI upsert）
    let rel: string | null = params.path ? this.bundlePath(params.path, true) : null
    let existing: KnowledgeConcept | null = null
    let target: KnowledgeScopeTarget | null = null
    if (rel) {
      existing = await this.readConcept(rel)
      if (!existing) throw new Error(`No entry at /${rel} — omit \`path\` to create a new one`)
    } else {
      if (!params.scope)
        throw new Error('"write" needs `scope` when creating (or `path` when updating)')
      target = await this.scopeTarget(params, true)
      if (!target) throw new Error('"write" needs `scope` when creating')
      if (target.sessionResource) {
        existing =
          (await this.deps.listConcepts()).find(
            (c) => c.path.startsWith(`${target!.dir}/`) && c.resource === target!.sessionResource
          ) ?? null
        if (existing) rel = existing.path
      }
    }

    const title = params.title?.trim() || existing?.title
    const description = params.description?.trim() ?? existing?.description
    const body = params.body !== undefined ? params.body : existing?.body
    const type = params.type?.trim() || existing?.type
    if (!existing) {
      const missing = [
        !type && 'type',
        !title && 'title',
        !description && 'description',
        !body?.trim() && 'body'
      ].filter(Boolean)
      if (missing.length) throw new Error(`Creating an entry needs: ${missing.join(', ')}`)
    }
    if (!body?.trim()) throw new Error('The entry body must not be empty')

    if (!rel) {
      const dir = target!.dir
      const fileName =
        params.scope === 'session'
          ? sessionSummaryFileName(dateStamp(now), title!)
          : `${slugify(title!)}.md`
      const taken = new Set(
        (await this.deps.listConcepts())
          .filter((c) => dirOf(c.path) === dir)
          .map((c) => c.path.slice(dir.length + 1))
      )
      rel = `${dir}/${dedupeFileName(fileName, (name) => taken.has(name))}`
      if (await this.exists(rel)) rel = `${dir}/${dedupeFileName(fileName, () => true)}`
    }

    await this.enforce('write', rel, toolCallId, params.action)

    const sources: KnowledgeSource[] =
      params.sources !== undefined ? normalizeSources(params.sources) : (existing?.sources ?? [])
    const content = buildConceptText(
      {
        type: type!,
        title: title!,
        description,
        resource: target?.sessionResource ?? existing?.resource,
        tags: params.tags ?? existing?.tags,
        // 新条目恒为 draft；更新沿用既有状态（agent 不能把东西标成 stable）
        status: existing ? existing.status : 'draft',
        staleAfter: params.stale_after ?? existing?.staleAfter,
        sources,
        generated,
        verified: existing?.verified,
        pinned: params.pinned ?? existing?.pinned,
        extra: existing?.fields
      },
      body
    )
    await this.deps.port.writeFile(joinRoot(this.deps.root, rel), content)
    await this.deps.afterWrite?.({ path: rel, op: existing ? 'update' : 'create', title: title! })

    const warnings = validateConceptText(content, rel)
      .filter((d) => d.level === 'warning')
      .map((d) => `- ${d.message}`)
    const status = existing ? existing.status : 'draft'
    return text(
      [
        `${existing ? 'Updated' : 'Created'} /${rel} (${status}${existing?.verified.length ? ', verified earlier — the user will need to re-verify' : ''}).`,
        ...(warnings.length ? ['Notes:', ...warnings] : [])
      ],
      { action: 'write', path: rel }
    )
  }

  private async setStatus(toolCallId: string, params: KnowledgeToolParams): Promise<Result> {
    if (!params.path) throw new Error('"set-status" needs `path`')
    // 运行时也守一遍枚举：stable 只有用户能设，不能只靠 schema 挡（宿主校验松了就是提权）
    if (!params.status || !(AGENT_STATUSES as readonly string[]).includes(params.status)) {
      throw new Error(
        `"set-status" needs \`status\` (${AGENT_STATUSES.join(' / ')}); only the user can make an entry stable`
      )
    }
    const rel = this.bundlePath(params.path, true)
    const existing = await this.readConcept(rel)
    if (!existing) throw new Error(`No entry at /${rel}`)
    let successor: string | undefined
    if (params.successor) {
      successor = this.bundlePath(params.successor, false)
      if (!(await this.exists(successor))) throw new Error(`Successor /${successor} does not exist`)
    }
    await this.enforce('write', rel, toolCallId, params.action)

    const now = this.deps.now()
    let body = existing.body.trimEnd()
    if (params.status === 'deprecated' && successor) {
      const successorTitle = (await this.readConcept(successor))?.title ?? successor
      body = `${body}\n\nSuperseded by [${successorTitle}](/${successor}).`
    }
    const content = buildConceptText(
      {
        type: existing.type,
        title: existing.title,
        description: existing.description,
        resource: existing.resource,
        tags: existing.tags,
        status: params.status,
        staleAfter: existing.staleAfter,
        sources: existing.sources,
        generated: { by: this.deps.actor(), at: now.toISOString() },
        verified: existing.verified,
        pinned: existing.pinned,
        extra: existing.fields
      },
      body
    )
    await this.deps.port.writeFile(joinRoot(this.deps.root, rel), content)
    await this.deps.afterWrite?.({
      path: rel,
      op: 'set-status',
      title: existing.title,
      status: params.status
    })
    return text(
      [`/${rel} is now ${params.status}${successor ? ` (superseded by /${successor})` : ''}.`],
      {
        action: 'set-status',
        path: rel
      }
    )
  }
}

export function createKnowledgeTool(deps: KnowledgeToolDeps): KnowledgeTool {
  return new KnowledgeTool(deps)
}
