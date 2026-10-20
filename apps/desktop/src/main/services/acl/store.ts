/**
 * 会话权限表的存储：持久会话落 `session_acl` 表，**内存会话**（sessionRecords 的 ephemeral）只活在这里的
 * 内存表里、从不落库 —— 与会话行本身同一条分流（见 sessionRecords）。上层拿到的是同一套方法。
 */
import type { AclEntry } from '@shuvix/chat-protocol/sessionAcl'
import { sessionAclDao } from '../../dao/sessionAclDao'
import { sessionRecords } from '../sessionRecords'

export interface AclStore {
  list(sessionId: string): AclEntry[]
  insert(entry: AclEntry): void
  updateAccess(sessionId: string, id: string, access: AclEntry['access'], at: number): boolean
  delete(sessionId: string, id: string): boolean
  deleteSession(sessionId: string): void
  transaction<T>(fn: () => T): T
}

const dbStore: AclStore = {
  list: (sessionId) => sessionAclDao.findBySession(sessionId),
  insert: (entry) => sessionAclDao.insert(entry),
  updateAccess: (sessionId, id, access, at) =>
    sessionAclDao.updateAccess(sessionId, id, access, at),
  delete: (sessionId, id) => sessionAclDao.deleteById(sessionId, id),
  deleteSession: (sessionId) => void sessionAclDao.deleteBySession(sessionId),
  transaction: (fn) => sessionAclDao.transaction(fn)
}

/** 内存会话的表：sessionId → 行（与表行同形；读出时给副本，调用方改不到这里） */
const memory = new Map<string, AclEntry[]>()

const memoryStore: AclStore = {
  list: (sessionId) => (memory.get(sessionId) ?? []).map((e) => ({ ...e })),
  insert: (entry) => {
    const rows = memory.get(entry.sessionId) ?? []
    const clash = rows.some(
      (r) =>
        r.kind === entry.kind &&
        r.source === entry.source &&
        r.sourceKey === entry.sourceKey &&
        r.target === entry.target
    )
    // 与表上的唯一索引同口径
    if (clash) throw new Error(`session_acl: duplicate entry for ${entry.target}`)
    memory.set(entry.sessionId, [...rows, { ...entry }])
  },
  updateAccess: (sessionId, id, access, at) => {
    const row = memory.get(sessionId)?.find((r) => r.id === id)
    if (!row) return false
    row.access = access
    row.updatedAt = at
    return true
  },
  delete: (sessionId, id) => {
    const rows = memory.get(sessionId)
    if (!rows) return false
    const next = rows.filter((r) => r.id !== id)
    memory.set(sessionId, next)
    return next.length !== rows.length
  },
  deleteSession: (sessionId) => void memory.delete(sessionId),
  // 同步代码里没有并发，内存表不需要事务
  transaction: (fn) => fn()
}

/** 这条会话的表在哪一边（内存会话在内存，其余在库里） */
export function aclStoreFor(sessionId: string): AclStore {
  return sessionRecords.isEphemeral(sessionId) ? memoryStore : dbStore
}

/**
 * 删一条会话的整张表，两边都删 —— 内存会话被删之后 isEphemeral 就不再认它（见 sessionRecords），
 * 按「在哪一边」分流会漏掉它的内存表
 */
export function deleteAclEverywhere(sessionId: string): void {
  memoryStore.deleteSession(sessionId)
  dbStore.deleteSession(sessionId)
}

/** 清空内存表 —— 仅供单测隔离 */
export function clearMemoryAclForTests(): void {
  memory.clear()
}
