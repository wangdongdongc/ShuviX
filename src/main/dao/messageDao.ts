import { BaseDao } from './database'
import { buildJsonPatch } from './utils'
import type { Message, MessageMetadata } from './types'

/** DB 原始行类型（metadata 在 DB 中为字符串） */
type MessageRow = Omit<Message, 'metadata'> & { metadata: string | null }

/** 安全解析 JSON，失败返回 null */
function safeParseMeta(json: string | null | undefined): MessageMetadata | null {
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

/** 将 DB 行的 metadata 字符串解析为类型化对象 */
function parseRow(row: MessageRow): Message {
  return { ...row, metadata: safeParseMeta(row.metadata) }
}

/**
 * Message DAO — messages 表的纯数据访问操作
 */
/** messages 表中的合法消息类型 */
const MESSAGE_TYPES = ['text', 'docker_event', 'ssh_event', 'error_event']
/** message_steps 表中的合法消息类型 */
const STEP_TYPES = ['tool_use', 'step_text', 'step_thinking']

export class MessageDao extends BaseDao {
  /** 获取某个会话的所有消息，按时间升序（仅读取当前合法类型，忽略旧格式数据） */
  findBySessionId(sessionId: string): Message[] {
    const placeholders = MESSAGE_TYPES.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE sessionId = ? AND type IN (${placeholders}) ORDER BY createdAt ASC`
      )
      .all(sessionId, ...MESSAGE_TYPES) as MessageRow[]
    return rows.map(parseRow)
  }

  /** 插入消息 */
  insert(message: Message): void {
    this.db
      .prepare(
        'INSERT INTO messages (id, sessionId, role, type, content, metadata, model, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        message.id,
        message.sessionId,
        message.role,
        message.type,
        message.content,
        message.metadata ? JSON.stringify(message.metadata) : null,
        message.model,
        message.createdAt
      )
  }

  /** 根据 ID 获取单条消息 */
  findById(id: string): Message | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      | MessageRow
      | undefined
    return row ? parseRow(row) : undefined
  }

  /** 跨表查找：先查 messages，未找到再查 message_steps */
  findByIdAcrossTables(id: string): Message | undefined {
    const msg = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      | MessageRow
      | undefined
    if (msg) return parseRow(msg)
    const step = this.db.prepare('SELECT * FROM message_steps WHERE id = ?').get(id) as
      | MessageRow
      | undefined
    return step ? parseRow(step) : undefined
  }

  /** 删除某个会话的所有消息 */
  deleteBySessionId(sessionId: string): void {
    this.db.prepare('DELETE FROM messages WHERE sessionId = ?').run(sessionId)
  }

  /** 按时间戳删除：删除 createdAt > timestamp 的记录 */
  deleteAfterTimestamp(sessionId: string, createdAt: number): number {
    return this.db
      .prepare('DELETE FROM messages WHERE sessionId = ? AND createdAt > ?')
      .run(sessionId, createdAt).changes
  }

  /** 按时间戳删除：删除 createdAt >= timestamp 的记录 */
  deleteFromTimestamp(sessionId: string, createdAt: number): number {
    return this.db
      .prepare('DELETE FROM messages WHERE sessionId = ? AND createdAt >= ?')
      .run(sessionId, createdAt).changes
  }

  /** 删除指定消息之后的所有消息（不含该消息本身） */
  deleteAfterMessage(sessionId: string, messageId: string): number {
    const target = this.findById(messageId)
    if (!target) return 0
    return this.db
      .prepare('DELETE FROM messages WHERE sessionId = ? AND createdAt > ?')
      .run(sessionId, target.createdAt).changes
  }

  /** 删除指定消息及其之后的所有消息（含该消息本身） */
  deleteFromMessage(sessionId: string, messageId: string): number {
    const target = this.findById(messageId)
    if (!target) return 0
    return this.db
      .prepare('DELETE FROM messages WHERE sessionId = ? AND createdAt >= ?')
      .run(sessionId, target.createdAt).changes
  }
}

/**
 * MessageStep DAO — message_steps 表的纯数据访问操作
 * 与 MessageDao 列完全一致，存放工具调用/结果等中间步骤
 */
export class MessageStepDao extends BaseDao {
  /** 获取某个会话的所有步骤消息，按时间升序（仅读取当前合法类型，忽略旧格式数据） */
  findBySessionId(sessionId: string): Message[] {
    const placeholders = STEP_TYPES.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT * FROM message_steps WHERE sessionId = ? AND type IN (${placeholders}) ORDER BY createdAt ASC`
      )
      .all(sessionId, ...STEP_TYPES) as MessageRow[]
    return rows.map(parseRow)
  }

  /** 插入步骤消息 */
  insert(message: Message): void {
    this.db
      .prepare(
        'INSERT INTO message_steps (id, sessionId, role, type, content, metadata, model, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        message.id,
        message.sessionId,
        message.role,
        message.type,
        message.content,
        message.metadata ? JSON.stringify(message.metadata) : null,
        message.model,
        message.createdAt
      )
  }

  /** 根据 ID 获取单条步骤消息 */
  findById(id: string): Message | undefined {
    const row = this.db.prepare('SELECT * FROM message_steps WHERE id = ?').get(id) as
      | MessageRow
      | undefined
    return row ? parseRow(row) : undefined
  }

  /** 删除某个会话的所有步骤消息 */
  deleteBySessionId(sessionId: string): void {
    this.db.prepare('DELETE FROM message_steps WHERE sessionId = ?').run(sessionId)
  }

  /** 按时间戳删除：删除 createdAt > timestamp 的记录 */
  deleteAfterTimestamp(sessionId: string, createdAt: number): number {
    return this.db
      .prepare('DELETE FROM message_steps WHERE sessionId = ? AND createdAt > ?')
      .run(sessionId, createdAt).changes
  }

  /** 按时间戳删除：删除 createdAt >= timestamp 的记录 */
  deleteFromTimestamp(sessionId: string, createdAt: number): number {
    return this.db
      .prepare('DELETE FROM message_steps WHERE sessionId = ? AND createdAt >= ?')
      .run(sessionId, createdAt).changes
  }

  /** 更新步骤消息的 content 字段 */
  updateContent(id: string, content: string): void {
    this.db.prepare('UPDATE message_steps SET content = ? WHERE id = ?').run(content, id)
  }

  /** 更新步骤消息的 metadata（patch 语义：仅更新传入的字段，其余保留） */
  patchMetadata(id: string, patch: Partial<MessageMetadata>): void {
    const { setClauses, values } = buildJsonPatch(patch as Record<string, unknown>)
    if (!setClauses) return
    this.db
      .prepare(
        `UPDATE message_steps SET metadata = json_set(COALESCE(metadata, '{}'), ${setClauses}) WHERE id = ?`
      )
      .run(...values, id)
  }

  /** 获取某个会话的最后一条步骤消息（仅读取当前合法类型） */
  findLastBySessionId(sessionId: string): Message | undefined {
    const placeholders = STEP_TYPES.map(() => '?').join(',')
    const row = this.db
      .prepare(
        `SELECT * FROM message_steps WHERE sessionId = ? AND type IN (${placeholders}) ORDER BY createdAt DESC LIMIT 1`
      )
      .get(sessionId, ...STEP_TYPES) as MessageRow | undefined
    return row ? parseRow(row) : undefined
  }
}

export const messageDao = new MessageDao()
export const messageStepDao = new MessageStepDao()
