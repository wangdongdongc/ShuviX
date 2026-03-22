import Database from 'better-sqlite3'
import { join } from 'path'
import { mark, measure } from '../perf'
import { getDataDir } from '../utils/paths'
import { runMigrations } from './migrations'

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

    measure('database: migrations', () => runMigrations(this.db))
    measure('database: seed', () => this.seedProviders())
    mark('database: ready')
  }

  /**
   * 种子数据：预置内置提供商
   * 模型列表由 providerService.syncAllBuiltinModels() 在启动时从 pi-ai 注册表同步
   */
  private seedProviders(): void {
    const now = Date.now()

    // 迁移：将旧 UUID ID 的内置提供商降级为自定义提供商（避免 name 冲突）
    this.db
      .prepare(
        "UPDATE providers SET isBuiltin = 0, name = name || '-' || id WHERE isBuiltin = 1 AND id != name"
      )
      .run()

    // name 与 id 均为 pi-ai 的 provider slug
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
        apiProtocol: 'openai-responses',
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
        baseUrl: 'https://api.mistral.ai',
        apiProtocol: 'mistral-conversations',
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
        baseUrl: 'https://api.minimax.io/anthropic',
        apiProtocol: 'anthropic-messages',
        sortOrder: 8
      },
      {
        name: 'minimax-cn',
        displayName: 'MiniMax CN',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        apiProtocol: 'anthropic-messages',
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
        baseUrl: 'https://opencode.ai/zen',
        apiProtocol: 'anthropic-messages',
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
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
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
            p.name,
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
