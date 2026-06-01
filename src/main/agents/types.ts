/**
 * Agents 模块共享类型
 *
 * AgentDefinition：从 AGENT.md 解析得到的统一描述（含内置 + 用户）。
 * SubAgentModelConfig：父级注入的模型配置，子智能体复用。
 */

import type { ModelCapabilities } from '../types'

/** 子智能体定义（与 AGENT.md frontmatter + body 同构） */
export interface AgentDefinition {
  /** 唯一标识（用户=目录名；内置=目录名） */
  name: string
  /** UI 显示名（frontmatter displayName，缺失时回退到 name） */
  displayName: string
  /** 给主 Agent LLM 看的"何时使用"说明（一句话进 AgentTool 描述） */
  whenToUse: string
  /** 子代理自身的 system prompt（markdown body） */
  systemPrompt: string
  /** 工具白名单：内置工具名 / 'mcp:serverName' / 'skill:skillName' */
  tools: readonly string[]
  /** agent loop 最大轮次 */
  maxTurns: number
  /** 来源（决定 UI 能否编辑/禁用） */
  source: 'builtin' | 'user'
  /** 强依赖的 MCP server 名称列表，执行前检查 */
  requiredMcp?: readonly string[]
  /** 配置文件所在目录（用于 UI"在文件管理器中打开"） */
  basePath: string
  /** 用户启用状态（内置始终启用；用户可在 .config.json 禁用） */
  isEnabled: boolean
}

/** 模型配置（纯数据，不依赖 pi-ai 类型） */
export interface SubAgentModelConfig {
  provider: string
  model: string
  capabilities: ModelCapabilities
}
