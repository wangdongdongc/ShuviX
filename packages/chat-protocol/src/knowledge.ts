/**
 * 知识库 v2（OKF）的跨端常量与视图形状 —— 设计见 docs/okf-knowledge-design.md。
 *
 * **两个根，一个库一个 bundle**：
 *   `~/.shuvix/knowledge/`         用户的库（容器，不是 bundle）—— 每个非隐藏子目录都是一个用户
 *                                  知识库，不要求任何标记；簿记（git 提交）与 ShuviX 维护的库
 *                                  一视同仁。建库 / 删库交给文件系统。
 *   `~/.shuvix/knowledge-shuvix/`  ShuviX 维护的（容器，不是 bundle）—— 每个绑定实体一个
 *                                  bundle，本期只有 `projects/<projectId>/`。
 *
 * 条目 id 与 bundle id 两个根共用一个名字空间：`projects/<projectId>/…` / `knowledge/<库名>/…`。
 *
 * 一个库就是一个目录。跨 bundle 引用**不用 bundle 绝对路径**（那只在自己 bundle 内成立），
 * 用 `shuvix://` URI —— 链接校验对带 scheme 的目标天然跳过。
 */

/** 承载知识库笔记本会话的隐藏项目 id（同 `__wiki__` 的做法；项目列表不可见） */
export const KNOWLEDGE_PROJECT_ID = '__knowledge__'

/**
 * 用户知识库（`~/.shuvix/knowledge/<库名>/`）笔记本会话的隐藏承载项目。与项目库的承载项目分开：
 * 承载项目的 path 决定 notebookPath 相对哪个根解析，两个根共用一个承载项目就得改存量会话的路径。
 */
export const KNOWLEDGE_USER_PROJECT_ID = '__knowledge_user__'

/**
 * 内置库（`builtin/<库名>/…`）笔记本会话的隐藏承载项目：path 是内置库**当前语言那一版**的目录，
 * notebookPath 是库内相对路径 —— 各语言版本同名同路径，切换语言后同一条会话读到的就是新语言的那份。
 * 这些笔记本是**只读**的（文件在应用包里，改了会随下次更新消失，macOS 上还会破坏签名）。
 */
export const KNOWLEDGE_BUILTIN_PROJECT_ID = '__knowledge_builtin__'

/** 三个知识库承载项目之一（隐藏项目过滤、侧栏选中态、笔记本属性卡兜底共用） */
export const isKnowledgeProjectId = (id: string | null | undefined): boolean =>
  id === KNOWLEDGE_PROJECT_ID ||
  id === KNOWLEDGE_USER_PROJECT_ID ||
  id === KNOWLEDGE_BUILTIN_PROJECT_ID

/** 本库遵循的 OKF 版本（自述行 `shuvix: okf v…` 的版本段） */
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
 * `knowledge` 工具里「本会话所属项目的库」的名字。用户库按目录名点名，保留名优先 ——
 * 目录恰好叫 `project` 的用户库因此够不着工具，这是一条已知的代价。
 */
export const KNOWLEDGE_PROJECT_BASE = 'project'

/**
 * ShuviX 自带的知识库（随应用发布、只读）在工具里的保留名 —— 与 `project` 同一条规则：保留名优先，
 * 目录恰好叫 `shuvix` 的用户库够不着工具。它装的是 ShuviX 自己的说明书（各种 md 文件的规范等），
 * 给用户的 agent 查；不是用户的内容，所以只读，随每个版本一起更新。
 */
export const KNOWLEDGE_BUILTIN_BASE = 'shuvix'

/**
 * 内置库 bundle id 的首段：`builtin/<库名>` —— 与 `projects/<id>` / `knowledge/<库名>` 平行的第三个
 * 名字空间。目录不在 `~/.shuvix` 下而在应用包里（桌面 `getBuiltinKnowledgeDir()`），一库一目录、
 * **目录下按语言再分一层**（`<库名>/<lang>/…`），生效的只有界面语言那一版。
 */
export const KNOWLEDGE_BUILTIN_DIR = 'builtin'
// 「这个 id 是不是内置库」刻意**不**在这里出判定函数：宿主那一侧的 `isBuiltinBundle` 走
// normalizeBundlePath（连 `./` 一起剥），这里若再写一个只剥前导 `/` 的版本，两套归一之间就有一条
// 绕过只读闸的路（`./builtin/…` 一个说不是、另一个说是）。渲染端按首段自己比即可。

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
  'Source'
] as const
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number]

/**
 * OKF v0.2 `status` —— **生命周期**，缺省 stable（规范：absent ⇒ stable）。
 * 规范的语义：draft = 尚未定稿、可能不完整；stable = 可供消费；deprecated = 只为链接与历史留着。
 *
 * 它与「谁核实过」是**两根互不相干的轴**（规范明说两者各自变动：deprecated 的条目照样可以带
 * 人工核实，draft 也可以是 machine-confirmed）。核实那一轴归 `verified` / trust tier ——
 * 别再让 status 兼职表达审阅状态。
 */
export const OKF_STATUSES = ['draft', 'stable', 'deprecated'] as const
export type OkfStatus = (typeof OKF_STATUSES)[number]

/** 属性卡两个下拉字段的键名（描述符与选择器共用一个真源） */
export const OKF_TYPE_KEY = 'type'
export const OKF_STATUS_KEY = 'status'

/** 从 `verified` 推导的信任档（OKF §5.2）：未验证 / 机器确认 / 人工审阅 */
export type OkfTrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed'

/**
 * 资源 URI 约定：**跨 bundle 的引用**
 * —— bundle 绝对路径只在自己 bundle 内成立，指向别的 bundle 要用这个。
 */
export const KNOWLEDGE_RESOURCE_SCHEME = 'shuvix://'
export const sessionResource = (sessionId: string): string => `shuvix://session/${sessionId}`

/**
 * OKF 保留的文件名（§3）：不是 concept。ShuviX 不再生成它们 —— 早先生成的留在原地、不当笔记，
 * 用户自己写的同名文件照常是笔记
 */
export const OKF_INDEX_FILE = 'index.md'
export const OKF_LOG_FILE = 'log.md'

/**
 * 条目的前端视图形状 —— 侧栏 / 管理页一行所需，不含正文（正文由笔记本会话按需读）。
 * `path` 与 `bundle` 用两个根共用的 id 名字空间，forward-slash、无前导 `/`；`path` 同时是条目的
 * 稳定 id。不合规的 md（没有 frontmatter / 没有 `type` / 别家标记）也有一行：读得出的 title / description /
 * tags / status 照带，其余取缺省值。
 */
export interface KnowledgeEntry {
  /**
   * 条目 id，两个根共用一个名字空间：项目库 `projects/<projectId>/x.md`（相对 knowledge-shuvix 根），
   * 用户库 `knowledge/<库名>/x.md`（首段就是用户根的目录名）
   */
  path: string
  /** bundle id，同上口径：`projects/<projectId>` / `knowledge/<库名>` */
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
