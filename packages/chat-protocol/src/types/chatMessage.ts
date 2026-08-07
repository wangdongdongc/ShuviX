/**
 * 消息相关共享类型 — main / preload / renderer 共用
 * 唯一定义源，消除跨进程类型重复
 */

// ---- 基础元数据类型 ----

/** 图片元数据（用户附图 / AI 生成图 / 中间步骤图） */
export interface ImageMeta {
  data?: string
  preview?: string
  mimeType: string
  thoughtSignature?: string
}

/** token 用量统计 */
export interface UsageInfo {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  total: number
  details?: Array<{
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
    total: number
    stopReason: string
  }>
}

/** 内联 Token — 自包含的可扩展占位符 */
export interface InlineToken {
  /** Token 类型：'cmd'（斜杠命令）、'at'（@ 引用）等 */
  type: string
  /** 实体标识符（命令 ID、mention ID 等） */
  id: string
  /** UI 显示文本（"/review"、"@claude"） */
  displayText: string
  /** 展开/解析后的完整内容（发送给 LLM 的文本） */
  payload: string
  /** 可选：显示名称 */
  name?: string
}

/** 内联 Token 标记正则：匹配 {{shuvixInlineToken:uid}} */
export const INLINE_TOKEN_RE = /\{\{shuvixInlineToken:([a-z0-9]+)\}\}/g

/** 消息元数据（扁平超集，DAO 层使用） */
export interface MessageMetadata {
  // —— user ——
  source?: { type: string; [k: string]: unknown }
  // —— user / inline token ——
  inlineTokens?: Record<string, InlineToken>
  // —— user / assistant text / step_text ——
  images?: ImageMeta[]
  // —— assistant text ——
  thinking?: string
  usage?: UsageInfo
  // —— tool_call / tool_result ——
  toolCallId?: string
  toolName?: string
  // —— tool_call ——
  args?: Record<string, unknown>
  // —— tool_result ——
  isError?: boolean
  details?: ToolResultDetails
  // —— step / tool_call ——
  turnIndex?: number
  // —— compaction ——
  isCompactionSummary?: boolean
  /** 该压缩由阈值判定自动触发（非用户手动），UI 卡片换用「自动压缩」标题 */
  autoCompacted?: boolean
  // —— project instruction injection (AGENTS.md / CLAUDE.md) ——
  isInstructionInjection?: boolean
  /** 注入消息对应的原始指令文件名 */
  instructionFilename?: string
}

// ---- per-type metadata 接口 ----

/** 用户文本消息元数据 */
export interface UserTextMeta {
  source?: { type: string; [k: string]: unknown }
  images?: ImageMeta[]
  inlineTokens?: Record<string, InlineToken>
  /** 项目指令文件注入消息（AGENTS.md / CLAUDE.md），UI 渲染为 SystemNoticeCard */
  isInstructionInjection?: boolean
  /** 注入消息对应的原始指令文件名 */
  instructionFilename?: string
}

/** 助手文本消息元数据（最终回复） */
export interface AssistantTextMeta {
  images?: ImageMeta[]
  thinking?: string
  usage?: UsageInfo
  isCompactionSummary?: boolean
  /** 该压缩由阈值判定自动触发（非用户手动） */
  autoCompacted?: boolean
}

// ---- 工具结构化详情（按工具 type 判别） ----

/** edit 工具详情：统一 diff */
export interface EditToolDetails {
  type: 'edit'
  diff: string
  firstChangedLine?: number
}

/** bash 工具详情 */
export interface BashToolDetails {
  type: 'bash'
  exitCode: number
  truncated: boolean
  /** 完整输出是否已持久化到磁盘 */
  persisted?: boolean
  /** 命令实际执行的工作目录 —— 终端形态详情区用它渲染提示符 */
  cwd?: string
}

/** read 工具详情（目录 / 富文本转换 / 纯文本 / URL 四种场景的扁平超集） */
export interface ReadToolDetails {
  type: 'read'
  totalLines?: number
  totalEntries?: number
  fileSize?: number
  format?: string
  converted?: boolean
  truncated: boolean
  /** URL 来源标识（仅 URL 抓取时存在） */
  url?: string
  /** 完整输出是否已持久化到磁盘 */
  persisted?: boolean
}

/** glob 工具详情 */
export interface GlobToolDetails {
  type: 'glob'
  count: number
  truncated: boolean
  /** 完整输出是否已持久化到磁盘 */
  persisted?: boolean
}

/** grep 工具详情 */
export interface GrepToolDetails {
  type: 'grep'
  matches: number
  truncated: boolean
  /** 完整输出是否已持久化到磁盘 */
  persisted?: boolean
}

