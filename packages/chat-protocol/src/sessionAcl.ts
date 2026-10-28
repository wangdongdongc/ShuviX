/**
 * 会话权限表（ACL）—— 一条会话被授予了哪些访问权，一条一行。主进程（`services/acl`）、设置界面与
 * 网络客户端共用这里的形状与判定。
 *
 * 三种客体，access 都是 read / write（写隐含读）：
 *   - **路径**（`kind: 'path'`，target = 绝对路径）：read = 读，write = 读写；
 *   - **会话**（`kind: 'session'`，target = 另一条会话的 id）：这条会话的智能体可以经 `session` 工具与它交互 ——
 *     read = 查看（读它的答复、看它的现场、等它），write = 对话（发消息、插话、代答、停下自己发起的那一轮）。
 *     只有「允许并记住」与权限表的界面写这种行（来源恒为 user）；自己的子会话不需要行。
 *   - **组件**（`kind: 'widget'`，target = 组件 id）：这条会话的智能体可以经 `widget` 工具用这个组件 ——
 *     read = 调它的读操作（并预览它），write = 读写操作都能调，也能改它（构建、跑 SQL）。「允许并记住」写下
 *     （来源 user），或会话自己 `create` 了它（来源 widget）。读写行派生出组件源码目录的可写行（widgetDir）。
 * 表是按「客体种类 + 目标 + 访问方式」通用设计的 —— 以后的网络权限之类再加一个 kind 即可，不改表结构；
 * 认不出的 kind 读的一侧跳过（旧版本读到新版本写下的行不出错）。
 *
 * **不在表里 ≠ 拒绝**：表划定的是「这条会话免询问」的范围，表外的访问照旧由安全策略决定
 * （出厂的 ask-on-external-path 询问）。
 *
 * 一行从哪来（source）决定谁来维护它：
 *   - 派生的五种由宿主按会话此刻的设置对账，随设置增删，用户不能删：
 *       workdir   会话的工作目录（不适合当会话目录时 —— `/`、覆盖家目录、ShuviX 自己的配置 —— 没有这一行）；
 *                 访问方式用户可以改（改成只读 = 这条会话改项目文件也要问）
 *       document  笔记本会话自己的那份文档（doc_* 读写的就是它）；访问方式用户可以改
 *       system    会话自己的目录：临时目录（sourceKey 'tmp'）、artifacts（'artifacts'）、工具大结果（'toolResults'）
 *       knowledge 会话勾选的知识库（sourceKey = 库名；内置库只读）
 *       skill     技能目录（只读；sourceKey = 目录）
 *       widgetDir 会话有读写授权的组件的源码目录（可写；sourceKey = 组件 id）—— 改组件的代码与写它的数据同一道授权
 *   - 授予的两种由用户（或用户触发的宿主动作）写下，可以改、可以删：
 *       user      询问卡片上「允许并记住」、或在权限表里手动添加（会话 / 组件种类的行只来自前者）
 *       widget    会话 `create` 了一个组件时宿主授予的那个组件（组件种类，sourceKey = 组件 id）。旧版本里
 *                 `shuvix widget init / build` 授予的组件目录（路径种类）也是这个来源 —— 对账时删掉（目录的写权限
 *                 现在只从组件的读写授权派生）
 */

/** 客体种类：路径、会话与组件；表结构留着放别的种类 */
export const ACL_KINDS = ['path', 'session', 'widget'] as const
export type AclKind = (typeof ACL_KINDS)[number]

/** 访问方式：write 隐含 read（路径 = 读 / 读写；会话 = 查看 / 对话） */
export const PATH_ACCESSES = ['read', 'write'] as const
export type PathAccess = (typeof PATH_ACCESSES)[number]
/** 会话种类的访问方式：read = 查看，write = 对话（隐含查看）。与路径同一对值 */
export type SessionAccess = PathAccess
/** 组件种类的访问方式：read = 调读操作，write = 读写操作都能调、也能改组件。与路径同一对值 */
export type WidgetAccess = PathAccess

/** 宿主按设置对账的来源 */
export const DERIVED_ACL_SOURCES = [
  'workdir',
  'document',
  'system',
  'knowledge',
  'skill',
  'widgetDir'
] as const
/** 授予的来源（用户可删） */
export const GRANTED_ACL_SOURCES = ['user', 'widget'] as const
export const ACL_SOURCES = [...DERIVED_ACL_SOURCES, ...GRANTED_ACL_SOURCES] as const
export type AclSource = (typeof ACL_SOURCES)[number]
export type DerivedAclSource = (typeof DERIVED_ACL_SOURCES)[number]

/** system 来源的 sourceKey */
export type SystemAclSlot = 'tmp' | 'artifacts' | 'toolResults'

