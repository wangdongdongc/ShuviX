import Database from 'better-sqlite3'
import { join } from 'path'
import { mark, measure } from '../perf'
import { getDataDir } from '../utils/paths'
import { runMigrations } from './migrations'
import { BUILTIN_PROVIDERS } from '@shuvix/chat-protocol/providerCatalog'

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

    // 内置提供商目录来自 @shuvix/chat-protocol（与扩展共用单一来源）。
    // name 与 id 均为 pi-ai 的 provider slug；apiProtocol 对内置 provider 无实际作用（INSERT 用 DB 默认值）；
    // baseUrl 留空 '' 时 agentModelResolver 不覆盖，pi-ai 使用其 canonical URL。
    const exists = this.db.prepare('SELECT 1 FROM providers WHERE name = ?')
    const insert = this.db.prepare(
      'INSERT INTO providers (id, name, displayName, baseUrl, isBuiltin, isEnabled, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)'
    )

    const seedAll = this.db.transaction(() => {
      BUILTIN_PROVIDERS.forEach(({ name, displayName, baseUrl }, i) => {
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
