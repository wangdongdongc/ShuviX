import Database from 'better-sqlite3'
import { join } from 'path'
import { v7 as uuidv7 } from 'uuid'
import { mark, measure } from '../perf'
import { getDataDir } from '../utils/paths'

/**
 * 数据库连接管理
 * 负责 SQLite 连接初始化和表结构创建
 */
class DatabaseManager {
  private db: Database.Database

  constructor() {
    mark('database: constructor start')
    const dbPath = join(getDataDir(), 'shuvix.db')
    this.db = measure('database: open', () => new Database(dbPath))

    // 启用 WAL 模式，提升并发性能
    this.db.pragma('journal_mode = WAL')

    measure('database: initTables', () => this.initTables())
    measure('database: seed', () => this.seedProviders())
    mark('database: ready')
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
        settings TEXT NOT NULL DEFAULT '{}',
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
        response TEXT NOT NULL DEFAULT '',
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

      CREATE TABLE IF NOT EXISTS ssh_credentials (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22,
        username TEXT NOT NULL,
        authType TEXT NOT NULL DEFAULT 'password',
        password TEXT NOT NULL DEFAULT '',
        privateKey TEXT NOT NULL DEFAULT '',
        passphrase TEXT NOT NULL DEFAULT '',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS message_steps (
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

      CREATE TABLE IF NOT EXISTS telegram_bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token TEXT NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        allowedUsers TEXT NOT NULL DEFAULT '[]',
        isEnabled INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId);
      CREATE INDEX IF NOT EXISTS idx_message_steps_session ON message_steps(sessionId);
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
    const builtinProviders: Array<{
      name: string
      displayName: string
      baseUrl: string
      apiProtocol: string
      sortOrder: number
    }> = [
      {
        name: 'openai',
        displayName: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        apiProtocol: 'openai-completions',
        sortOrder: 0
      },
      {
        name: 'anthropic',
        displayName: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiProtocol: 'anthropic-messages',
        sortOrder: 1
      },
      {
        name: 'google',
        displayName: 'Google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiProtocol: 'google-generative-ai',
        sortOrder: 2
      },
      {
        name: 'xai',
        displayName: 'xAI (Grok)',
        baseUrl: 'https://api.x.ai/v1',
        apiProtocol: 'openai-completions',
        sortOrder: 3
      },
      {
        name: 'groq',
        displayName: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiProtocol: 'openai-completions',
        sortOrder: 4
      },
      {
        name: 'cerebras',
        displayName: 'Cerebras',
        baseUrl: 'https://api.cerebras.ai/v1',
        apiProtocol: 'openai-completions',
        sortOrder: 5
      },
      {
        name: 'mistral',
        displayName: 'Mistral',
        baseUrl: 'https://api.mistral.ai/v1',
        apiProtocol: 'openai-completions',
        sortOrder: 6
      },
      {
        name: 'openrouter',
        displayName: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiProtocol: 'openai-completions',
        sortOrder: 7
      },
      {
        name: 'minimax',
        displayName: 'MiniMax',
        baseUrl: 'https://api.minimaxi.chat/v1',
        apiProtocol: 'openai-completions',
        sortOrder: 8
      },
      {
        name: 'minimax-cn',
        displayName: 'MiniMax CN',
        baseUrl: 'https://api.minimax.chat/v1',
        apiProtocol: 'openai-completions',
        sortOrder: 9
      },
      {
        name: 'huggingface',
        displayName: 'Hugging Face',
        baseUrl: 'https://router.huggingface.co/v1',
        apiProtocol: 'openai-completions',
        sortOrder: 10
      },
      {
        name: 'opencode',
        displayName: 'OpenCode',
        baseUrl: 'https://opencode.ai/zen/v1',
        apiProtocol: 'openai-completions',
        sortOrder: 11
      },
      {
        name: 'kimi-coding',
        displayName: 'Kimi Coding',
        baseUrl: 'https://api.kimi.com/coding',
        apiProtocol: 'anthropic-messages',
        sortOrder: 12
      },
      {
        name: 'zai',
        displayName: 'ZAI (智谱)',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiProtocol: 'openai-completions',
        sortOrder: 13
      }
    ]

    const findByName = this.db.prepare('SELECT id, displayName FROM providers WHERE name = ?')
    const insertProvider = this.db.prepare(
      'INSERT INTO providers (id, name, displayName, baseUrl, apiProtocol, isBuiltin, isEnabled, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?)'
    )
    const updateDisplayName = this.db.prepare('UPDATE providers SET displayName = ? WHERE id = ?')

    const seedAll = this.db.transaction(() => {
      for (const p of builtinProviders) {
        const existing = findByName.get(p.name) as { id: string; displayName: string } | undefined
        if (!existing) {
          insertProvider.run(
            uuidv7(),
            p.name,
            p.displayName,
            p.baseUrl,
            p.apiProtocol,
            p.sortOrder,
            now,
            now
          )
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

/** DAO 基类 — 提供数据库连接访问与 prepared statement 缓存 */
export abstract class BaseDao {
  private static stmtCache = new Map<string, Database.Statement>()
  private static stmtCacheDb: Database.Database | null = null

  protected get db(): Database.Database {
    return databaseManager.getDb()
  }

  /** 获取或创建缓存的 prepared statement（DB 实例变更时自动清空缓存） */
  protected stmt(sql: string): Database.Statement {
    const currentDb = this.db
    if (BaseDao.stmtCacheDb !== currentDb) {
      BaseDao.stmtCache.clear()
      BaseDao.stmtCacheDb = currentDb
    }
    let s = BaseDao.stmtCache.get(sql)
    if (!s) {
      s = currentDb.prepare(sql)
      BaseDao.stmtCache.set(sql, s)
    }
    return s
  }
}
