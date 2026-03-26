import Database from 'better-sqlite3'
import { createLogger } from '../logger'

const log = createLogger('Migration')

export interface Migration {
  version: number
  description: string
  up: (db: Database.Database) => void
}

/**
 * 增量迁移脚本列表
 *
 * 规则：
 * 1. version 从 1 开始严格递增，不可跳号、不可乱序
 * 2. 新迁移只能追加到数组末尾，已发布的迁移不可修改
 * 3. up() 应保持幂等（使用 IF NOT EXISTS / try-catch），因为失败重试会再次执行
 * 4. 只写原始 SQL，不引用应用层代码（Service / DAO）
 * 5. ALTER TABLE ADD COLUMN 必须带 DEFAULT 值
 *
 * 添加新迁移示例：
 * ```ts
 * {
 *   version: 2,
 *   description: '为 sessions 表添加 tags 列',
 *   up: (db) => {
 *     db.exec(`ALTER TABLE sessions ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`)
 *   }
 * }
 * ```
 */
export const migrations: Migration[] = [
  {
    version: 1,
    description: '基线：创建所有初始表和索引',
    up: (db) => {
      db.exec(`
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
          metadata TEXT NOT NULL DEFAULT '{}',
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

      // 兼容旧数据库：ssh_credentials 可能缺少 metadata 列
      try {
        db.exec(`ALTER TABLE ssh_credentials ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`)
      } catch {
        // 列已存在，忽略
      }
    }
  },
  {
    version: 2,
    description: '新增 db_credentials 表（远程 MySQL/PostgreSQL 凭据）',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS db_credentials (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          dbType TEXT NOT NULL,
          host TEXT NOT NULL DEFAULT '',
          port INTEGER NOT NULL DEFAULT 0,
          username TEXT NOT NULL DEFAULT '',
          password TEXT NOT NULL DEFAULT '',
          database TEXT NOT NULL DEFAULT '',
          authType TEXT NOT NULL DEFAULT 'password',
          token TEXT NOT NULL DEFAULT '',
          connStr TEXT NOT NULL DEFAULT '',
          readonly INTEGER NOT NULL DEFAULT 1,
          metadata TEXT NOT NULL DEFAULT '{}',
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_db_credentials_name ON db_credentials(name);
      `)
    }
  }
]

/** 校验迁移数组合法性 */
function validateMigrations(): void {
  for (let i = 0; i < migrations.length; i++) {
    const expected = i + 1
    if (migrations[i].version !== expected) {
      throw new Error(
        `Migration versions must be sequential: expected ${expected}, got ${migrations[i].version}`
      )
    }
  }
}

/**
 * 执行增量迁移
 *
 * 工作流程：
 * 1. 校验迁移数组合法性（版本连续、无重复）
 * 2. 读取 PRAGMA user_version 获取当前 schema 版本（新数据库为 0）
 * 3. 若已是最新版本，短路返回（零开销）
 * 4. 按版本号升序逐个执行待迁移项，每个迁移在独立事务中完成
 * 5. 每个迁移成功后更新 user_version，确保失败时可从断点恢复
 *
 * @returns 实际执行的迁移数量
 */
export function runMigrations(db: Database.Database): number {
  validateMigrations()

  const currentVersion = db.pragma('user_version', { simple: true }) as number
  const latestVersion = migrations.length > 0 ? migrations[migrations.length - 1].version : 0

  if (currentVersion >= latestVersion) {
    if (currentVersion > latestVersion) {
      log.warn(
        `Schema version (${currentVersion}) is ahead of latest migration (${latestVersion}), skipping`
      )
    }
    return 0
  }

  log.info(
    `Schema v${currentVersion} → v${latestVersion}, ${latestVersion - currentVersion} migration(s) pending`
  )

  const pending = migrations.filter((m) => m.version > currentVersion)

  for (const m of pending) {
    log.info(`Running migration v${m.version}: ${m.description}`)
    db.transaction(() => {
      m.up(db)
      // user_version 写入数据库文件头 page 1，参与事务写集合
      // 事务回滚时 version 一并恢复，保证 schema 变更与版本号原子一致
      db.pragma(`user_version = ${m.version}`)
    })()
    log.info(`Migration v${m.version} complete`)
  }

  return pending.length
}
