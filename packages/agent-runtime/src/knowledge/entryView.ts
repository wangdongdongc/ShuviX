/**
 * 概念 → 条目视图（chat-protocol `KnowledgeEntry`，侧栏 / 管理页一行所需，不含正文）。
 * 纯投影：作用域按路径算、信任档按 `verified` 推、「核实仍当前」按 verified/generated 时序判、
 * 过期按 `stale_after` 对当日判。两宿主共用 —— 桌面 services/knowledge/entries.ts 只做扫描 + map。
 */
import type { KnowledgeEntry } from '@shuvix/chat-protocol/knowledge'
import { isStale, isVerificationCurrent, trustTierOf, type KnowledgeConcept } from './conceptFile'
import { scopeKindOfPath } from './scopes'

export function toKnowledgeEntry(concept: KnowledgeConcept, now: Date): KnowledgeEntry {
  const entry: KnowledgeEntry = {
    path: concept.path,
    scope: scopeKindOfPath(concept.path),
    type: concept.type,
    title: concept.title,
    description: concept.description,
    status: concept.status,
    tags: [...concept.tags],
    trustTier: trustTierOf(concept),
    verifiedCurrent: isVerificationCurrent(concept),
    stale: isStale(concept, now),
    pinned: concept.pinned
  }
  if (concept.generated) {
    entry.generatedAt = concept.generated.at
    entry.generatedBy = concept.generated.by
  }
  return entry
}
