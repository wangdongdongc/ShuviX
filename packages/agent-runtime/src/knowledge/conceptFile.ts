/**
 * OKF 概念文件（ShuviX profile）—— 一个 `.md` = 一个 concept，frontmatter 是元数据、正文是知识。
 *
 * 只有 `type` 必填（OKF v0.2 §4）；其余字段缺省宽容：这是用户要读、要在 Obsidian 里改的文件，
 * 解析失败不能让它从视图里消失。**唯一会返回 null 的情况**：没有可解析的 frontmatter、
 * 或 `type` 缺失 / 非字符串 / 空 —— 那不是一份 OKF 概念（保留文件 index.md / log.md 也不是）。
 * 字段形状不符时取缺省并经 `warn` 报告（校验回执用同一套判定，见 validate.ts）。
 *
 * 宿主盖的两个章：`generated` 由写钩子 / knowledge 工具在每次写入时刷新，
 * `verified` 只由 UI 动作追加 —— 本模块不写它们，只读。
 */
import {
  KNOWLEDGE_TYPES,
  OKF_STATUSES,
  type OkfStatus,
  type OkfTrustTier
} from '@shuvix/chat-protocol/knowledge'
import { buildOkfConceptDocument, deriveTrustTier, isStaleAfter, parseOkfText } from './okfCodec'

export interface KnowledgeSource {
  id?: string
  resource: string
  title?: string
  author?: string
  last_modified?: string
}

export interface KnowledgeStamp {
  by: string
  at: string
}

export interface KnowledgeConcept {
  /** bundle 相对路径（forward-slash，无前导 `/`）—— 稳定 id */
  path: string
  type: string
  /** 缺省 = 文件名 stem */
  title: string
  description: string
  tags: string[]
  /** 缺省 stable（OKF 语义）；非法值按 stable 并告警 */
  status: OkfStatus
  staleAfter?: string
  sources: KnowledgeSource[]
  generated?: KnowledgeStamp
  verified: KnowledgeStamp[]
  resource?: string
  /** 原始 frontmatter（含未知键）—— 更新时原样保留 */
  fields: Record<string, unknown>
  body: string
}

/** 文件名 stem（无扩展名） */
export function titleFromPath(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path
  return name.replace(/\.(md|markdown|mdx)$/i, '')
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  return undefined
}

function normalizeTags(value: unknown, warn?: (msg: string) => void): string[] {
  if (value === undefined || value === null) return []
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (Array.isArray(value)) {
    return value.map((v) => str(v)).filter((v): v is string => !!v)
  }
  warn?.("'tags' must be a list of strings")
  return []
}

function normalizeStamp(value: unknown): KnowledgeStamp | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const rec = value as Record<string, unknown>
  const by = str(rec.by)
  const at = str(rec.at)
  return by && at ? { by, at } : null
}

/** `verified` 接受单个映射或映射列表（OKF §5.2 两种形态都合法） */
export function normalizeVerified(value: unknown, warn?: (msg: string) => void): KnowledgeStamp[] {
  if (value === undefined || value === null) return []
  const items = Array.isArray(value) ? value : [value]
  const out: KnowledgeStamp[] = []
  for (const item of items) {
    const stamp = normalizeStamp(item)
    if (stamp) out.push(stamp)
    else warn?.("'verified' entries must be mappings with 'by' and 'at'")
  }
  return out
}

export function normalizeSources(value: unknown, warn?: (msg: string) => void): KnowledgeSource[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    warn?.("'sources' must be a list")
    return []
  }
  const out: KnowledgeSource[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ resource: item.trim() })
      continue
    }
    if (!item || typeof item !== 'object') {
      warn?.("'sources' entries must be mappings with a 'resource'")
      continue
    }
    const rec = item as Record<string, unknown>
    const resource = str(rec.resource)
    if (!resource) {
      warn?.("'sources' entries must carry a 'resource'")
      continue
    }
    const source: KnowledgeSource = { resource }
    const id = str(rec.id)
    const title = str(rec.title)
    const author = str(rec.author)
    const lastModified = str(rec.last_modified)
    if (id) source.id = id
    if (title) source.title = title
    if (author) source.author = author
    if (lastModified) source.last_modified = lastModified
    out.push(source)
  }
  return out
}

export function isOkfStatus(value: unknown): value is OkfStatus {
  return typeof value === 'string' && (OKF_STATUSES as readonly string[]).includes(value)
}

/**
 * 文本是否是一份 OKF 概念：有可解析的 frontmatter 映射、`type` 为非空字符串、
 * 且不带 `shuvix` 类型标记（那是本仓其它契约文件 —— agent / policy / 旧记忆 / 旧 wiki）。
 */
export function isOkfConceptText(text: string): boolean {
  const split = parseOkfText(text)
  if (!split) return false
  if ('shuvix' in split.fields) return false
  const type = split.fields.type
  return typeof type === 'string' && type.trim() !== ''
}

/**
 * 解析概念文本。不是概念（见模块注释）返回 null；字段形状问题经 warn 报告并取缺省。
 * `path` 为 bundle 相对路径，只用于 title 缺省与回填。
 */
