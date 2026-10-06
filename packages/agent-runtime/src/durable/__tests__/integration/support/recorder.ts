/**
 * 提交发布的记录器（扩展 P1-09 的 commits.ts）：每次发布里 `pi.live` / `pi.inbox` / `pi.usage` 的新值
 * （按对话）与追加的条目种类。瞬时的持久化状态 —— 重试窗口（`generation.retry`）、压缩状态
 * （`compactions[]`）、收件箱里的写入 —— 轮询快照会错过，只能从这里断言。重启之后要重新挂。
 */
import type { CommitPublication, Harness, LiveState } from '@earendil-works/pi-durable'
import type { InboxState, UsageState } from '@earendil-works/pi-durable'

export interface DocValue<T> {
  readonly seq: number
  readonly conversationId: number | undefined
  readonly value: T
}

export interface CommitRecorder {
  readonly live: DocValue<LiveState>[]
  readonly inbox: DocValue<InboxState>[]
  readonly usage: DocValue<UsageState>[]
  /** 追加的条目：[种类, 条目 id]，按发布次序 */
  readonly entries: {
    readonly seq: number
    readonly kind: string
    readonly id: number
    readonly conversationId: number
  }[]
  /** 某对话的 LiveDoc 值序列（缺省根对话） */
  livesOf(conversationId?: number): LiveState[]
  inboxesOf(conversationId?: number): InboxState[]
  stop(): void
}

const KINDS = { live: 'pi.live', inbox: 'pi.inbox', usage: 'pi.usage' } as const

export function recordCommits(harness: Pick<Harness, 'subscribeCommits'>): CommitRecorder {
  const recorder: Omit<CommitRecorder, 'stop'> = {
    live: [],
    inbox: [],
    usage: [],
    entries: [],
    livesOf: (conversationId = 1) =>
      recorder.live.filter((doc) => doc.conversationId === conversationId).map((doc) => doc.value),
    inboxesOf: (conversationId = 1) =>
      recorder.inbox.filter((doc) => doc.conversationId === conversationId).map((doc) => doc.value)
  }
  const observe = (publication: CommitPublication): void => {
    const seq = publication.seq as unknown as number
    for (const change of publication.changes) {
      if (change.type === 'entry') {
        recorder.entries.push({
          seq,
          kind: change.value.kind,
          id: change.value.id as unknown as number,
          conversationId: change.value.conversationId as unknown as number
        })
        continue
      }
      if (change.type !== 'document' || change.value === null) continue
      const conversationId = change.conversationId as unknown as number | undefined
      // 深拷贝：发布的值是不可变修订，但拷一份更稳（断言时不会碰到共享结构）
      const value = structuredClone(change.value) as unknown
      switch (change.record.kind) {
        case KINDS.live:
          recorder.live.push({ seq, conversationId, value: value as LiveState })
          break
        case KINDS.inbox:
          recorder.inbox.push({ seq, conversationId, value: value as InboxState })
          break
        case KINDS.usage:
          recorder.usage.push({ seq, conversationId, value: value as UsageState })
          break
      }
    }
  }
  const stop = harness.subscribeCommits(observe)
  return { ...recorder, stop }
}
