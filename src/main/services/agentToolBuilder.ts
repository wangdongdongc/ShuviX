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

/** 构建工具集：内置 + 子智能体始终全量启用，MCP / Skill 按 enabledTools 过滤 */
export function buildTools(
  ctx: ToolContext,
  enabledTools: string[],
  subAgentCtx?: SubAgentBuildContext,
  projectPath?: string
): AnyAgentTool[] {
  const tools: AnyAgentTool[] = []

  for (const entry of getBuiltinToolEntries()) {
    if (entry.factory) {
      tools.push(entry.factory(ctx) as AnyAgentTool)
    }
  }

  // 子智能体工具（仅主 Agent 传入 SubAgentBuildContext，子智能体不传此参数，天然防递归）
  if (subAgentCtx) {
    for (const provider of subAgentRegistry.getAll()) {
      provider.setModelConfig?.(subAgentCtx.modelConfig)
      tools.push(new SubAgentTool(ctx, provider) as AnyAgentTool)
    }
  }

  const enabledSkillNames = enabledTools
    .filter((n) => n.startsWith('skill:'))
    .map((n) => n.slice(6))
  if (enabledSkillNames.length > 0 || projectPath) {
    tools.push(new SkillTool(enabledSkillNames, projectPath) as AnyAgentTool)
  }

  const enabledMcpServers = enabledTools.filter((n) => n.startsWith('mcp:')).map((n) => n.slice(4))
  for (const name of enabledMcpServers) {
    tools.push(...mcpService.getAgentToolsByServerName(name))
  }

  return tools
}
