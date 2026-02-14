import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'

/** 会话数据结构 */
export interface Session {
  id: string
  title: string
  provider: string
  model: string
  systemPrompt: string
  createdAt: number
  updatedAt: number
}

/** 消息数据结构 */
export interface Message {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

/** 设置数据结构 */
export interface Settings {
  key: string
  value: string
}

/**
 * 存储服务 — 使用 SQLite 持久化会话、消息和设置
 */
export class StorageService {
  private db: Database.Database

  constructor() {
    // 确保数据目录存在
    const userDataPath = app.getPath('userData')
    const dbDir = join(userDataPath, 'data')
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
    }

    const dbPath = join(dbDir, 'shirobot.db')
    this.db = new Database(dbPath)

    // 启用 WAL 模式，提升并发性能
    this.db.pragma('journal_mode = WAL')

    this.initTables()
  }

  /** 初始化数据库表 */
  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'openai',
        model TEXT NOT NULL DEFAULT 'gpt-4o-mini',
        systemPrompt TEXT NOT NULL DEFAULT 'You are a helpful assistant.',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId);
    `)
  }

  // ============ 会话操作 ============

  /** 获取所有会话，按更新时间倒序 */
  getSessions(): Session[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY updatedAt DESC')
      .all() as Session[]
  }

  /** 获取单个会话 */
  getSession(id: string): Session | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined
  }

  /** 创建会话 */
  createSession(session: Session): Session {
    this.db
      .prepare(
        'INSERT INTO sessions (id, title, provider, model, systemPrompt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        session.id,
        session.title,
        session.provider,
        session.model,
        session.systemPrompt,
        session.createdAt,
        session.updatedAt
      )
    return session
  }

  /** 更新会话标题 */
  updateSessionTitle(id: string, title: string): void {
    this.db
      .prepare('UPDATE sessions SET title = ?, updatedAt = ? WHERE id = ?')
      .run(title, Date.now(), id)
  }

  /** 更新会话时间戳 */
  touchSession(id: string): void {
    this.db.prepare('UPDATE sessions SET updatedAt = ? WHERE id = ?').run(Date.now(), id)
  }

  /** 删除会话及其所有消息 */
  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE sessionId = ?').run(id)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  // ============ 消息操作 ============

  /** 获取某个会话的所有消息 */
  getMessages(sessionId: string): Message[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE sessionId = ? ORDER BY createdAt ASC')
      .all(sessionId) as Message[]
  }

  /** 添加消息 */
  addMessage(message: Message): Message {
    this.db
      .prepare(
        'INSERT INTO messages (id, sessionId, role, content, createdAt) VALUES (?, ?, ?, ?, ?)'
      )
      .run(message.id, message.sessionId, message.role, message.content, message.createdAt)

    // 更新会话时间戳
    this.touchSession(message.sessionId)
    return message
  }

  /** 删除某个会话的所有消息 */
  clearMessages(sessionId: string): void {
    this.db.prepare('DELETE FROM messages WHERE sessionId = ?').run(sessionId)
  }

  // ============ 设置操作 ============

  /** 获取设置 */
  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  /** 保存设置 */
  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(key, value)
  }

  /** 获取所有设置 */
  getAllSettings(): Record<string, string> {
    const rows = this.db.prepare('SELECT * FROM settings').all() as Settings[]
    const result: Record<string, string> = {}
    for (const row of rows) {
      result[row.key] = row.value
    }
    return result
  }

  /** 关闭数据库 */
  close(): void {
    this.db.close()
  }
}

// 全局单例
export const storageService = new StorageService()
