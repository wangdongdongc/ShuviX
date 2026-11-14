/**
 * Agent 档案共享类型（跨端）。
 *
 * AgentProfile：注册表里的 agent 档案（与 agent md frontmatter+body 同构），
 *   会话根 Agent（基座档案 work / chat / notebook）与派生 agent 统一用它描述"创建基座"。
 * InProcessAgentType：创建/派发执行时用的运行投影（工具白名单 + 系统提示 + sections 声明）。
 * SubAgentRegistry：档案来源的端适配接口（桌面=文件系统扫描；扩展=内嵌常量）。
 */
import type { AgentPromptBlock } from '@shuvix/chat-protocol/agentPromptBlocks'
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import type { SelectableThinkingLevel, ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'

/** agent 档案（注册表条目） */
export interface AgentProfile {
  /** 唯一标识 */
  name: string
  /**
   * `shuvix-id`：对象 id —— ShuviX 扩展元数据只认它（chat-protocol mdMeta.ts）。内置档案是
   * `agent:builtin:<name>`（写在随包发布的 md 里），用户档案是 UUID；没写或写错 = 省略
   */
  objectId?: string
  /** UI 显示名（缺失回退 name） */
  displayName: string
  /** 给主 Agent LLM 看的"何时使用"说明（一句话进派发工具描述） */
  description: string
  /** md 正文 = 系统提示基座 */
  systemPrompt: string
  /** 工具白名单：内置工具名 / 'agent'（嵌套派发）/ 'mcp:serverName' / 'skill:skillName' */
  tools: readonly string[]
  /**
   * `shuvix-model`：该档案指定的模型，`<modelId>` 或 `<provider>/<modelId>`
   * （解析规则见 agentProfile/definitionFile 的 resolveModelRef）。
   * 写在会话的档案（基座）上 = 这条会话没选过模型时的缺省，先于设置里的默认模型（会话里选的优先）。
   * 省略 = 不声明，跟随会话 / 继承派发方。
   */
  model?: string
  /**
   * `shuvix-thinking`：该档案声明的思考档位。与 `model` 同一口径：派生时压过派发方、
   * 钉档案的子会话作为种子写进树、会话的档案（基座）上是没选过档位时的缺省。省略 = 不声明，跟随派发方 / 父会话。
   */
  thinkingLevel?: SelectableThinkingLevel
  /**
   * `shuvix-prompt-blocks`：系统提示词在正文之后追加哪几块（chat-protocol `agentPromptBlocks.ts` 的词表，
   * 已归一：去重、按词表次序）。空数组 = 一块都不追加。派生 agent 的块按根会话的工作目录与项目解析。
   */
  promptBlocks: readonly AgentPromptBlock[]
  /**
   * `shuvix-user-words`：作为子会话收父会话的消息时，宿主把用户在父会话里自己写的话原样附上（桌面 services/userWords.ts）。
   * 只在为真时出现，省略 = false。
   */
  userWords?: boolean
  /** 来源（决定 UI 能否编辑/删除） */
  source: 'builtin' | 'user'
  /** 配置所在路径（桌面=agent md 文件路径；扩展可为空） */
  basePath: string
}

/** 创建/派发执行时的运行投影（从 AgentProfile 投影而来） */
export interface InProcessAgentType {
  name: string
  displayName: string
  description: string
  tools: string[]
  /** md 正文（纯文字；会话相关的内容由 `promptBlocks` 点名的块追加在后面） */
  systemPrompt: string
  /**
   * 档案声明的模型（`shuvix-model` 原样值）。**仅 spawned 生效**：派生 agent 没有会话树
   * 也没有模型选择器，档案是它唯一能表达模型意图的地方，声明了就优先于派发方继承。
   * root 会话不看这里 —— 它的模型以会话树为准（切档案时把档案模型作为种子写进树）。
   */
  model?: string
  /**
   * 档案声明的思考档位（`shuvix-thinking`）。与 `model` 同理**仅 spawned 生效**，声明了就
   * 优先于派发方继承；root 以会话树为准（钉档案时作为种子写进树）。
   */
  thinkingLevel?: ThinkingLevel
  /** 正文之后追加哪几块（缺省/空 = 不追加；派生按根会话的项目上下文解析） */
  promptBlocks?: readonly AgentPromptBlock[]
  /** 知识库感知：是否注入 `<knowledge>` 围栏（缺省 false；派生按根会话的作用域解析） */
  knowledge?: boolean
}

/** 父级注入的模型配置（纯数据，不依赖 pi-ai 类型） */
export interface SubAgentModelConfig {
  provider: string
  model: string
  capabilities: ModelCapabilities
  /** 思考深度；省略时子代理默认 'off'（用户直发/笔记本会传入会话所选） */
  thinkingLevel?: ThinkingLevel
}

/**
 * agent 档案来源（端适配：桌面 fs / 扩展常量）。
 * 纯 md 驱动：文件存在即可派发，无启用开关。派发工具描述为静态文案（不罗列类型），
 * list 仅用于未知名错误里回报可用名。
 */
export interface SubAgentRegistry {
  /** 列出全部具名档案（未知 `agent` ref 的错误提示用） */
  list: () => AgentProfile[]
  /** 按名取档案（具名 `agent` ref 的执行时解析） */
  get: (name: string) => AgentProfile | undefined
}