export interface AclEntry {
  id: string
  sessionId: string
  kind: AclKind
  /**
   * 客体：路径种类是绝对路径（照写法存，比较时由安全模块与沙箱解析成真实位置）；会话种类是那条会话的 id；
   * 组件种类是组件 id
   */
  target: string
  /** 访问方式（写隐含读） */
  access: PathAccess
  source: AclSource
  /** 来源里的哪一个（知识库名、技能目录、system 的槽位、组件 id）；user 为 '' */
  sourceKey: string
  createdAt: number
  updatedAt: number
  /**
   * 只在交给界面时由宿主填上、不落库：会话种类的行是那条会话此刻的标题（会话已删 → 缺省），组件种类的行是
   * 组件此刻的名字。路径种类没有
   */
  targetTitle?: string
}

export function isAclKind(value: unknown): value is AclKind {
  return (ACL_KINDS as readonly unknown[]).includes(value)
}

export function isAclSource(value: unknown): value is AclSource {
  return (ACL_SOURCES as readonly unknown[]).includes(value)
}

export function isPathAccess(value: unknown): value is PathAccess {
  return (PATH_ACCESSES as readonly unknown[]).includes(value)
}

export function isDerivedAclSource(source: AclSource): source is DerivedAclSource {
  return (DERIVED_ACL_SOURCES as readonly string[]).includes(source)
}

/** 用户能不能删这一行：只有授予的能删（派生的随设置走 —— 删了下一次对账又会长回来） */
export function canRemoveAclEntry(entry: Pick<AclEntry, 'source'>): boolean {
  return !isDerivedAclSource(entry.source)
}

/**
 * 用户能不能改这一行的访问方式：授予的、工作目录与笔记本文档能改（对账保留用户改过的值）；其余派生行的
 * 访问方式由来源决定
 */
export function canChangeAclAccess(entry: Pick<AclEntry, 'source'>): boolean {
  return (
    entry.source === 'workdir' || entry.source === 'document' || !isDerivedAclSource(entry.source)
  )
}

/**
 * 交给命令沙箱时要不要过「适不适合当可写根」：授予的与笔记本文档要过（它们可能指向任何地方）；工作目录、
 * 会话目录、知识库、技能目录由宿主按设置算出、已经滤过
 */
export function needsSandboxRootCheck(entry: Pick<AclEntry, 'source'>): boolean {
  return entry.source === 'document' || !isDerivedAclSource(entry.source)
}

/** 两种访问方式合并：同一目标既授予读又授予写 = 写 */
export function widerPathAccess(a: PathAccess, b: PathAccess): PathAccess {
  return a === 'write' || b === 'write' ? 'write' : 'read'
}

/**
 * 路径条目归成「可读」与「可写」两张目录表（策略的 `vars.aclRead` / `vars.aclWrite`）。
 * 写隐含读：可写的也在可读表里。去重、保持首次出现的顺序。
 */
export function pathAclView(entries: readonly Pick<AclEntry, 'kind' | 'target' | 'access'>[]): {
  read: string[]
  write: string[]
} {
  const read = new Set<string>()
  const write = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'path' || !entry.target) continue
    read.add(entry.target)
    if (entry.access === 'write') write.add(entry.target)
  }
  return { read: [...read], write: [...write] }
}

/**
 * 会话条目归成「可查看」与「可对话」两张 id 表（策略的 `vars.aclSessionRead` / `vars.aclSessionWrite`）。
 * 对话隐含查看：可对话的也在可查看表里。去重、保持首次出现的顺序。
 */
export function sessionAclView(entries: readonly Pick<AclEntry, 'kind' | 'target' | 'access'>[]): {
  read: string[]
  write: string[]
} {
  const read = new Set<string>()
  const write = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'session' || !entry.target) continue
    read.add(entry.target)
    if (entry.access === 'write') write.add(entry.target)
  }
  return { read: [...read], write: [...write] }
}

/**
 * 组件条目归成「可读」与「可读写」两张 id 表（策略的 `vars.aclWidgetRead` / `vars.aclWidgetWrite`）。
 * 读写隐含读：可读写的也在可读表里。去重、保持首次出现的顺序。
 */
export function widgetAclView(entries: readonly Pick<AclEntry, 'kind' | 'target' | 'access'>[]): {
  read: string[]
  write: string[]
} {
  const read = new Set<string>()
  const write = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'widget' || !entry.target) continue
    read.add(entry.target)
    if (entry.access === 'write') write.add(entry.target)
  }
  return { read: [...read], write: [...write] }
}

// ─── IPC 参数 ─────────────────────────────────────────

/** 在会话权限表里手动授予一条路径（来源记为 user；同一路径已授予过就合并访问方式） */
export interface SessionAclGrantParams {
  /** 会话 id */
  id: string
  /** 绝对路径 */
  target: string
  access: PathAccess
}

/** 改一行的访问方式（只有授予的行与工作目录那一行能改） */
export interface SessionAclSetAccessParams {
  id: string
  entryId: string
  access: PathAccess
}

/** 删一行（只有授予的行能删） */
export interface SessionAclRemoveParams {
  id: string
  entryId: string
}
