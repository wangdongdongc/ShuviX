/**
 * 会话 fork（跨存储整拷）用例的共用夹具：
 *
 *  - `copyStorageFile(from, to)`：与宿主 `sessionStorage.copyDurableStorage` 同一做法 —— 在源文件上另开一条
 *    node:sqlite 连接，`VACUUM INTO` 目标路径。
 *  - `forkStorage(t, source, toId)`：宿主 fork 的步骤 2–3 —— 在源会话的 `whileIdle` 里把它的文件拷成 `toId`
 *    的，拷成了就按路径开那份拷贝、`resetForkedSessionState`。交回 whileIdle 的结果（busy 时什么都没拷）。
 *  - `readStorage(file)`：按路径开一份原始存储（不经宿主），读会话状态文档、全部对话、每个对话自己的条目、
 *    全部任务、每个对话的 AgentStateDoc，读完关掉。
 */
import { DatabaseSync } from 'node:sqlite'
import {
  createSession,
  type ConversationRecord,
  type EntryRecord,
  type TaskRecord
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { JsonValue } from '@earendil-works/chord'
import { backgroundContext as BG } from '../../context'
import {
  AgentStateDoc,
  SessionStateDoc,
  type AgentStateRecord,
  type SessionState
} from '../../docs'
import type { DurableSession } from '../../durableSession'
import type { IdleWorkResult } from '../../rollback'
import { resetForkedSessionState } from '../../sessionFork'
import type { TestHost } from './host'

/** 源文件 → 目标路径的整拷（`VACUUM INTO`，与宿主同一做法） */
export function copyStorageFile(from: string, to: string): void {
  const db = new DatabaseSync(from)
  try {
    db.prepare('VACUUM INTO ?').run(to)
  } finally {
    db.close()
  }
}

/** 宿主 fork 的拷贝 + 收尾：源会话空闲时拷成 `toId` 的文件，再按路径开那份拷贝收尾 */
export async function forkStorage(
  t: TestHost,
  source: DurableSession,
  toId: string
): Promise<IdleWorkResult<void>> {
  const result = await source.whileIdle(async () =>
    copyStorageFile(t.file(source.sessionId), t.file(toId))
  )
  if (result.ok) await resetForkedSessionState(await openNodeSqliteStorage(t.file(toId)))
  return result
}

export interface StorageDump {
  readonly state: Readonly<SessionState> | undefined
  readonly conversations: ConversationRecord[]
  /** 对话 id → 它自己的条目（不含继承的前缀），最旧在前 */
  readonly entries: Record<number, EntryRecord[]>
  readonly tasks: TaskRecord<JsonValue, JsonValue, JsonValue>[]
  /** 对话 id → AgentStateDoc（没有 → undefined） */
  readonly agentStates: Record<number, Readonly<AgentStateRecord> | undefined>
}

/** 按路径读一份原始存储的全貌（只读；读完关掉） */
export async function readStorage(file: string): Promise<StorageDump> {
  const session = createSession(await openNodeSqliteStorage(file))
  try {
    const state = await session.snapshot(SessionStateDoc, BG)
    const scanned = await session.commit(async (tx) => {
      const conversations = [...(await tx.scanConversations({}, 256)).items].sort(
        (a, b) => a.id - b.id
      )
      const entries: Record<number, EntryRecord[]> = {}
      for (const conversation of conversations) {
        const page = await tx.scanEntries(
          { conversationId: conversation.id, order: 'ascending' },
          1000
        )
        entries[conversation.id] = [...page.items]
      }
      const tasks = [...(await tx.scanTasks({}, 256)).items]
      return { conversations, entries, tasks }
    }, BG)
    const agentStates: Record<number, Readonly<AgentStateRecord> | undefined> = {}
    for (const conversation of scanned.conversations) {
      agentStates[conversation.id] = await session.snapshot(AgentStateDoc, conversation.id, BG)
    }
    return { state, ...scanned, agentStates }
  } finally {
    await session.close(BG)
  }
}
