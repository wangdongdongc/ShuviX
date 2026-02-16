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
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
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
        FOREIGN KEY (providerId) REFERENCES providers(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS http_logs (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        payload TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId);
      CREATE INDEX IF NOT EXISTS idx_provider_models_provider ON provider_models(providerId);
      CREATE INDEX IF NOT EXISTS idx_http_logs_createdAt ON http_logs(createdAt DESC);
    `)

    // 迁移：sessions 表增加工作目录 + Docker 字段
    this.migrateSessionsWorkingDirColumns()

    // 迁移：messages 表增加 type + metadata 列（支持工具调用）
    this.migrateMessagesToolColumns()

    // 迁移：http_logs 表增加 token 用量字段
    this.migrateHttpLogsTokenColumns()

    // 迁移：providers 表增加 apiProtocol / isBuiltin 字段
    this.migrateProvidersProtocolColumns()

    // 迁移：provider ID 统一为 uuidv7 格式
    this.migrateProviderIdsToUuidv7()

    // 种子数据：内置提供商和模型
    this.seedProviders()

    // 迁移旧 settings 表中的 provider 数据
    this.migrateOldSettings()
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

  /** 迁移：providers 表增加 apiProtocol / isBuiltin 字段 */
  private migrateProvidersProtocolColumns(): void {
    const columns = this.db.pragma('table_info(providers)') as Array<{ name: string }>
    const hasApiProtocol = columns.some((c) => c.name === 'apiProtocol')
    if (hasApiProtocol) return

    this.db.exec(`
      ALTER TABLE providers ADD COLUMN apiProtocol TEXT NOT NULL DEFAULT 'openai-completions';
      ALTER TABLE providers ADD COLUMN isBuiltin INTEGER NOT NULL DEFAULT 1;
    `)
    // 回填内置提供商的协议类型（按 name 匹配，兼容新旧 ID 格式）
    this.db.prepare("UPDATE providers SET apiProtocol = 'anthropic-messages' WHERE name = 'Anthropic'").run()
    this.db.prepare("UPDATE providers SET apiProtocol = 'google-generative-ai' WHERE name = 'Google'").run()
  }

  /** 迁移：将旧格式 provider ID（如 'openai'、'custom-xxx'）统一为 uuidv7 */
  private migrateProviderIdsToUuidv7(): void {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const providers = this.db.prepare('SELECT id FROM providers').all() as Array<{ id: string }>
    const needsMigration = providers.some((p) => !UUID_RE.test(p.id))
    if (!needsMigration) return

    // 暂停 FK 约束以便更新主键
    this.db.pragma('foreign_keys = OFF')
    const migrateTx = this.db.transaction(() => {
      for (const p of providers) {
        if (UUID_RE.test(p.id)) continue
        const newId = uuidv7()
        this.db.prepare('UPDATE provider_models SET providerId = ? WHERE providerId = ?').run(newId, p.id)
        this.db.prepare('UPDATE sessions SET provider = ? WHERE provider = ?').run(newId, p.id)
        this.db.prepare('UPDATE http_logs SET provider = ? WHERE provider = ?').run(newId, p.id)
        this.db.prepare('UPDATE providers SET id = ? WHERE id = ?').run(newId, p.id)
      }
    })
    migrateTx()
    this.db.pragma('foreign_keys = ON')
  }

  /** 迁移：sessions 表增加工作目录 + Docker 字段 */
  private migrateSessionsWorkingDirColumns(): void {
    const columns = this.db.pragma('table_info(sessions)') as Array<{ name: string }>
    const hasWorkingDir = columns.some((c) => c.name === 'workingDirectory')
    if (hasWorkingDir) return

    this.db.exec(`
      ALTER TABLE sessions ADD COLUMN workingDirectory TEXT NOT NULL DEFAULT '';
      ALTER TABLE sessions ADD COLUMN dockerEnabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN dockerImage TEXT NOT NULL DEFAULT 'ubuntu:latest';
    `)
  }

  /** 迁移：messages 表增加 type + metadata 列（支持工具调用） */
  private migrateMessagesToolColumns(): void {
    const columns = this.db.pragma('table_info(messages)') as Array<{ name: string }>
    const hasType = columns.some((c) => c.name === 'type')
    if (hasType) return

    this.db.exec(`
      ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text';
      ALTER TABLE messages ADD COLUMN metadata TEXT;
    `)
  }

  /** 迁移：http_logs 表增加 token 用量字段 */
  private migrateHttpLogsTokenColumns(): void {
    const columns = this.db.pragma('table_info(http_logs)') as Array<{ name: string }>
    const hasInputTokens = columns.some((c) => c.name === 'inputTokens')
    if (hasInputTokens) return

    this.db.exec(`
      ALTER TABLE http_logs ADD COLUMN inputTokens INTEGER DEFAULT 0;
      ALTER TABLE http_logs ADD COLUMN outputTokens INTEGER DEFAULT 0;
      ALTER TABLE http_logs ADD COLUMN totalTokens INTEGER DEFAULT 0;
    `)
  }

  /** 迁移旧 settings 表中的 apiKey:/baseUrl: 数据到 providers 表 */
  private migrateOldSettings(): void {
    const rows = this.db.prepare(
      "SELECT key, value FROM settings WHERE key LIKE 'apiKey:%' OR key LIKE 'baseUrl:%'"
    ).all() as Array<{ key: string; value: string }>

    if (rows.length === 0) return

    // 旧 slug → 提供商 name 的映射（旧 settings 键用的是 slug）
    const slugToName: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google' }

    const migrate = this.db.transaction(() => {
      for (const row of rows) {
        if (row.key.startsWith('apiKey:')) {
          const slug = row.key.replace('apiKey:', '')
          const name = slugToName[slug]
          if (name) {
            this.db.prepare('UPDATE providers SET apiKey = ?, updatedAt = ? WHERE name = ?')
              .run(row.value, Date.now(), name)
          }
        } else if (row.key.startsWith('baseUrl:')) {
          const slug = row.key.replace('baseUrl:', '')
          const name = slugToName[slug]
          if (name) {
            this.db.prepare('UPDATE providers SET baseUrl = ?, updatedAt = ? WHERE name = ?')
              .run(row.value, Date.now(), name)
          }
        }
        this.db.prepare('DELETE FROM settings WHERE key = ?').run(row.key)
      }
      this.db.prepare("DELETE FROM settings WHERE key IN ('provider', 'model')").run()
    })
    migrate()
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