/** ls 工具详情 */
export interface LsToolDetails {
  type: 'ls'
  path: string
  count: number
  truncated: boolean
  /** 完整输出是否已持久化到磁盘 */
  persisted?: boolean
}

/** ask 工具详情 */
export interface AskToolDetails {
  type: 'ask'
  question: string
  selections: string[]
}

/** ssh 工具详情（connect / exec / disconnect 三种 action 的扁平超集） */
export interface SshToolDetails {
  type: 'ssh'
  action: 'connect' | 'exec' | 'disconnect'
  success?: boolean
  exitCode?: number
  truncated?: boolean
  wasConnected?: boolean
  credentialName?: string
  error?: string
  alreadyConnected?: boolean
  cancelled?: boolean
  credentialNotFound?: boolean
  host?: string
}

/** database 工具详情 */
export interface DatabaseToolDetails {
  type: 'database'
  action: 'query'
  success?: boolean
  credentialName?: string
  error?: string
  rowCount?: number
  truncated?: boolean
}

/** skill 工具详情 */
export interface SkillToolDetails {
  type: 'skill'
  skillName: string
  dir?: string
  error?: boolean
}

/** postgres 工具详情 */
export interface SqlToolDetails {
  type: 'postgres'
  hasError: boolean
  truncated: boolean
  rowCount?: number
  columnCount?: number
  extensions?: string[]
  executionTime?: number
}

/** MCP 工具详情 */
export interface McpToolDetails {
  type: 'mcp'
  server: string
  tool: string
  isError?: boolean
}

/** browser 工具详情 */
export interface BrowserToolDetails {
  type: 'browser'
  action: string
  devtoolsAction?: string
  success?: boolean
  url?: string
  elementCount?: number
  error?: string
}

/** git 工具详情 */
export interface GitToolDetails {
  type: 'git'
  action: string
  ref?: string
  oid?: string
  fileCount?: number
  error?: string
}

/** 工具结构化详情联合类型 — 按 type 字段判别 */
export type ToolResultDetails =
  | EditToolDetails
  | BashToolDetails
  | ReadToolDetails
  | GlobToolDetails
  | GrepToolDetails
  | LsToolDetails
  | AskToolDetails
  | SshToolDetails
  | DatabaseToolDetails
  | SkillToolDetails
  | SqlToolDetails
  | McpToolDetails
  | BrowserToolDetails
  | GitToolDetails

/** 工具使用元数据 */
export interface ToolUseMeta {
  toolCallId: string
  toolName: string
  args?: Record<string, unknown>
  turnIndex?: number
  isError?: boolean
  details?: ToolResultDetails
}

/** 中间步骤文本元数据 */
export interface StepTextMeta {
  turnIndex?: number
  images?: ImageMeta[]
}

/** 中间步骤思考元数据 */
export interface StepThinkingMeta {
  turnIndex?: number
}

// error_event 无 metadata

// ---- 判别联合基础 ----

export interface MessageBase {
  id: string
  sessionId: string
  content: string
  /** 实际产出这条消息的模型 id（assistant 消息取自 AgentMessage 自身，非会话当前配置） */
  model: string
  /** 实际产出这条消息的 provider slug（同上）。合成/占位消息可省略 */
  provider?: string
  createdAt: number
}

// ---- 联合成员 ----

export interface UserTextMessage extends MessageBase {
  role: 'user'
  type: 'text'
  metadata: UserTextMeta | null
}

export interface AssistantTextMessage extends MessageBase {
  role: 'assistant'
  type: 'text'
  metadata: AssistantTextMeta | null
}

export interface ToolUseMessage extends MessageBase {
  role: 'assistant'
  type: 'tool_use'
  metadata: ToolUseMeta | null
}

export interface StepTextMessage extends MessageBase {
  role: 'assistant'
  type: 'step_text'
  metadata: StepTextMeta | null
}

export interface StepThinkingMessage extends MessageBase {
  role: 'assistant'
  type: 'step_thinking'
  metadata: StepThinkingMeta | null
}

/** 用户 steer 消息（运行中注入的引导消息） */
export interface SteerMessage extends MessageBase {
  role: 'user'
  type: 'steer'
  metadata: null
}

export interface ErrorEventMessage extends MessageBase {
  role: 'system_notify'
  type: 'error_event'
  metadata: null
}

/** 判别联合：所有消息类型 */
export type ChatMessage =
  | UserTextMessage
  | AssistantTextMessage
  | ToolUseMessage
  | StepTextMessage
  | StepThinkingMessage
  | SteerMessage
  | ErrorEventMessage
