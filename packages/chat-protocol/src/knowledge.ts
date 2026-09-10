/**
 * 知识库 v2（OKF）的跨端常量与视图形状 —— 设计见 docs/okf-knowledge-design.md。
 *
 * 知识库是一个 Open Knowledge Format v0.2 bundle（桌面 `~/.shuvix/knowledge/`）：
 * 目录即作用域（全局 / 项目 / 会话 / bot / wiki / 来源），每个 `.md` 是一个 concept，
 * frontmatter 只有 `type` 必填，正文即知识。这里只放两端都要引用的**纯数据**：
 * 作用域与类型词汇表、资源 URI 约定、侧栏/管理页要用的条目视图形状。
 * 解析器留在 agent-runtime（`knowledge/`），与 memory / wiki 契约同一分层先例。
 *
 * 与旧 wiki（`shuvix: wiki-entry v1`）/ 旧记忆（`shuvix: memory v1`）无关：那两套整体搁置，
 * 本模块不复用它们的任何常量。
 */

/** 承载知识库笔记本会话的隐藏项目 id（同 `__wiki__` 的做法；项目列表不可见） */
export const KNOWLEDGE_PROJECT_ID = '__knowledge__'

/** 本库产出的 bundle 声明的 OKF 版本（根 index.md 的 `okf_version`） */
export const OKF_VERSION = '0.2'

/**
 * 知识库条目的 ShuviX 类型标记（`shuvix: okf v0.2`）—— 类型段声明「这是一份 OKF 知识库条目」，
 * 版本段就是它遵循的 OKF 规范版本。
 *
 * 只是**自述**，不是准入：`shuvix` 是 OKF 允许的未知键，带着它的文件对任何 OKF 消费者
 * （Obsidian、社区校验器）仍是一份合规概念；反过来，bundle 里**没有**标记的 `.md` 照样按概念
 * 解析 —— 外部工具与用户手写的条目不该因为少一行而消失。它买到的是判别力：写钩子据此把条目
 * 送进 OKF 分支、属性卡据此认出这是知识库条目，而带**别的**标记的文件（agent / policy /
 * 旧记忆 / 旧 wiki）明确不是概念。
 */
export const KNOWLEDGE_MARKER_TYPE = 'okf'
export const KNOWLEDGE_MARKER = `${KNOWLEDGE_MARKER_TYPE} v${OKF_VERSION}`

/**
 * **保留**作用域 = 宿主绑到某个运行时实体上的顶层目录：
 *   global   全局，每个会话都读（绑到「全部」）
 *   project  `projects/<slug>/`，按 `resource: shuvix://project/<id>` 绑到项目
 *   session  `projects/<slug>/sessions/` 或顶层 `sessions/`，按 `shuvix://session/<id>` 绑到会话
 *   bot      `bots/<name>/`，按 `shuvix://bot/<name>` 绑到 bot
 *
 * **只保留有绑定的**。没有绑定的目录不该占一个保留名字 —— 它只是一个目录，用户自己建、
 * 自己命名（`research/`、`recipes/` 都行），宿主照常扫描、索引、渲染、检索，只是不认识
 * 它绑着谁。曾经保留过 `wiki/` 与 `raw/`：新知识库本身就是旧 wiki 的后继，在它里面再套一层
 * `wiki/` 是把 wiki 包了两遍；`raw/` 则是给一套尚未存在的策展流程占位。两者都已撤销。
 *
 * 作用域回答「谁读它」，`type` 回答「它是什么」。
 */
export const KNOWLEDGE_SCOPE_KINDS = ['global', 'project', 'session', 'bot'] as const
export type KnowledgeScopeKind = (typeof KNOWLEDGE_SCOPE_KINDS)[number]

/** 保留的顶层目录名（作用域 → 目录）；`project` / `session` / `bot` 下还有一层 */
export const KNOWLEDGE_DIRS = {
  global: 'global',
  projects: 'projects',
  sessions: 'sessions',
  bots: 'bots'
} as const

/**
 * ShuviX 的 `type` 词汇表（开放：OKF 消费者必须容忍未知 type，宿主对未知值只展示不拒绝）。
 * 同一份词汇表写在内置 `knowledge-writer` 的提示词里，那是 agent 侧的唯一事实源 ——
 * 本库不再往用户的 bundle 里写一份可编辑的规范文件（拆职责：规则归提示词，bundle 只放条目）。
 */
export const KNOWLEDGE_TYPES = [
  'Memory',
  'Session Summary',
  'Project',
  'Bot',
  'Concept',
  'Entity',
  'Decision',
  'Guide',
  'Source'
] as const
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number]

/** OKF v0.2 `status`；缺省 **stable**（规范如此 —— agent 写的东西必须显式 draft） */
export const OKF_STATUSES = ['draft', 'stable', 'deprecated'] as const
export type OkfStatus = (typeof OKF_STATUSES)[number]

/**
 * 属性卡两个下拉字段的键名。键本身就叫 `type` / `status`（OKF 的字段名，不是 ShuviX 前缀键），
 * 而选择器按**键**分派候选项 —— 定成常量是为了描述符与选择器共用一个真源，将来若有第二种
 * 契约也用上裸 `type`，冲突会在这里一眼看见（届时把分派改成按标记类型 + 键）。
 */
export const OKF_TYPE_KEY = 'type'
export const OKF_STATUS_KEY = 'status'

/** 从 `verified` 推导的信任档（OKF §5.2）：未验证 / 机器确认 / 人工审阅 */
export type OkfTrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed'

/** 绑定概念的资源 URI 约定：`resource: shuvix://project/<id>` 等 */
export const KNOWLEDGE_RESOURCE_SCHEME = 'shuvix://'
export const projectResource = (projectId: string): string => `shuvix://project/${projectId}`
export const sessionResource = (sessionId: string): string => `shuvix://session/${sessionId}`
export const botResource = (botName: string): string => `shuvix://bot/${botName}`

/** 作用域目录里的绑定概念文件名（`resource` 是绑定真源，目录名只是给人看的 slug） */
export const PROJECT_CONCEPT_FILE = 'project.md'
export const BOT_CONCEPT_FILE = 'bot.md'

/** 保留文件（OKF §3）：不是 concept，宿主投影生成 */
export const OKF_INDEX_FILE = 'index.md'
export const OKF_LOG_FILE = 'log.md'

/**
 * 条目的前端视图形状 —— 侧栏 / 管理页一行所需，不含正文（正文由笔记本会话按需读）。
 * `path` 是 bundle 相对路径（forward-slash，无前导 `/`），同时是条目的稳定 id。
 */
export interface KnowledgeEntry {
  path: string
  /** 所属作用域；bundle 根目录下的概念（如 SCHEMA.md）为 null */
  scope: KnowledgeScopeKind | null
  type: string
  title: string
  description: string
  status: OkfStatus
  tags: string[]
  trustTier: OkfTrustTier
  /** 最近一次 `verified` 仍为当前内容背书（不早于 `generated.at`）；未核实恒为 false */
  verifiedCurrent: boolean
  /** `stale_after` 已过（按宿主当日判定） */
  stale: boolean
  /** `generated.at`（ISO 8601，可缺） */
  generatedAt?: string
  generatedBy?: string
}
