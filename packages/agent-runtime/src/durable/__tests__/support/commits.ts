/**
 * 提交发布的记录：每次发布摸到了哪些文档（`kind#conversationId`，会话级文档只有 kind）、追加了哪些
 * 条目种类。用来断言「一个提交」—— 锁、pi.agent、冻结的人设落在同一次发布里。
 */
import type { CommitPublication, Harness } from '@earendil-works/pi-durable'

export interface PublicationSummary {
  readonly seq: number
  /** 摸到的文档：`pi.agent#1`、`shuvix.agent-state#1`、`shuvix.session-state` …（去重、排序） */
  readonly docs: string[]
  /** 追加的条目种类，按出现次序 */
  readonly entries: string[]
}

export interface PublicationRecorder {
  readonly publications: PublicationSummary[]
  /** 摸到某个文档的那些发布 */
  touching(doc: string): PublicationSummary[]
  stop(): void
}

export function summarize(publication: CommitPublication): PublicationSummary {
  const docs = new Set<string>()
  const entries: string[] = []
  for (const change of publication.changes) {
    if (change.type === 'document' || change.type === 'document.copy') {
      const id = change.conversationId
      docs.add(id === undefined ? change.record.kind : `${change.record.kind}#${id}`)
    } else if (change.type === 'entry') {
      entries.push(change.value.kind)
    }
  }
  return { seq: publication.seq as unknown as number, docs: [...docs].sort(), entries }
}

export function recordPublications(
  harness: Pick<Harness, 'subscribeCommits'>
): PublicationRecorder {
  const publications: PublicationSummary[] = []
  const stop = harness.subscribeCommits((publication) => publications.push(summarize(publication)))
  return {
    publications,
    touching: (doc) => publications.filter((publication) => publication.docs.includes(doc)),
    stop
  }
}
