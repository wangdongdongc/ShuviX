import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { v7 as uuidv7 } from 'uuid'
import { mark, measure } from '../perf'

/**
 * 数据库连接管理
 * 负责 SQLite 连接初始化和表结构创建
 */
class DatabaseManager {
  private db: Database.Database

  constructor() {
    mark('database: constructor start')
    // 确保数据目录存在
    const userDataPath = app.getPath('userData')
    const dbDir = join(userDataPath, 'data')
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
    }

    const dbPath = join(dbDir, 'shuvix.db')
    this.db = measure('database: open', () => new Database(dbPath))

    // 启用 WAL 模式，提升并发性能
    this.db.pragma('journal_mode = WAL')

    measure('database: initTables', () => this.initTables())
    measure('database: migrate', () => this.migrate())
    // 种子数据在迁移之后执行，确保新列已存在
    measure('database: seed', () => this.seedProviders())
    mark('database: ready')
  }

  /** 增量迁移 */
  private migrate(): void {
    // 为已有 projects 表添加 archivedAt 列（新建表已包含该列）
    const projectCols = this.db.pragma('table_info(projects)') as { name: string }[]
    if (!projectCols.find((c) => c.name === 'archivedAt')) {
      this.db.exec('ALTER TABLE projects ADD COLUMN archivedAt INTEGER NOT NULL DEFAULT 0')
    }

    // 为已有 providers 表添加 displayName 列
    const providerCols = this.db.pragma('table_info(providers)') as { name: string }[]
    if (!providerCols.find((c) => c.name === 'displayName')) {
      this.db.exec("ALTER TABLE providers ADD COLUMN displayName TEXT NOT NULL DEFAULT ''")
    }

    // 旧版内置提供商名称迁移为 pi-ai slug（name 用作 getModel() 的 provider slug）
    const renameMap: Record<string, { slug: string; displayName: string }> = {
      'OpenAI': { slug: 'openai', displayName: 'OpenAI' },
      'Anthropic': { slug: 'anthropic', displayName: 'Anthropic' },
      'Google': { slug: 'google', displayName: 'Google' },
    }
    const renameStmt = this.db.prepare('UPDATE providers SET name = ?, displayName = ? WHERE name = ? AND isBuiltin = 1')
    for (const [oldName, { slug, displayName }] of Object.entries(renameMap)) {
      renameStmt.run(slug, displayName, oldName)
    }
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
        displayName TEXT NOT NULL DEFAULT '',
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
        path TEXT NOT NULL,
        systemPrompt TEXT NOT NULL DEFAULT '',
        dockerEnabled INTEGER NOT NULL DEFAULT 0,
        dockerImage TEXT NOT NULL DEFAULT '',
        sandboxEnabled INTEGER NOT NULL DEFAULT 1,
        settings TEXT NOT NULL DEFAULT '{}',
        archivedAt INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL DEFAULT 'stdio',
        command TEXT NOT NULL DEFAULT '',
        args TEXT NOT NULL DEFAULT '[]',
        env TEXT NOT NULL DEFAULT '{}',
        url TEXT NOT NULL DEFAULT '',
        headers TEXT NOT NULL DEFAULT '{}',
        isEnabled INTEGER NOT NULL DEFAULT 1,
        cachedTools TEXT NOT NULL DEFAULT '[]',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId);
      CREATE INDEX IF NOT EXISTS idx_provider_models_provider ON provider_models(providerId);
      CREATE INDEX IF NOT EXISTS idx_http_logs_createdAt ON http_logs(createdAt DESC);
    `)
  }

  /**
   * 种子数据：预置内置提供商
   * 模型列表由 providerService.syncAllBuiltinModels() 在启动时从 pi-ai 注册表同步
   */
  private seedProviders(): void {
    const now = Date.now()

    // name 必须与 pi-ai 的 provider slug 一致（agent.ts 用 name.toLowerCase() 调 getModel()）
    const builtinProviders: Array<{ name: string; displayName: string; baseUrl: string; apiProtocol: string; sortOrder: number }> = [
      { name: 'openai', displayName: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiProtocol: 'openai-completions', sortOrder: 0 },
      { name: 'anthropic', displayName: 'Anthropic', baseUrl: 'https://api.anthropic.com', apiProtocol: 'anthropic-messages', sortOrder: 1 },
      { name: 'google', displayName: 'Google', baseUrl: 'https://generativelanguage.googleapis.com', apiProtocol: 'google-generative-ai', sortOrder: 2 },
      { name: 'xai', displayName: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', apiProtocol: 'openai-completions', sortOrder: 3 },
      { name: 'groq', displayName: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiProtocol: 'openai-completions', sortOrder: 4 },
      { name: 'cerebras', displayName: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', apiProtocol: 'openai-completions', sortOrder: 5 },
      { name: 'mistral', displayName: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', apiProtocol: 'openai-completions', sortOrder: 6 },
      { name: 'openrouter', displayName: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiProtocol: 'openai-completions', sortOrder: 7 },
      { name: 'minimax', displayName: 'MiniMax', baseUrl: 'https://api.minimaxi.chat/v1', apiProtocol: 'openai-completions', sortOrder: 8 },
      { name: 'minimax-cn', displayName: 'MiniMax CN', baseUrl: 'https://api.minimax.chat/v1', apiProtocol: 'openai-completions', sortOrder: 9 },
      { name: 'huggingface', displayName: 'Hugging Face', baseUrl: 'https://router.huggingface.co/v1', apiProtocol: 'openai-completions', sortOrder: 10 },
      { name: 'opencode', displayName: 'OpenCode', baseUrl: 'https://opencode.ai/zen/v1', apiProtocol: 'openai-completions', sortOrder: 11 },
      { name: 'kimi-coding', displayName: 'Kimi Coding', baseUrl: 'https://api.kimi.com/coding', apiProtocol: 'anthropic-messages', sortOrder: 12 },
      { name: 'zai', displayName: 'ZAI (智谱)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiProtocol: 'openai-completions', sortOrder: 13 },
    ]

    const findByName = this.db.prepare('SELECT id, displayName FROM providers WHERE name = ?')
    const insertProvider = this.db.prepare(
      'INSERT INTO providers (id, name, displayName, baseUrl, apiProtocol, isBuiltin, isEnabled, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?)'
    )
    const updateDisplayName = this.db.prepare(
      'UPDATE providers SET displayName = ? WHERE id = ?'
    )

    const seedAll = this.db.transaction(() => {
      for (const p of builtinProviders) {
        const existing = findByName.get(p.name) as { id: string; displayName: string } | undefined
        if (!existing) {
          insertProvider.run(uuidv7(), p.name, p.displayName, p.baseUrl, p.apiProtocol, p.sortOrder, now, now)
        } else if (!existing.displayName) {
          // 旧数据迁移：补充 displayName
          updateDisplayName.run(p.displayName, existing.id)
        }
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
