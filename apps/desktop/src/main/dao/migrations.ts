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
  },
  {
    version: 3,
    description: '新增 mcp_server_logs 表（MCP 对外服务工具调用日志）',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_server_logs (
          id TEXT PRIMARY KEY,
          sessionId TEXT NOT NULL DEFAULT '',
          clientName TEXT NOT NULL DEFAULT '',
          clientVersion TEXT NOT NULL DEFAULT '',
          toolName TEXT NOT NULL DEFAULT '',
          arguments TEXT NOT NULL DEFAULT '',
          result TEXT NOT NULL DEFAULT '',
          isError INTEGER NOT NULL DEFAULT 0,
          durationMs INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mcp_server_logs_created ON mcp_server_logs(createdAt);
      `)
    }
  },
  {
    version: 4,
    description: '为 providers、mcp_servers、telegram_bots 表添加 metadata 列',
    up: (db) => {
      db.exec(`ALTER TABLE providers ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`)
      db.exec(`ALTER TABLE mcp_servers ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`)
      db.exec(`ALTER TABLE telegram_bots ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`)
    }
  },
  {
    version: 5,
    description: '为 messages 和 message_steps 表添加 archived 列（Full Compaction）',
    up: (db) => {
      db.exec(`ALTER TABLE messages ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`)
      db.exec(`ALTER TABLE message_steps ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_messages_session_archived ON messages(sessionId, archived)`
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_message_steps_session_archived ON message_steps(sessionId, archived)`
      )
    }
  },
  {
    version: 6,
    description: '新增 custom_sub_agents 表（子智能体配置）',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS custom_sub_agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          displayName TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          systemPrompt TEXT NOT NULL DEFAULT '',
          tools TEXT NOT NULL DEFAULT '[]',
          maxTurns INTEGER NOT NULL DEFAULT 40,
          isBuiltin INTEGER NOT NULL DEFAULT 0,
          isEnabled INTEGER NOT NULL DEFAULT 1,
          metadata TEXT NOT NULL DEFAULT '{}',
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
      `)
      // 原本此处种子了内置 explore 子智能体，v10 迁移已将其移至代码定义
      // (src/main/subagent/builtins/)，并清除 isBuiltin=1 的 DB 行。
    }
  },
  {
    version: 7,
    description: '将 projects.systemPrompt 列从 plain text 转为 JSON 信封 {sections:[]}',
    up: (db) => {
      // 老 plain text 内容直接清空(用户决策),改为标准空信封
      db.exec(`UPDATE projects SET systemPrompt = '{"sections":[]}'`)
    }
  },
  {
    version: 8,
    description: '删除 projects.sandboxEnabled 列(改用会话级 settings.autoAllow 统一控制)',
    up: (db) => {
      // SQLite 3.35+ 支持 DROP COLUMN(better-sqlite3 内置版本满足)
      db.exec(`ALTER TABLE projects DROP COLUMN sandboxEnabled`)
    }
  },
  {
    version: 9,
    description: '新增 widgets 表（AI 创建的常驻迷你 Web 小工具）',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS widgets (
          id           TEXT PRIMARY KEY,
          name         TEXT NOT NULL,
          description  TEXT NOT NULL DEFAULT '',
          entryFile    TEXT NOT NULL DEFAULT 'index.tsx',
          createdAt    INTEGER NOT NULL,
          updatedAt    INTEGER NOT NULL,
          lastOpenedAt INTEGER NOT NULL DEFAULT 0,
          openCount    INTEGER NOT NULL DEFAULT 0,
          archivedAt   INTEGER NOT NULL DEFAULT 0,
          metadata     TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_widgets_lastOpenedAt ON widgets(lastOpenedAt DESC);
      `)
    }
  },
  {
    version: 10,
    description:
      '为 mcp_servers 表添加 isBuiltin 列并种子内置 Tavily MCP；将内置 sub-agent 迁移至代码定义',
    up: (db) => {
      // 1. 扩展 mcp_servers：isBuiltin 标记内置 server（不可删除，除 env/isEnabled 外字段只读）
      db.exec(`ALTER TABLE mcp_servers ADD COLUMN isBuiltin INTEGER NOT NULL DEFAULT 0`)

      const now = Date.now()

      // 2. 种子：内置 Tavily MCP（远程 HTTP endpoint，{{TAVILY_API_KEY}} 在连接时替换）
      db.prepare(
        `INSERT OR IGNORE INTO mcp_servers
           (id, name, type, command, args, env, url, headers, metadata, isEnabled, isBuiltin, cachedTools, createdAt, updatedAt)
         VALUES (?, ?, 'http', '', '[]', ?, ?, '{}', '{}', 0, 1, '[]', ?, ?)`
      ).run(
        'builtin-mcp-tavily',
        'tavily',
        JSON.stringify({ TAVILY_API_KEY: '' }),
        'https://mcp.tavily.com/mcp/?tavilyApiKey={{TAVILY_API_KEY}}',
        now,
        now
      )

      // 3. 将 v6 种子的内置 sub-agent（explore 等）从 DB 迁移至代码定义：
      //    先把用户已禁用的项名存到 settings（保留用户偏好），再删除所有 isBuiltin=1 行。
      //    此后内置 sub-agent 由 src/main/subagent/builtins/ 加载，i18n 与 prompt 随版本更新无需 DB 迁移。
      interface BuiltinRow {
        name: string
        isEnabled: number
      }
      const builtinRows = db
        .prepare('SELECT name, isEnabled FROM custom_sub_agents WHERE isBuiltin = 1')
        .all() as BuiltinRow[]
      const disabledNames = builtinRows.filter((r) => r.isEnabled === 0).map((r) => r.name)
      if (disabledNames.length > 0) {
        db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(
          'subagent.builtinDisabled',
          JSON.stringify(disabledNames)
        )
      }
      db.exec(`DELETE FROM custom_sub_agents WHERE isBuiltin = 1`)
    }
  },
  {
    version: 11,
    description: '禁用 pi-ai 0.71 已移除的 google-gemini-cli / google-antigravity provider',
    up: (db) => {
      const removed = ['google-gemini-cli', 'google-antigravity']
      const stmt = db.prepare(
        `UPDATE providers SET isEnabled = 0, updatedAt = ? WHERE name = ? AND isEnabled = 1`
      )
      const now = Date.now()
      for (const name of removed) {
        const result = stmt.run(now, name)
        if (result.changes > 0) {
          log.warn(
            `Provider "${name}" 已被 pi-ai 0.71 移除，自动禁用。如需继续使用请通过自定义 provider 重新接入。`
          )
        }
      }
    }
  },
  {
    version: 12,
    description:
      '废弃 custom_sub_agents 表：sub-agent 改由文件系统管理（resources/agents + ~/.shuvix/agents/<name>/AGENT.md）',
    up: (db) => {
      // 用户自定义 sub-agent 不做数据迁移 —— 用户需在 ~/.shuvix/agents/ 下重建 AGENT.md。
      // 历史 tool_use 消息（toolName='explore'/'research'/<custom>）不改写，依赖 ToolCallBlock fallback
      // (presentation?.label || toolName) + Wrench 默认图标渲染。
      db.exec(`DROP TABLE IF EXISTS custom_sub_agents`)
      // 旧 settings key 设为孤儿（无副作用），如需洁癖可一并清理
      db.prepare(`DELETE FROM settings WHERE key = ?`).run('subagent.builtinDisabled')
    }
  },
  {
    version: 13,
    description:
      '废弃 widgets 表：widget 改由文件系统管理（<dir>/widget.json + <dir>/schema.sql + widgets/.config.json）',
    up: (db) => {
      // 不做数据迁移（明确的产品决定）。身份字段本来就有同名副本落在每个 widget 目录的
      // widget.json 里，扫描即可恢复；仅 DB 独有的三类状态就此丢弃：
      //   - metadata.dbSchema → 已建库的 widget 失去自愈重放，需重跑一次 db-init
      //   - archivedAt        → 已归档的 widget 会重新出现在活跃列表里
      //   - lastOpenedAt      → 卡片排序退回按创建时间
      db.exec(`DROP TABLE IF EXISTS widgets`)
    }
  },
  {
    version: 14,
    description:
      '会话转写迁出数据库：改由 pi AgentHarness 的 JSONL 会话树承载（<userData>/data/sessions/<id>.jsonl），废弃 messages / message_steps',
    up: (db) => {
      // 不做数据迁移（明确的产品决定，早期无存量用户）。两张旧表整体丢弃：
      //   - messages / message_steps 的行模型（role+type+content+metadata）是 UI 契约，
      //     与 pi 的 AgentMessage 不同构；逐行回填会引入一层永久的兼容投影，
      //     正是本次要消除的东西。
      //   - archived 归档位随之消失：压缩改由 compaction entry + 构建期过滤表达。
      //
      // 对话内容不再进数据库：会话树是 append-only 的 entry 流，SQLite 在这里没有
      // 查询优势（ShuviX 从不按消息内容做 SQL 查询），JSONL 反而更快（一次读进内存）
      // 且可读可 diff。sessions 表继续存业务字段，leafId 由 JSONL 文件自身推导。
      db.exec(`DROP TABLE IF EXISTS messages`)
      db.exec(`DROP TABLE IF EXISTS message_steps`)
    }
  },
  {
    version: 15,
    description:
      '运行配置以会话树为唯一事实源：删除 sessions 的 provider / model / modelMetadata / systemPrompt 列',
    up: (db) => {
      // 这四列在 JSONL 会话树里都有对应表达，留着就是两份可漂移的副本：
      //   provider + model        → model_change entry
      //   modelMetadata           → thinking_level_change + active_tools_change entry
      //   systemPrompt            → 本来就是死列（写入后从无读取；实际提示词由
      //                             buildSystemPrompt() 每次现算）
      // 读当前值走 agent.init（从树上推导），改动走 agent.setModel / setThinkingLevel /
      // setEnabledTools（Agent 未创建时后端直接往树上追加 entry）。
      db.exec(`ALTER TABLE sessions DROP COLUMN provider`)
      db.exec(`ALTER TABLE sessions DROP COLUMN model`)
      db.exec(`ALTER TABLE sessions DROP COLUMN modelMetadata`)
      db.exec(`ALTER TABLE sessions DROP COLUMN systemPrompt`)
    }
  },
  {
    version: 16,
    description:
      '群聊会话改用 chat_messages 表承载转写（v2）：新建表，并**删除**既有聊天会话（不做数据迁移）',
    up: (db) => {
      // 群聊消息是**平的**：没有分叉、没有工具块/思考块、没有压缩切点 —— 会话树的那些能力
      // 一个都用不上，而「谁说的」在树的数据模型里只能靠署名侧车（消息前多写一条 custom
      // entry，投影时靠「紧邻」配对）这种补丁表达。一列 authorKind + botName 取代整套机制。
      //
      // displayName 存**落库当时**的显示名：bot md 被删或改名后，历史消息仍然显示当初那个
      // 名字（与 v1 的侧车同一条纪律，历史永不裂）。decision 是 clarify 回连的判定材料
      // （上一条 bot 消息是某个 bot 的 clarify 时，下一条无提及消息硬路由回它）。
      //
      // hop / rootId 是 bot 响应 bot 的两道护栏：hop 保证链路必然终止（纵向），
      // rootId 让「同一条用户消息引发了多少条 bot 消息」可数（横向）。缺省
      // `shuvix-bot-respond-to: user` 下两者恒为 0 / 自身，护栏不生效也不花钱。
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id           TEXT PRIMARY KEY,
          sessionId    TEXT NOT NULL,
          seq          INTEGER NOT NULL,
          authorKind   TEXT NOT NULL,
          botName      TEXT,
          displayName  TEXT,
          content      TEXT NOT NULL,
          decision     TEXT,
          reply        TEXT,
          inlineTokens TEXT,
          attachments  TEXT,
          isError      INTEGER NOT NULL DEFAULT 0,
          replyToId    TEXT,
          rootId       TEXT,
          hop          INTEGER NOT NULL DEFAULT 0,
          createdAt    INTEGER NOT NULL
        )
      `)
      // 会话内按 seq 取全量/区间（列表、回退区间、笔记增量窗）—— 唯一的查询形状
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_chat_messages_session_seq ON chat_messages(sessionId, seq)`
      )

      // **删除既有聊天会话**（产品裁决：不做数据迁移）。它们的转写在 JSONL 会话树里，
      // 新渲染路径没有读它的来源；留着等于在侧栏里放几条点开就空白的会话，比删掉更糟。
      // 对应的 `<userData>/data/sessions/<id>.jsonl` 成为孤儿文件 —— 与既有策略一致
      // （sessionStorage 明确不做启动扫描兜底：后果只是几个不再被引用的文本文件）。
      db.exec(`
        DELETE FROM sessions
        WHERE json_array_length(json_extract(settings, '$.bots')) > 0
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
