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

/**
 * token 用量统计。
 *
 * 挂在**一条** assistant 消息上时就是那一次 LLM 调用的用量（一条 entry = 一次调用）；
 * `details` 只在事件层的整轮聚合（agent_end 的 ChatTokenUsage）里出现。
 */
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

/** 消息元数据（扁平超集，跨进程传输时的松类型视角） */
export interface MessageMetadata {
  // —— user ——
  source?: { type: string; [k: string]: unknown }
  // —— user / inline token ——
  inlineTokens?: Record<string, InlineToken>
  // —— user / assistant ——
  images?: ImageMeta[]
  // —— assistant ——
  usage?: UsageInfo
  // —— compaction ——
  isCompactionSummary?: boolean
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

/** 助手消息元数据 */
export interface AssistantMeta {
  /** 本条消息产出的图片（模型生成图） */
  images?: ImageMeta[]
  /** 本次 LLM 调用的用量 */
  usage?: UsageInfo
  /** 这条消息是压缩摘要（compaction entry 投影而来） */
  isCompactionSummary?: boolean
}

// ---- 工具结构化详情（按工具 type 判别） ----

/** edit 工具详情：统一 diff */
export interface EditToolDetails {
  type: 'edit'
  diff: string
  firstChangedLine?: number
}

/**
 * write 工具详情：与 edit 同款 diff（新建文件时为全增行）。
 *
 * 这个 diff 与写入前询问卡片里预览的那一份**是同一个字符串**——由 applyWrite 在锁内算一次，
 * 分别交给询问请求和这里，所以"预览所见"与"执行后所见"不可能出现分歧。
 */
export interface WriteToolDetails {
  type: 'write'
  diff: string
  /** 目标文件此前不存在（整份内容都是新增） */
  isNewFile?: boolean
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
  | WriteToolDetails
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

// ---- 助手消息内容块 ----

/**
 * 工具调用块 —— `result` / `isError` / `details` 由随后的 toolResult 回填；
 * 未回填（result === undefined）即「仍在执行」。
 */
export interface AssistantToolBlock {
  type: 'tool'
  toolCallId: string
  toolName: string
  args?: Record<string, unknown>
  result?: string
  isError?: boolean
  details?: ToolResultDetails
}

/**
 * 助手消息的内容块 —— 与会话树里 `AgentMessage.content` 的块一一对应，
 * 数组顺序就是模型的输出顺序（思考 → 正文 → 工具调用，或任意交错）。
 *
 * 这是「一条 entry = 一条消息 = UI 一张卡」的落点：不再有 step_text /
 * step_thinking / tool_use 这些把一次 LLM 输出拆散的伪消息类型，
 * 工具结果也不是独立消息 —— toolResult entry 回填到同 toolCallId 的块上。
 */
export type AssistantBlock =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | AssistantToolBlock

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

/**
 * 助手消息 —— 一条 assistant entry 的投影，UI 上是一张卡。
 *
 * `blocks` 是结构（按模型输出顺序渲染）；`content` 是所有 text 块的拼接，
 * 供复制 / TTS / 导出 / 标题生成这些「只要正文」的消费方直接用，
 * 不必各自遍历 blocks。
 */
export interface AssistantMessage extends MessageBase {
  role: 'assistant'
  type: 'message'
  blocks: AssistantBlock[]
  metadata: AssistantMeta | null
}

export interface ErrorEventMessage extends MessageBase {
  role: 'system_notify'
  type: 'error_event'
  metadata: null
}

/** 判别联合：所有消息类型 */
export type ChatMessage = UserTextMessage | AssistantMessage | ErrorEventMessage
