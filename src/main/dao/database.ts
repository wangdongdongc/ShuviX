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

    // name 与 id 均为 pi-ai 的 provider slug
    // apiProtocol 对内置提供商无实际作用（由 pi-ai 注册表决定），INSERT 时使用 DB 默认值
    const builtinProviders: Array<[name: string, displayName: string, baseUrl: string]> = [
      ['openai', 'OpenAI', 'https://api.openai.com/v1'],
      ['anthropic', 'Anthropic', 'https://api.anthropic.com'],
      ['google', 'Google', 'https://generativelanguage.googleapis.com/v1beta'],
      ['xai', 'xAI (Grok)', 'https://api.x.ai/v1'],
      ['groq', 'Groq', 'https://api.groq.com/openai/v1'],
      ['cerebras', 'Cerebras', 'https://api.cerebras.ai/v1'],
      ['mistral', 'Mistral', 'https://api.mistral.ai'],
      ['openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1'],
      ['minimax', 'MiniMax', 'https://api.minimax.io/anthropic'],
      ['minimax-cn', 'MiniMax CN', 'https://api.minimaxi.com/anthropic'],
      ['huggingface', 'Hugging Face', 'https://router.huggingface.co/v1'],
      ['opencode', 'OpenCode', 'https://opencode.ai/zen'],
      ['kimi-coding', 'Kimi Coding', 'https://api.kimi.com/coding'],
      ['zai', 'ZAI (智谱)', 'https://api.z.ai/api/coding/paas/v4']
    ]

    const exists = this.db.prepare('SELECT 1 FROM providers WHERE name = ?')
    const insert = this.db.prepare(
      'INSERT INTO providers (id, name, displayName, baseUrl, isBuiltin, isEnabled, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)'
    )

    const seedAll = this.db.transaction(() => {
      builtinProviders.forEach(([name, displayName, baseUrl], i) => {
        if (!exists.get(name)) {
          insert.run(name, name, displayName, baseUrl, i, now, now)
        }
      })
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
