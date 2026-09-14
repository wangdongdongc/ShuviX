/**
 * OKF 编解码 —— 社区包 `@equationalapplications/core-okf` 的唯一接入面。
 *
 * 分工是实测定下来的（2026-09，v7.1.0）：
 *   - **解析用仓库自己的 `yaml`**：core-okf 的 `parseConcept` 是零依赖的 YAML 子集解析器，
 *     块序列会解错 —— `sources:\n  - id: s1\n    resource: …` 被读成 `["id: s1"]`，
 *     `resource` 漏到顶层；`verified` 的块序列整个变成字符串。真实 YAML 一律走 `yaml`。
 *   - **构建用 core-okf**：`serializeFrontmatter` / `buildConceptDocument` 的输出与 OKF v0.2 规范的
 *     范例逐字同形（`generated: { by, at }` 流式映射等），这是引社区包的价值：格式约定不再由本仓维护。
 *   - 信任分档 / 过期判断 / 链接提取也走它（纯函数，语义即规范）。
 *
 * 换库只动本文件：其余模块只认这里导出的名字。
 */
import { parse as parseYaml } from 'yaml'
import {
  serializeFrontmatter as okfSerializeFrontmatter,
  buildConceptDocument as okfBuildConceptDocument,
  extractMarkdownLinks as okfExtractMarkdownLinks,
  deriveTrustTier as okfDeriveTrustTier,
  isStaleAfter as okfIsStaleAfter,
  type OkfFrontmatter
} from '@equationalapplications/core-okf'
import { splitFrontmatter } from '../markdownFrontmatter'

/** 一份 OKF 文本拆开：frontmatter 映射（含未知键，原样）+ 正文 */
export interface OkfSplit {
  fields: Record<string, unknown>
  body: string
}

/**
 * 拆 frontmatter + YAML 解析。返回 null 的三种情况：没有 frontmatter、YAML 语法错、
 * frontmatter 不是键值映射 —— 三者对调用方都意味着「这不是一份可读的 OKF 文件」，
 * 需要区分原因的（校验回执）自己再走一遍 splitFrontmatter。
 */
export function parseOkfText(text: string): OkfSplit | null {
  const split = splitFrontmatter(text)
  if (!split) return null
  try {
    const parsed: unknown = parseYaml(split.yaml)
    if (parsed === null || parsed === undefined) return { fields: {}, body: split.body }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return { fields: parsed as Record<string, unknown>, body: split.body }
  } catch {
    return null
  }
}

/** 去掉 undefined / null 的键 —— core-okf 的序列化器把它们当值写出 */
function compact(fields: Record<string, unknown>): OkfFrontmatter {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue
    out[k] = v
  }
  return out as unknown as OkfFrontmatter
}

/** frontmatter 映射 → `---\n…\n---\n`（含定界线与尾换行；`type` 必须在 fields 里） */
export function serializeOkfFrontmatter(fields: Record<string, unknown>): string {
  return okfSerializeFrontmatter(compact(fields))
}

/** frontmatter + 正文 → 完整文件文本 */
export function buildOkfConceptDocument(fields: Record<string, unknown>, body: string): string {
  return okfBuildConceptDocument(compact(fields), body)
}

export interface ConceptLink {
  text: string
  /** 链接原文（bundle 绝对 `/a/b.md` 或相对 `./b.md` / `b.md`） */
  path: string
}

/** 正文里的概念链接：只取指向 `.md` 的标准 markdown 链接（URL / 图片 / 锚点不算） */
export function extractConceptLinks(body: string): ConceptLink[] {
  const out: ConceptLink[] = []
  for (const link of okfExtractMarkdownLinks(body)) {
    const target = link.path.split('#')[0]
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    if (!/\.md$/i.test(target)) continue
    out.push({ text: link.text, path: target })
  }
  return out
}

export type TrustTier = ReturnType<typeof okfDeriveTrustTier>

/** `verified` 列表 → 信任档（缺省 unverified；含 `human:` actor 即 human-reviewed） */
export function deriveTrustTier(verified: readonly { by: string; at: string }[]): TrustTier {
  return okfDeriveTrustTier(verified.length ? [...verified] : undefined)
}

/** `stale_after` 是否已过（缺省永不过期） */
export function isStaleAfter(staleAfter: string | undefined, now: Date): boolean {
  return okfIsStaleAfter(staleAfter ?? null, now.getTime())
}
