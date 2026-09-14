/**
 * 概念 → 条目视图（chat-protocol `KnowledgeEntry`，侧栏 / 管理页一行所需，不含正文）。
 * 纯投影：信任档按 `verified` 推、「核实仍当前」按 verified/generated 时序判、过期按
 * `stale_after` 对当日判。
 *
 * 概念自己的 `path` 是 **bundle 相对**（OKF 的口径），而视图要在全部 bundle 之间唯一，
 * 所以出参的 `path` 拼上 bundle 前缀 —— 用两个根共用的 id 名字空间（`projects/<id>/…` /
 * `knowledge/<库名>/…`）。
 */
import type { KnowledgeEntry } from '@shuvix/chat-protocol/knowledge'
import {
  isStale,
  isVerificationCurrent,
  trustTierOf,
  type KnowledgeConcept,
  type KnowledgeNote
} from './conceptFile'
import { normalizeBundlePath } from './bundlePaths'

export function toKnowledgeEntry(
  concept: KnowledgeConcept,
  ctx: { bundle: string; now: Date }
): KnowledgeEntry {
  const bundle = normalizeBundlePath(ctx.bundle)
  const rel = normalizeBundlePath(concept.path)
  const entry: KnowledgeEntry = {
    path: bundle ? `${bundle}/${rel}` : rel,
    bundle,
    type: concept.type,
    title: concept.title,
    description: concept.description,
    status: concept.status,
    tags: [...concept.tags],
    trustTier: trustTierOf(concept),
    verifiedCurrent: isVerificationCurrent(concept),
    stale: isStale(concept, ctx.now)
  }
  if (concept.generated) {
    entry.generatedAt = concept.generated.at
    entry.generatedBy = concept.generated.by
  }
  return entry
}

/**
 * 笔记 → 条目视图。合规条目走 toKnowledgeEntry（标题按笔记的取法：frontmatter title → 第一个 # 标题 →
 * 文件名）；普通笔记没有核实 / 过期可言，按缺省值填充，type 为空。
 */
export function toKnowledgeEntryFromNote(
  note: KnowledgeNote,
  ctx: { bundle: string; now: Date }
): KnowledgeEntry {
  if (note.concept) return { ...toKnowledgeEntry(note.concept, ctx), title: note.title }
  const bundle = normalizeBundlePath(ctx.bundle)
  const rel = normalizeBundlePath(note.path)
  return {
    path: bundle ? `${bundle}/${rel}` : rel,
    bundle,
    type: note.type,
    title: note.title,
    description: note.description,
    status: note.status,
    tags: [...note.tags],
    trustTier: 'unverified',
    verifiedCurrent: false,
    stale: false
  }
}
