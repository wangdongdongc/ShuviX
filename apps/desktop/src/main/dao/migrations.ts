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
      // hop / rootId 曾是 bot 响应 bot 的两道护栏（纵向跳数 / 横向扇出计数）。接力已经
      // 取消：新写入 hop 恒为 0、rootId 恒空，两列留作遗留 —— SQLite 删列不值一次迁移。
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
  },
  {
    version: 17,
    description: '子会话：sessions 增加 parentId 列（agent 经 session 工具自建的会话的父指针）',
    up: (db) => {
      // 父子是**关系**不是形态配置，所以是一列而不是 settings 键 —— 与 projectId 同层同用途
      // （指向另一行、只被列表分组消费）。另两个理由是硬的：settings 的 JSON patch 没有删键
      // 路径（见 SessionSettings.bots 的注释），而父子关系必须能被解除；级联删除要的是
      // `WHERE parentId = ?`，不是把每条会话的 JSON 拉出来扫。
      db.exec(`ALTER TABLE sessions ADD COLUMN parentId TEXT DEFAULT NULL`)
      // 唯一的查询形状：取某个会话的子会话（工具的 list、删除级联、侧栏分组）
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_parentId ON sessions(parentId)`)
    }
  },
  {
    version: 18,
    description: '订阅登录：providers 增加 oauth 列（加密的 OAuth 凭据 JSON）',
    up: (db) => {
      // OAuth 凭据与 apiKey 是并列的两种认证材料，都必须加密落库，但形状不同：apiKey 是
      // 一个用户填一次的字符串，OAuth 是一组会被刷新改写的字段（access/refresh/expires）。
      // 不塞 metadata —— 那一列是明文 JSON（customHeaders 住在里面），且会整列覆盖写，
      // 后台刷新与用户在设置里保存 headers 会互相踩。
      db.exec(`ALTER TABLE providers ADD COLUMN oauth TEXT NOT NULL DEFAULT ''`)
    }
  },
  {
    version: 19,
    description:
      '拆除旧 Bots：删除 chat_messages 表与既有聊天会话（无根 + 管线形态，不做数据迁移）',
    up: (db) => {
      // 旧 Bots（workflow 管线 + 无根聊天会话）整体拆除。bot 会话如今是一条普通有根会话
      // （settings.bot + 根档案 bot），转写在会话树里 —— chat_messages 没有读者了。
      //
      // **删除既有聊天会话**（与 v16 同一条产品裁决，不做数据迁移）：它们的转写只在这张表里，
      // 表一删，留下的就是侧栏里点开即空白的会话，比删掉更糟。两种遗留形态都算：一对一时代的
      // `$.bot`（无根）与群聊时代的 `$.bots` 名单。v19 之前不存在有根的 bot 会话，所以此刻
      // `$.bot` 有值只可能是旧形态。
      //
      // bot md 本身不受影响：`~/.shuvix/bots/` 里的文件照常解析（正文本来就是人设与记忆），
      // 用户从侧栏开一条新会话即可接着聊。孤儿文件与 v16 同样处置 ——
      // `<userData>/data/chat-attachments/<id>/` 留在盘上，不做启动扫描清理。
      db.exec(`
        DELETE FROM sessions
        WHERE (json_type(settings, '$.bot') = 'text' AND trim(json_extract(settings, '$.bot')) != '')
           OR json_array_length(json_extract(settings, '$.bots')) > 0
      `)
      db.exec(`DROP INDEX IF EXISTS idx_chat_messages_session_seq`)
      db.exec(`DROP TABLE IF EXISTS chat_messages`)
    }
  },
  {
    version: 20,
    description: '工作流换成 hook：删除旧 __workflows__ 载体项目及其笔记本会话（不做数据迁移）',
    up: (db) => {
      // workflow md 注册表整体退役（换成 ~/.shuvix/hooks 的 hook md）。它的隐藏载体项目
      // `__workflows__` 不再被 isHiddenProjectId 认得，留着会以「Workflows」之名出现在项目
      // 列表里 —— 删掉项目行与挂在它下面的笔记本会话。同 v19 的裁决：不做数据迁移，磁盘上的
      // ~/.shuvix/workflows/ 与那几条会话的 jsonl 原样留下，不做启动扫描清理。
      db.exec(`DELETE FROM sessions WHERE projectId = '__workflows__'`)
      db.exec(`DELETE FROM projects WHERE id = '__workflows__'`)
    }
  },
  {
    version: 21,
    description: '拆除旧 wiki：删除 __wiki__ 载体项目及其笔记本会话（不做数据迁移）',
    up: (db) => {
      // 旧 wiki（~/.shuvix/wikis + wiki / wiki-writer 两个内置 agent + 侧栏分组）整体下线，
      // 知识库 v2 接手。隐藏载体项目 `__wiki__` 不再被 isHiddenProjectId 认得，留着会以
      // 「知识库」之名冒到项目列表里 —— 删掉项目行与挂在它下面的笔记本会话。同 v19 / v20 的
      // 裁决：不做数据迁移，**磁盘上的 ~/.shuvix/wikis/ 原样留着**（用户的 md 随时可以自己
      // 拷进知识库），那几条会话的 jsonl 也不做启动扫描清理。
      db.exec(`DELETE FROM sessions WHERE projectId = '__wiki__'`)
      db.exec(`DELETE FROM projects WHERE id = '__wiki__'`)
    }
  },
  {
    version: 22,
    description: '种子内置能力服务器 ssh（inproc MCP，全局可用、会话默认不勾）',
    up: (db) => {
      // 「内置能力服务器」= 随产品发布、跑在进程内、按会话实例化的 MCP server（type: 'inproc'），
      // 没有 command / url / env 可配，所以除了启用位之外整行只读。
      //
      // **isEnabled = 1**，与 v10 种的 Tavily（默认 0）刻意不同：Tavily 默认关是因为没填
      // API key 之前连不上；ssh 不需要任何配置，它该立刻出现在会话的扩展能力列表里让人去勾。
      // 真正的「默认关」在**会话那一层** —— settings.enabledTools 缺省为空，不勾就没有 ssh。
      const now = Date.now()
      db.prepare(
        `INSERT OR IGNORE INTO mcp_servers
           (id, name, type, command, args, env, url, headers, metadata, isEnabled, isBuiltin, cachedTools, createdAt, updatedAt)
         VALUES (?, 'ssh', 'inproc', '', '[]', '{}', '', '{}', '{}', 1, 1, '[]', ?, ?)`
      ).run('builtin-mcp-ssh', now, now)
    }
  },
  {
    version: 23,
    description: '删除 ssh_credentials 表：SSH 凭据改为复用用户自己的 ~/.ssh/config',
    up: (db) => {
      // 旧 ssh 工具把 password / privateKey / passphrase 存在这张表里，加密用的密钥却是同机
      // 明文文件（~/.shuvix/.session-state）—— 那是混淆不是保护。内置 ssh 能力服务器改为只接受
      // 用户 ~/.ssh/config 里的 host 别名，由 ssh 自己解析与认证，ShuviX 不再持有任何 SSH 秘密。
      //
      // **不做数据迁移、不做导出**（同 v19 / v20 / v21 的裁决）：这张表里是私钥和密码，
      // 把它们写进 ~/.ssh/ 是替用户动他最敏感的目录，不该由一次升级代劳。
      db.exec(`DROP TABLE IF EXISTS ssh_credentials`)
    }
  },
  {
    version: 24,
    description: 'Tavily 不再是内置 server：清掉 isBuiltin，交给用户自己管',
    up: (db) => {
      // v10 把 Tavily 种成 isBuiltin=1。那一位的含义是「随产品发布、用户不能删改」，
      // 可 Tavily 是一台 **远程第三方 endpoint** —— 与「内置」在这里应有的含义（跑在进程内、
      // 代码随产品发布、因此 annotations 可信）不是一回事。两种东西共用一个徽章，
      // 读起来就是同一类，而它们的信任级别恰好相反。
      //
      // **只清标记，不删行**：已经填过 key 的用户不该在一次升级里丢掉配置。降级之后那一行
      // 变成普通的自定义 server —— 可改、可删、不置顶、不带徽章，想要就留着，不想要点删除。
      // url 里的 `{{TAVILY_API_KEY}}` 模板对自定义 server 一样生效，所以它照常能用。
      db.exec(`UPDATE mcp_servers SET isBuiltin = 0 WHERE id = 'builtin-mcp-tavily'`)
    }
  },
  {
    version: 25,
    description: 'sessions.lastActiveAt：用户动手时间，与账本 updatedAt 拆开',
    up: (db) => {
      // 日历 / 侧栏原先把 updatedAt 当成「最后活跃」。updatedAt 是账本时间（改 title /
      // settings 就 bump），打开旧会话补 enabledTools 键也会把它刷成今天。
      // lastActiveAt 才是「用户在这条会话上动过手」；打开、补键、自动标题都不算。
      // 回填用当前 updatedAt 是有损的（今天被补键刷过的会暂时仍停在今天），接受；
      // 不读 JSONL 消息。
      db.exec(`ALTER TABLE sessions ADD COLUMN lastActiveAt INTEGER NOT NULL DEFAULT 0`)
      db.exec(`UPDATE sessions SET lastActiveAt = updatedAt WHERE lastActiveAt = 0`)
    }
  },
  {
    version: 26,
    description: 'session_day_prompts：按本地日索引用户开口，日历按天列出（不回填）',
    up: (db) => {
      // 同一会话可以出现在多个日历日上（那天真正发过用户消息）。
      // day 按写入瞬间的本机本地 YYYY-MM-DD 落，事后不用 UTC 重算。
      // 本迁移只建空表：存量 JSONL 用 scripts/backfill-session-day-prompts.mjs 一次性回填，
      // 不进 CI、不在启动时跑。
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_day_prompts (
          sessionId  TEXT    NOT NULL,
          entryId    TEXT    NOT NULL,
          day        TEXT    NOT NULL,
          timestamp  INTEGER NOT NULL,
          PRIMARY KEY (sessionId, entryId),
          FOREIGN KEY (sessionId) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_session_day_prompts_day
          ON session_day_prompts(day);
        CREATE INDEX IF NOT EXISTS idx_session_day_prompts_session_day
          ON session_day_prompts(sessionId, day);
      `)
    }
  },
  {
    version: 27,
    description:
      '种子内置能力服务器 browser（inproc MCP，会话默认不勾）；内置名被自定义 server 占着时让位',
    up: (db) => {
      // browser 从内置工具改成内置能力服务器：与 v22 的 ssh 同一个形状 —— 全局启用、整行只读，
      // 真正的「默认关」在会话那一层（settings.enabledTools 缺省为空，不勾就没有浏览器）。
      //
      // **撞名要先让位**。mcp_servers.name 是 UNIQUE，而 v22 用的是 INSERT OR IGNORE：已经装了
      // 一台叫 `ssh` 的自定义 server 的用户，内置 ssh 从来没种上，也没有任何提示。browser 撞名的
      // 概率更高（有人会把 Playwright MCP 起名叫 browser）。所以两台一起处理：内置行缺失、名字
      // 却被别的行占着 → 把那一行改名为 `<name>-custom`（再撞就加序号），然后种内置行。
      // 会话里既有的 `mcp:<name>` 勾选从此指向内置的那台 —— 「这个会话要一个浏览器 / ssh」，
      // 意图不变；改名后的自定义 server 仍在，用户想用可以重新勾。
      const now = Date.now()
      const hasId = db.prepare('SELECT 1 FROM mcp_servers WHERE id = ?')
      const holderOf = db.prepare('SELECT id FROM mcp_servers WHERE name = ?')
      const rename = db.prepare('UPDATE mcp_servers SET name = ?, updatedAt = ? WHERE id = ?')
      const insert = db.prepare(
        `INSERT INTO mcp_servers
           (id, name, type, command, args, env, url, headers, metadata, isEnabled, isBuiltin, cachedTools, createdAt, updatedAt)
         VALUES (?, ?, 'inproc', '', '[]', '{}', '', '{}', '{}', 1, 1, '[]', ?, ?)`
      )
      for (const { id, name } of [
        { id: 'builtin-mcp-ssh', name: 'ssh' },
        { id: 'builtin-mcp-browser', name: 'browser' }
      ]) {
        if (hasId.get(id)) continue
        const occupant = holderOf.get(name) as { id: string } | undefined
        if (occupant) {
          let freeName = `${name}-custom`
          for (let n = 2; holderOf.get(freeName); n++) freeName = `${name}-custom-${n}`
          rename.run(freeName, now, occupant.id)
        }
        insert.run(id, name, now, now)
      }
    }
  },
  {
    version: 28,
    description:
      '种子内置能力服务器 database（inproc MCP，会话默认不勾）；内置名被自定义 server 占着时让位',
    up: (db) => {
      // database 从内置工具改成内置能力服务器，与 v27 的 browser 同一个形状与同一条让位规则：
      // 内置行缺失、名字却被别的行占着 → 那一行改名为 `database-custom`（再撞就加序号），再种内置行。
      // 已保存的数据库连接（db_credentials）原样不动 —— server 在进程内读它们。
      const now = Date.now()
      const holderOf = db.prepare('SELECT id FROM mcp_servers WHERE name = ?')
      if (db.prepare('SELECT 1 FROM mcp_servers WHERE id = ?').get('builtin-mcp-database')) return
      const occupant = holderOf.get('database') as { id: string } | undefined
      if (occupant) {
        let freeName = 'database-custom'
        for (let n = 2; holderOf.get(freeName); n++) freeName = `database-custom-${n}`
        db.prepare('UPDATE mcp_servers SET name = ?, updatedAt = ? WHERE id = ?').run(
          freeName,
          now,
          occupant.id
        )
      }
      db.prepare(
        `INSERT INTO mcp_servers
           (id, name, type, command, args, env, url, headers, metadata, isEnabled, isBuiltin, cachedTools, createdAt, updatedAt)
         VALUES (?, ?, 'inproc', '', '[]', '{}', '', '{}', '{}', 1, 1, '[]', ?, ?)`
      ).run('builtin-mcp-database', 'database', now, now)
    }
  },
  {
    version: 29,
    description:
      '种子内置能力服务器 chrome（inproc MCP，用户真实的 Chrome；只由 Chrome 标签页会话的 tab 档案声明）；内置名被自定义 server 占着时让位',
    up: (db) => {
      // 与 v27 / v28 同一个形状、同一条让位规则。chrome 不出现在普通会话的扩展能力选择里（桌面自己的
      // 会话只用应用内浏览器面板），这一行存在是为了让 tab 档案的 `mcp:chrome` 按名解析得到，
      // 也给 MCP 设置页一个挂「Chrome 扩展连接状态」的位置。
      const now = Date.now()
      const holderOf = db.prepare('SELECT id FROM mcp_servers WHERE name = ?')
      if (db.prepare('SELECT 1 FROM mcp_servers WHERE id = ?').get('builtin-mcp-chrome')) return
      const occupant = holderOf.get('chrome') as { id: string } | undefined
      if (occupant) {
        let freeName = 'chrome-custom'
        for (let n = 2; holderOf.get(freeName); n++) freeName = `chrome-custom-${n}`
        db.prepare('UPDATE mcp_servers SET name = ?, updatedAt = ? WHERE id = ?').run(
          freeName,
          now,
          occupant.id
        )
      }
      db.prepare(
        `INSERT INTO mcp_servers
           (id, name, type, command, args, env, url, headers, metadata, isEnabled, isBuiltin, cachedTools, createdAt, updatedAt)
         VALUES (?, ?, 'inproc', '', '[]', '{}', '', '{}', '{}', 1, 1, '[]', ?, ?)`
      ).run('builtin-mcp-chrome', 'chrome', now, now)
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
