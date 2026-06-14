import type { AgentState, AgentTool } from '@earendil-works/pi-agent-core'
import type { TSchema } from 'typebox'
import { getBuiltinToolEntries } from './toolRegistry'
import { SkillTool } from './skillTool'
import { AgentTool as DispatchAgentTool } from '../agents/AgentTool'
import type { SubAgentModelConfig } from '../agents/types'
import { type ToolContext } from './toolContext'
import { mcpService } from './mcpService'
import { wrapToolOutput, getOutputStrategy } from './wrapToolOutput'
import type { ProcessToolOutputOverrides } from './wrapToolOutput'

type AnyAgentTool = AgentState['tools'][number]

/** 子智能体构建上下文（仅主 Agent 有，子智能体不传此参数以防递归） */
export interface SubAgentBuildContext {
  modelConfig: SubAgentModelConfig
}

/** 构建工具集：内置工具全量；统一 Agent 工具仅主 Agent 注入；MCP / Skill 按 enabledTools 过滤 */
export function buildTools(
  ctx: ToolContext,
  enabledTools: string[],
  subAgentCtx?: SubAgentBuildContext,
  projectPath?: string
): AnyAgentTool[] {
  const tools: AnyAgentTool[] = []
  const wrap = (tool: object): AnyAgentTool =>
    wrapToolOutput(
      tool as AgentTool<TSchema, unknown>,
      ctx.sessionId,
      getOutputStrategy(tool),
      pickOverrides(tool)
    ) as AnyAgentTool

  for (const entry of getBuiltinToolEntries()) {
    if (entry.factory) {
      tools.push(wrap(entry.factory(ctx)))
    }
  }

  // 统一 Agent 派发工具（仅主 Agent 传入 subAgentCtx，子智能体不传此参数，天然防递归）
  if (subAgentCtx) {
    tools.push(wrap(new DispatchAgentTool(ctx, { modelConfig: subAgentCtx.modelConfig })))
  }

  const enabledSkillNames = enabledTools
    .filter((n) => n.startsWith('skill:'))
    .map((n) => n.slice(6))
  if (enabledSkillNames.length > 0 || projectPath) {
    tools.push(wrap(new SkillTool(enabledSkillNames, projectPath)))
  }

  const enabledMcpServers = enabledTools.filter((n) => n.startsWith('mcp:')).map((n) => n.slice(4))
  for (const name of enabledMcpServers) {
    for (const mcpTool of mcpService.getAgentToolsByServerName(name)) {
      tools.push(wrap(mcpTool))
    }
  }

  return tools
}

/** 从 tool 上读取可选的 maxBytes / maxLines 覆写（仅 BaseTool 子类可声明） */
function pickOverrides(tool: object): ProcessToolOutputOverrides | undefined {
  const t = tool as { outputMaxBytes?: number; outputMaxLines?: number }
  if (t.outputMaxBytes == null && t.outputMaxLines == null) return undefined
  return { maxBytes: t.outputMaxBytes, maxLines: t.outputMaxLines }
}