export function parseConceptText(
  text: string,
  path: string,
  warn?: (msg: string) => void
): KnowledgeConcept | null {
  const split = parseOkfText(text)
  if (!split || 'shuvix' in split.fields) return null
  const fields = split.fields
  // `type` 只认非空字符串（与 validate / isOkfConceptText 同一判定）：`type: 5` 不是概念
  const type = typeof fields.type === 'string' ? fields.type.trim() : ''
  if (!type) return null

  let status: OkfStatus = 'stable'
  if (fields.status !== undefined && fields.status !== null) {
    if (isOkfStatus(fields.status)) status = fields.status
    else warn?.(`'status' must be one of ${OKF_STATUSES.join(' / ')}; treated as stable`)
  }

  const generated = normalizeStamp(fields.generated)
  if (fields.generated !== undefined && fields.generated !== null && !generated) {
    warn?.("'generated' must be a mapping with 'by' and 'at'")
  }

  return {
    path: path.replace(/\\/g, '/').replace(/^\/+/, ''),
    type,
    title: str(fields.title) ?? titleFromPath(path),
    description: str(fields.description) ?? '',
    tags: normalizeTags(fields.tags, warn),
    status,
    staleAfter: str(fields.stale_after),
    sources: normalizeSources(fields.sources, warn),
    generated: generated ?? undefined,
    verified: normalizeVerified(fields.verified, warn),
    resource: str(fields.resource),
    fields,
    // 去掉 frontmatter 与正文之间的空行（core-okf 的构建器恒插一行；splitFrontmatter 把它算进
    // 正文）：正文以内容起头，parse(build(x)).body 才与 x.body 相等
    body: split.body.replace(/^(?:[ \t]*\r?\n)+/, '')
  }
}

/** 信任档：`verified` 非空即被验证过；人工验证以 `human:` actor 识别 */
export function trustTierOf(concept: Pick<KnowledgeConcept, 'verified'>): OkfTrustTier {
  return deriveTrustTier(concept.verified)
}

/**
 * 验证是否仍然当前：最近一次 `verified.at` 不早于 `generated.at`。agent 改写一份人工核实过的
 * 条目时 `verified` 不删（那是历史），但它不再为新内容背书 —— 围栏与视图按这个判定标注。
 */
export function isVerificationCurrent(
  concept: Pick<KnowledgeConcept, 'verified' | 'generated'>
): boolean {
  if (concept.verified.length === 0) return false
  if (!concept.generated) return true
  const latest = concept.verified.map((v) => Date.parse(v.at)).filter((n) => !Number.isNaN(n))
  const generatedAt = Date.parse(concept.generated.at)
  if (latest.length === 0 || Number.isNaN(generatedAt)) return true
  return Math.max(...latest) >= generatedAt
}

export function isStale(concept: Pick<KnowledgeConcept, 'staleAfter'>, now: Date): boolean {
  return isStaleAfter(concept.staleAfter, now)
}

/** 词汇表里的 type（大小写不敏感）归一为规范写法；未知值原样返回（OKF 容忍未知 type） */
export function normalizeKnowledgeType(type: string): string {
  const trimmed = type.trim()
  const hit = KNOWLEDGE_TYPES.find((t) => t.toLowerCase() === trimmed.toLowerCase())
  return hit ?? trimmed
}

export interface ConceptBuildInput {
  type: string
  title: string
  description?: string
  resource?: string
  tags?: readonly string[]
  status: OkfStatus
  staleAfter?: string
  sources?: readonly KnowledgeSource[]
  generated?: KnowledgeStamp
  verified?: readonly KnowledgeStamp[]
  /** 更新时原样保留的既有 frontmatter（未知键）；已知键以本输入为准 */
  extra?: Record<string, unknown>
}

const KNOWN_KEYS = new Set([
  'type',
  'title',
  'description',
  'resource',
  'tags',
  'status',
  'stale_after',
  'sources',
  'generated',
  'verified'
])

/**
 * 组装一份概念文本（frontmatter 键序固定：规范字段在前、未知键殿后）。
 * 空 / 未声明的可选字段不写；`status` 恒写出 —— OKF 缺省 stable，agent 写的草稿必须显式。
 */
export function buildConceptText(input: ConceptBuildInput, body: string): string {
  const fields: Record<string, unknown> = {
    type: normalizeKnowledgeType(input.type),
    title: input.title.trim()
  }
  if (input.description?.trim()) fields.description = input.description.trim()
  if (input.resource?.trim()) fields.resource = input.resource.trim()
  if (input.tags?.length)
    fields.tags = [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))]
  fields.status = input.status
  if (input.staleAfter?.trim()) fields.stale_after = input.staleAfter.trim()
  if (input.sources?.length) {
    fields.sources = input.sources.map((s) => {
      const out: Record<string, string> = {}
      if (s.id) out.id = s.id
      out.resource = s.resource
      if (s.title) out.title = s.title
      if (s.author) out.author = s.author
      if (s.last_modified) out.last_modified = s.last_modified
      return out
    })
  }
  if (input.generated) fields.generated = { by: input.generated.by, at: input.generated.at }
  if (input.verified?.length) fields.verified = input.verified.map((v) => ({ by: v.by, at: v.at }))
  for (const [k, v] of Object.entries(input.extra ?? {})) {
    if (KNOWN_KEYS.has(k) || k === 'shuvix') continue
    fields[k] = v
  }
  const trimmedBody = body.replace(/^\s*\n/, '').trimEnd()
  return buildOkfConceptDocument(fields, trimmedBody ? `${trimmedBody}\n` : '')
}
