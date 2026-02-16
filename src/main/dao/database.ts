import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'

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

      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        apiKey TEXT DEFAULT '',
        baseUrl TEXT DEFAULT '',
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

    // 迁移：http_logs 表增加 token 用量字段
    this.migrateHttpLogsTokenColumns()

    // 种子数据：内置提供商和模型
    this.seedProviders()

    // 迁移旧 settings 表中的 provider 数据
    this.migrateOldSettings()
  }

  /** 种子数据：预置提供商和模型列表 */
  private seedProviders(): void {
    const now = Date.now()

    const builtinProviders = [
      { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', sortOrder: 0 },
      { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', sortOrder: 1 },
      { id: 'google', name: 'Google', baseUrl: 'https://generativelanguage.googleapis.com', sortOrder: 2 }
    ]

    const builtinModels: Record<string, string[]> = {
      openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3-mini', 'o4-mini'],
      anthropic: ['claude-sonnet-4-20250514', 'claude-haiku-3-5-20241022', 'claude-opus-4-20250514'],
      google: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash']
    }

    // 默认启用的模型（用户常用的）
    const defaultEnabled: Record<string, string[]> = {
      openai: ['gpt-4o-mini'],
      anthropic: ['claude-sonnet-4-20250514'],
      google: ['gemini-2.5-flash']
    }

    const insertProvider = this.db.prepare(
      'INSERT OR IGNORE INTO providers (id, name, baseUrl, isEnabled, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?, ?)'
    )
    const insertModel = this.db.prepare(
      'INSERT OR IGNORE INTO provider_models (id, providerId, modelId, isEnabled, sortOrder) VALUES (?, ?, ?, ?, ?)'
    )

    const seedAll = this.db.transaction(() => {
      for (const p of builtinProviders) {
        insertProvider.run(p.id, p.name, p.baseUrl, p.sortOrder, now, now)
      }
      for (const [providerId, models] of Object.entries(builtinModels)) {
        const enabled = defaultEnabled[providerId] || []
        models.forEach((modelId, idx) => {
          const id = `${providerId}:${modelId}`
          insertModel.run(id, providerId, modelId, enabled.includes(modelId) ? 1 : 0, idx)
        })
      }
    })
    seedAll()
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

    const migrate = this.db.transaction(() => {
      for (const row of rows) {
        if (row.key.startsWith('apiKey:')) {
          const providerId = row.key.replace('apiKey:', '')
          this.db.prepare('UPDATE providers SET apiKey = ?, updatedAt = ? WHERE id = ?')
            .run(row.value, Date.now(), providerId)
        } else if (row.key.startsWith('baseUrl:')) {
          const providerId = row.key.replace('baseUrl:', '')
          this.db.prepare('UPDATE providers SET baseUrl = ?, updatedAt = ? WHERE id = ?')
            .run(row.value, Date.now(), providerId)
        }
        // 删除已迁移的旧数据
        this.db.prepare('DELETE FROM settings WHERE key = ?').run(row.key)
      }
      // 同时清理旧的 provider/model 全局 key
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
