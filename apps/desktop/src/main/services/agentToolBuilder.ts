import type { AgentState, AgentTool } from '@earendil-works/pi-agent-core'
import type { TSchema } from 'typebox'
import { getBuiltinToolEntries } from './toolRegistry'
import type { BuiltinToolDefinition } from '@shuvix/chat-protocol/chatApi'
import { SkillTool } from './skillTool'
import { createAgentTool } from '../agents/AgentTool'
import { toBuiltinToolDefinitions, type ToolDefinitionEntry } from '@shuvix/agent-runtime'
import type { SubAgentModelConfig } from '@shuvix/agent-runtime'
import { type ToolContext } from './toolContext'
import { mcpService } from './mcpService'
import { wrapToolOutput, getOutputStrategy } from './wrapToolOutput'
import type { ProcessToolOutputOverrides } from './wrapToolOutput'

type AnyAgentTool = AgentState['tools'][number]

/**
 * 派发工具构建上下文（主 Agent 经会话配置注入模型；派生 agent 的派发工具
 * 由 AgentManager.resolveTools 按 spawn 上下文注入 —— 全员可派发，层级由内核校验）
 */
export interface SubAgentBuildContext {
  modelConfig: SubAgentModelConfig
}

/**
 * 构建工具集：内置工具按注册表 defaultEnabled 注入（代码层编排——
 * defaultEnabled: false 的工具不进主 Agent，但子代理白名单仍可按名解析；hidden 工具始终注入）；
 * 统一 Agent 工具仅主 Agent 注入；MCP / Skill 按 enabledTools 过滤。
 */
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
    if (!entry.factory) continue
    if (!entry.hidden && !entry.defaultEnabled) continue
    tools.push(wrap(entry.factory(ctx)))
  }

  // 统一 Agent 派发工具（主 Agent 在此注入；派生 agent 的由 AgentManager.resolveTools 注入）
  if (subAgentCtx) {
    tools.push(wrap(createAgentTool(ctx, { modelConfig: subAgentCtx.modelConfig })))
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

// ────────────────────────────────────────────────────────────────
// 内置工具定义枚举 —— 供「LLM 工具」设置页展示
// ────────────────────────────────────────────────────────────────

/**
 * 枚举所有内置工具的定义（name / description / 参数 schema），与 agent 实际发给 LLM 的内容一致。
 * 复用共享 toBuiltinToolDefinitions：只取声明了 describe() 的注册项（即应在设置页展示的工具），
 * describe 惰性求值、纯读、零实例化 —— 不含 `skill`（有独立设置页，未声明 describe）与 MCP（不在内置注册表）。
 */
export function getBuiltinToolDefinitions(): BuiltinToolDefinition[] {
  const entries: ToolDefinitionEntry[] = []
  for (const entry of getBuiltinToolEntries()) {
    if (!entry.describe) continue
    entries.push({
      name: entry.name,
      label: entry.getLabel(),
      group: entry.group,
      icon: entry.presentation?.icon,
      iconColor: entry.presentation?.iconColor,
      describe: entry.describe
    })
  }
  return toBuiltinToolDefinitions(entries)
}
