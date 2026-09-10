/**
 * 侧栏 / 管理页的条目清单 —— 确保根目录、扫描、投影成 chat-protocol 的 KnowledgeEntry（不含正文）。
 *
 * 这里 ensureKnowledgeRoot：分组首次展开即用户意图（同 wikiService 懒建根的判断），此时才
 * 建目录、写 SCHEMA.md 种子、投影 index/log、git init；启动时不建。
 */
import type { KnowledgeEntry } from '@shuvix/chat-protocol/knowledge'
import { toKnowledgeEntry } from '@shuvix/agent-runtime'
import { ensureKnowledgeRoot } from './root'
import { scanKnowledge } from './scan'

export async function listKnowledgeEntries(): Promise<{
  entries: KnowledgeEntry[]
  root: string
}> {
  const root = await ensureKnowledgeRoot()
  const { concepts } = await scanKnowledge()
  const now = new Date()
  return { root, entries: concepts.map((c) => toKnowledgeEntry(c, now)) }
}
