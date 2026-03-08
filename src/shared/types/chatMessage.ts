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

/** 消息元数据（扁平超集，DAO 层使用） */
export interface MessageMetadata {
  // —— user ——
  source?: { type: string; [k: string]: unknown }
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
}

// ---- per-type metadata 接口 ----

/** 用户文本消息元数据 */
export interface UserTextMeta {
  source?: { type: string; [k: string]: unknown }
  images?: ImageMeta[]
}

/** 助手文本消息元数据（最终回复） */
export interface AssistantTextMeta {
  images?: ImageMeta[]
  thinking?: string
  usage?: UsageInfo
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
  /** 是否在 Docker 容器中执行 */
  docker?: boolean
}

/** read 工具详情（目录 / 富文本转换 / 纯文本三种场景的扁平超集） */
export interface ReadToolDetails {
  type: 'read'
  totalLines?: number
  totalEntries?: number
  fileSize?: number
  format?: string
  converted?: boolean
  truncated: boolean
}

/** glob 工具详情 */
export interface GlobToolDetails {
  type: 'glob'
  count: number
  truncated: boolean
}

/** grep 工具详情 */
export interface GrepToolDetails {
  type: 'grep'
  matches: number
  truncated: boolean
}

/** ls 工具详情 */
export interface LsToolDetails {
  type: 'ls'
  path: string
  count: number
  truncated: boolean
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

/** skill 工具详情 */
export interface SkillToolDetails {
  type: 'skill'
  skillName: string
  file?: string
  error?: boolean
}

/** explore 子智能体工具详情 */
export interface ExploreToolDetails {
  type: 'explore'
  taskId: string
  subAgentType: string
  description: string
}

/** shuvix-setting 工具详情 */
export interface ShuvixSettingToolDetails {
  type: 'shuvix-setting'
  key?: string
  value?: string
}

/** shuvix-project 工具详情 */
export interface ShuvixProjectToolDetails {
  type: 'shuvix-project'
  updatedFields?: string[]
}

/** Python 工具详情 */
export interface PythonToolDetails {
  type: 'python'
  hasError: boolean
  truncated: boolean
  packages?: string[]
  executionTime?: number
}

/** SQL 工具详情 */
export interface SqlToolDetails {
  type: 'sql'
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
  | SkillToolDetails
  | ExploreToolDetails
  | ShuvixSettingToolDetails
  | ShuvixProjectToolDetails
  | PythonToolDetails
  | SqlToolDetails
  | McpToolDetails

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
  model: string
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
  | ErrorEventMessage
