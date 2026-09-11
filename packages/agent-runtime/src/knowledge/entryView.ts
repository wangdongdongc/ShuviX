/**
 * 概念 → 条目视图（chat-protocol `KnowledgeEntry`，侧栏 / 管理页一行所需，不含正文）。
 * 纯投影：信任档按 `verified` 推、「核实仍当前」按 verified/generated 时序判、过期按
 * `stale_after` 对当日判。
 *
 * 概念自己的 `path` 是 **bundle 相对**（OKF 的口径），而视图要在全部 bundle 之间唯一，
 * 所以出参的 `path` 拼上 bundle 前缀 —— 两者都相对 `knowledge-shuvix/` 根。
 */
import type { KnowledgeEntry } from '@shuvix/chat-protocol/knowledge'
import { isStale, isVerificationCurrent, trustTierOf, type KnowledgeConcept } from './conceptFile'
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
