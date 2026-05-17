import type { AgentState } from '@mariozechner/pi-agent-core'
import { getBuiltinToolEntries } from './toolRegistry'
import { SkillTool } from './skillTool'
import { subAgentRegistry, SubAgentTool, type SubAgentModelConfig } from '../subagent'
import { type ToolContext } from './toolContext'
import { mcpService } from './mcpService'

type AnyAgentTool = AgentState['tools'][number]

/** 子智能体构建上下文（仅主 Agent 有，子智能体不传此参数以防递归） */
export interface SubAgentBuildContext {
  modelConfig: SubAgentModelConfig
}

/** 根据启用列表构建工具子集（内置 + MCP + Skill 合并） */
export function buildTools(
  ctx: ToolContext,
  enabledTools: string[],
  subAgentCtx?: SubAgentBuildContext,
  projectPath?: string
): AnyAgentTool[] {
  // 内置工具（从注册表动态构建，无需逐一硬编码）
  const builtinAll: Record<string, AnyAgentTool> = {}
  for (const entry of getBuiltinToolEntries()) {
    if (entry.factory) {
      builtinAll[entry.name] = entry.factory(ctx) as AnyAgentTool
    }
  }

  // 子智能体工具（仅主 Agent 有 SubAgentBuildContext 时注册，子智能体不传此参数，天然防递归）
  if (subAgentCtx) {
    for (const provider of subAgentRegistry.getAll()) {
      if (enabledTools.includes(provider.name)) {
        // 进程内子智能体需要模型配置
        provider.setModelConfig?.(subAgentCtx.modelConfig)
        builtinAll[provider.name] = new SubAgentTool(ctx, provider)
      }
    }
  }
  // 从 enabledTools 中提取启用的 MCP 服务器名（mcp:context7 → context7）
  const enabledMcpServers = enabledTools.filter((n) => n.startsWith('mcp:')).map((n) => n.slice(4))

  // 收集所有启用 MCP 服务器的 AgentTool（按服务器级别整体注入）
  const mcpTools: AnyAgentTool[] = enabledMcpServers.flatMap((name) =>
    mcpService.getAgentToolsByServerName(name)
  )

  // 从 enabledTools 中提取 skill 名（skill:pdf → pdf）
  const enabledSkillNames = enabledTools
    .filter((n) => n.startsWith('skill:'))
    .map((n) => n.slice(6))

  // 有启用的 skill 或有项目路径（可能有 .claude/skills/）时注册 skill 工具
  if (enabledSkillNames.length > 0 || projectPath) {
    builtinAll['skill'] = new SkillTool(enabledSkillNames, projectPath) as AnyAgentTool
  }

  // 过滤内置 + 子智能体工具（排除 skill: 和 mcp: 前缀项）
  const tools = enabledTools
    .filter((name) => !name.startsWith('skill:') && !name.startsWith('mcp:'))
    .filter((name) => name in builtinAll)
    .map((name) => builtinAll[name])

  // 追加 skill 工具
  if (builtinAll['skill']) {
    tools.push(builtinAll['skill'])
  }

  // 追加所有启用 MCP 服务器的工具
  tools.push(...mcpTools)

  return tools
}
