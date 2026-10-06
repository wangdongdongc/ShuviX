/**
 * pi 0.80 AgentHarness 会话树（v3 JSONL）的数据形状 —— ShuviX 自己的一份副本。
 *
 * 为什么要自带：pi 1.0 把 harness 连同这些类型一起删了，而存储类型为 `harness-v3-jsonl`
 * 的旧会话永远不迁移（见 chat-protocol 的 sessionStorageKind.ts），它们靠本目录的只读读取器
 * 继续可看。字段与 pi 0.80.10 `harness/types.ts` 的 `SessionTreeEntry` 一一对应；这里只描述
 * 形状，不承诺这些条目今后还会被写出来。
 *
 * 消息载荷（`message`）沿用 pi-ai 的消息类型：它们是存在 pi-ai 里的，不随 harness 删除。
 */
import type { ImageContent, Message, TextContent } from '@earendil-works/pi-ai'

/** 文件首行：会话头 */
export interface HarnessV3Header {
  type: 'session'
  version: 3
  id: string
  timestamp: string
  /** pi 的 open() 要求非空；只读读取器不强求（见 reader 的宽容规则） */
  cwd: string
  parentSession?: string
  metadata?: Record<string, unknown>
}

interface EntryBase {
  id: string
  parentId: string | null
  /** ISO 8601 */
  timestamp: string
}

/**
 * 消息条目的载荷。pi 的 `AgentMessage` 除了 pi-ai 的三种角色外还有 harness 自己的
 * custom / bashExecution / branchSummary / compactionSummary —— ShuviX 从不写后几种，
 * 读到时按「未知角色」跳过。
 */
export type HarnessV3Message =
  | Message
  | { role: string; timestamp?: number; [key: string]: unknown }

export interface HarnessV3MessageEntry extends EntryBase {
  type: 'message'
  message: HarnessV3Message
}

export interface HarnessV3ThinkingLevelChangeEntry extends EntryBase {
  type: 'thinking_level_change'
  thinkingLevel: string
}

export interface HarnessV3ModelChangeEntry extends EntryBase {
  type: 'model_change'
  provider: string
  modelId: string
}

export interface HarnessV3ActiveToolsChangeEntry extends EntryBase {
  type: 'active_tools_change'
  activeToolNames: string[]
}

export interface HarnessV3CompactionEntry extends EntryBase {
  type: 'compaction'
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  details?: unknown
  fromHook?: boolean
}

export interface HarnessV3BranchSummaryEntry extends EntryBase {
  type: 'branch_summary'
  fromId: string
  summary: string
  details?: unknown
  fromHook?: boolean
}

export interface HarnessV3CustomEntry extends EntryBase {
  type: 'custom'
  customType: string
  data?: unknown
}

export interface HarnessV3CustomMessageEntry extends EntryBase {
  type: 'custom_message'
  customType: string
  content: string | (TextContent | ImageContent)[]
  details?: unknown
  display: boolean
}

export interface HarnessV3LabelEntry extends EntryBase {
  type: 'label'
  targetId: string
  label: string | undefined
}

export interface HarnessV3SessionInfoEntry extends EntryBase {
  type: 'session_info'
  name?: string
}

/**
 * 叶子指针。harness 的存储层（不是 coding-agent 的 SessionManager）在回退时追加它：
 * `targetId` 是新的当前位置，`null` 表示回到树根之前。之后追加的条目以它指向的位置为父。
 */
export interface HarnessV3LeafEntry extends EntryBase {
  type: 'leaf'
  targetId: string | null
}

export type HarnessV3Entry =
  | HarnessV3MessageEntry
  | HarnessV3ThinkingLevelChangeEntry
  | HarnessV3ModelChangeEntry
  | HarnessV3ActiveToolsChangeEntry
  | HarnessV3CompactionEntry
  | HarnessV3BranchSummaryEntry
  | HarnessV3CustomEntry
  | HarnessV3CustomMessageEntry
  | HarnessV3LabelEntry
  | HarnessV3SessionInfoEntry
  | HarnessV3LeafEntry
