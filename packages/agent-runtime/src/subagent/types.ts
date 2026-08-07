/**
 * 子代理共享类型（跨端）。
 *
 * AgentDefinition：注册表里的子代理定义（与 AGENT.md frontmatter+body 同构）。
 * InProcessAgentType：派发执行时用的运行配置（工具集 + 系统提示）。
 * SubAgentRegistry：定义来源的端适配接口（桌面=文件系统扫描；扩展=storage/内嵌）。
 */
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'

/** 子代理定义（注册表条目） */
export interface AgentDefinition {
  /** 唯一标识 */
  name: string
  /** UI 显示名（缺失回退 name） */
  displayName: string
  /** 给主 Agent LLM 看的"何时使用"说明（一句话进派发工具描述） */
  whenToUse: string
  /** 子代理自身的 system prompt */
  systemPrompt: string
  /** 工具白名单：内置工具名 / 'mcp:serverName' / 'skill:skillName' */
  tools: readonly string[]
  /** 来源（决定 UI 能否编辑/禁用） */
  source: 'builtin' | 'user'
  /** 强依赖的 MCP server 名称列表，执行前检查 */
  requiredMcp?: readonly string[]
  /** 配置所在路径（桌面=AGENT.md 目录；扩展可为空） */
  basePath: string
  /** 启用状态（内置始终启用；用户可禁用） */
  isEnabled: boolean
}

/** 派发执行时的运行配置（从 AgentDefinition 投影而来） */
export interface InProcessAgentType {
  name: string
  displayName: string
  description: string
  tools: string[]
  systemPrompt: string
}

/** 父级注入的模型配置（纯数据，不依赖 pi-ai 类型） */
export interface SubAgentModelConfig {
  provider: string
  model: string
  capabilities: ModelCapabilities
  /** 思考深度；省略时子代理默认 'off'（派发型子代理如 explore 保持不变，笔记本会传入会话所选） */
  thinkingLevel?: ThinkingLevel
}

/** 子代理定义来源（端适配：桌面 fs / 扩展 storage） */
export interface SubAgentRegistry {
  /** 列出全部已启用定义（供派发工具构建描述 + 校验具名 `agent` ref） */
  listEnabled: () => AgentDefinition[]
  /** 按名取已启用定义 */
  getEnabled: (name: string) => AgentDefinition | undefined
}
