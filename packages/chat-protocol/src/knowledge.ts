/**
 * 知识库 v2（OKF）的跨端常量与视图形状 —— 设计见 docs/okf-knowledge-design.md。
 *
 * **两个根，一个绑定实体一个 bundle**：
 *   `~/.shuvix/knowledge/`         用户的库（容器，不是 bundle）—— 每个子目录是一个自带
 *                                  index/log/git 的独立 bundle，可以直接 clone 进来；
 *                                  宿主对它们只读只搜，不投影、不盖章、不提交。
 *   `~/.shuvix/knowledge-shuvix/`  ShuviX 维护的（容器，不是 bundle）—— 每个绑定实体一个
 *                                  bundle，全套簿记归宿主。
 *
 * 本期只做 `knowledge-shuvix/projects/<slug>/`（对标旧项目记忆，旧机制搁置不动）。
 * 全局 / 会话 / bot 三个维度与用户侧的导入流程都留到后面，`knowledge/` 根先占住名字。
 *
 * 一个 bundle 的边界就是「一份 `index.md` 管得着的范围」。跨 bundle 引用**不用 bundle 绝对
 * 路径**（那只在自己 bundle 内成立），用 `shuvix://` URI —— 链接校验对带 scheme 的目标天然跳过。
 */

/** 承载知识库笔记本会话的隐藏项目 id（同 `__wiki__` 的做法；项目列表不可见） */
export const KNOWLEDGE_PROJECT_ID = '__knowledge__'

/** 本库产出的 bundle 声明的 OKF 版本（每个 bundle 的根 index.md 的 `okf_version`） */
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

/** 两个根目录在 `~/.shuvix/` 下的名字 */
export const KNOWLEDGE_USER_ROOT_DIR = 'knowledge'
export const KNOWLEDGE_SHUVIX_ROOT_DIR = 'knowledge-shuvix'

/** `knowledge-shuvix/` 下的容器目录名（本期只有 projects） */
export const KNOWLEDGE_PROJECTS_DIR = 'projects'

/**
 * ShuviX 的 `type` 词汇表（开放：OKF 消费者必须容忍未知 type，宿主对未知值只展示不拒绝）。
 * 同一份词汇表写在内置 `knowledge-writer` 的提示词里，那是 agent 侧的唯一事实源。
 */
export const KNOWLEDGE_TYPES = [
  'Memory',
  'Concept',
  'Entity',
  'Decision',
  'Guide',
  'Source',
  'Project'
] as const
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number]

/** OKF v0.2 `status`；缺省 **stable**（规范如此 —— agent 写的东西必须显式 draft） */
export const OKF_STATUSES = ['draft', 'stable', 'deprecated'] as const
export type OkfStatus = (typeof OKF_STATUSES)[number]

/** 属性卡两个下拉字段的键名（描述符与选择器共用一个真源） */
export const OKF_TYPE_KEY = 'type'
export const OKF_STATUS_KEY = 'status'

/** 从 `verified` 推导的信任档（OKF §5.2）：未验证 / 机器确认 / 人工审阅 */
export type OkfTrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed'

/**
 * 资源 URI 约定。两用：绑定概念的 `resource`（`project.md` 绑项目），以及**跨 bundle 的引用**
 * —— bundle 绝对路径只在自己 bundle 内成立，指向别的 bundle 要用这个。
 */
export const KNOWLEDGE_RESOURCE_SCHEME = 'shuvix://'
export const projectResource = (projectId: string): string => `shuvix://project/${projectId}`
export const sessionResource = (sessionId: string): string => `shuvix://session/${sessionId}`

/** 项目 bundle 的绑定概念文件名（`resource` 是绑定真源，目录名只是给人看的 slug） */
export const PROJECT_CONCEPT_FILE = 'project.md'

/** 保留文件（OKF §3）：不是 concept，宿主按 bundle 投影生成 */
export const OKF_INDEX_FILE = 'index.md'
export const OKF_LOG_FILE = 'log.md'

/**
 * 条目的前端视图形状 —— 侧栏 / 管理页一行所需，不含正文（正文由笔记本会话按需读）。
 * `path` 与 `bundle` 都相对 `knowledge-shuvix/` 根，forward-slash、无前导 `/`；
 * `path` 同时是条目的稳定 id，`bundle` 是它所属 bundle 的目录（如 `projects/acme`）。
 */
export interface KnowledgeEntry {
  path: string
  bundle: string
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
