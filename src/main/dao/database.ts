import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { v7 as uuidv7 } from 'uuid'

/**
 * 数据库连接管理
 * 负责 SQLite 连接初始化和表结构创建
 */
class DatabaseManager {
  private db: Database.Database

  constructor() {
    // 确保数据目录存在
    const userDataPath = app.getPath('userData')
    const dbDir = join(userDataPath, 'data')
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
    }

    const dbPath = join(dbDir, 'shuvix.db')
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
        projectId TEXT DEFAULT NULL,
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        systemPrompt TEXT NOT NULL DEFAULT 'You are a helpful assistant.',
        modelMetadata TEXT NOT NULL DEFAULT '',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        role TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        metadata TEXT DEFAULT '{}',
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        apiKey TEXT DEFAULT '',
        baseUrl TEXT DEFAULT '',
        apiProtocol TEXT NOT NULL DEFAULT 'openai-completions',
        isBuiltin INTEGER NOT NULL DEFAULT 1,
        isEnabled INTEGER DEFAULT 1,
        sortOrder INTEGER DEFAULT 0,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_models (
        id TEXT PRIMARY KEY,
        providerId TEXT NOT NULL,
        modelId TEXT NOT NULL,
        isEnabled INTEGER DEFAULT 0,
        sortOrder INTEGER DEFAULT 0,
        capabilities TEXT DEFAULT '{}',
        FOREIGN KEY (providerId) REFERENCES providers(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS http_logs (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        payload TEXT NOT NULL,
        inputTokens INTEGER DEFAULT 0,
        outputTokens INTEGER DEFAULT 0,
        totalTokens INTEGER DEFAULT 0,
        createdAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        systemPrompt TEXT NOT NULL DEFAULT '',
        dockerEnabled INTEGER NOT NULL DEFAULT 0,
        dockerImage TEXT NOT NULL DEFAULT 'ubuntu:latest',
        settings TEXT NOT NULL DEFAULT '{}',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId);
      CREATE INDEX IF NOT EXISTS idx_provider_models_provider ON provider_models(providerId);
      CREATE INDEX IF NOT EXISTS idx_http_logs_createdAt ON http_logs(createdAt DESC);
    `)


    // 种子数据：内置提供商和模型
    this.seedProviders()
  }

  /** 种子数据：预置提供商和模型列表 */
  private seedProviders(): void {
    const now = Date.now()

    const builtinProviders = [
      { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiProtocol: 'openai-completions', sortOrder: 0,
        models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3-mini', 'o4-mini'],
        defaultEnabled: ['gpt-4o-mini'] },
      { name: 'Anthropic', baseUrl: 'https://api.anthropic.com', apiProtocol: 'anthropic-messages', sortOrder: 1,
        models: ['claude-sonnet-4-20250514', 'claude-haiku-3-5-20241022', 'claude-opus-4-20250514'],
        defaultEnabled: ['claude-sonnet-4-20250514'] },
      { name: 'Google', baseUrl: 'https://generativelanguage.googleapis.com', apiProtocol: 'google-generative-ai', sortOrder: 2,
        models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
        defaultEnabled: ['gemini-2.5-flash'] }
    ]

    const findByName = this.db.prepare('SELECT id FROM providers WHERE name = ?')
    const insertProvider = this.db.prepare(
      'INSERT INTO providers (id, name, baseUrl, apiProtocol, isBuiltin, isEnabled, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)'
    )
    const findModel = this.db.prepare('SELECT id FROM provider_models WHERE providerId = ? AND modelId = ?')
    const insertModel = this.db.prepare(
      'INSERT INTO provider_models (id, providerId, modelId, isEnabled, sortOrder) VALUES (?, ?, ?, ?, ?)'
    )

    const seedAll = this.db.transaction(() => {
      for (const p of builtinProviders) {
        let existing = findByName.get(p.name) as { id: string } | undefined
        if (!existing) {
          const id = uuidv7()
          insertProvider.run(id, p.name, p.baseUrl, p.apiProtocol, p.sortOrder, now, now)
          existing = { id }
        }
        const providerId = existing.id
        p.models.forEach((modelId, idx) => {
          if (!findModel.get(providerId, modelId)) {
            insertModel.run(uuidv7(), providerId, modelId, p.defaultEnabled.includes(modelId) ? 1 : 0, idx)
          }
        })
      }
    })
    seedAll()
  }

  /** 获取数据库连接实例 */
  getDb(): Database.Database {
    return this.db
  }

  /** 关闭数据库连接 */
  close(): void {
    this.db.close()
  }
}

// 全局单例
export const databaseManager = new DatabaseManager()
