import type { AgentState } from '@mariozechner/pi-agent-core'
import { BashTool } from '../tools/bash'
import { ReadTool } from '../tools/read'
import { WriteTool } from '../tools/write'
import { EditTool } from '../tools/edit'
import { AskTool } from '../tools/ask'
import { ListTool } from '../tools/ls'
import { GrepTool } from '../tools/grep'
import { GlobTool } from '../tools/glob'
import { SshTool } from '../tools/ssh'
import { ShuvixProjectTool } from '../tools/shuvixProject'
import { ShuvixSettingTool } from '../tools/shuvixSetting'
import { SkillTool } from '../tools/skill'
import { BaseTool, type ToolContext } from '../tools/types'
import { mcpService } from './mcpService'
import { parallelCoordinator } from './parallelExecution'

type AnyAgentTool = AgentState['tools'][number]

/** 包装单个工具的 execute 方法，接入并行执行协调器 */
function wrapToolForParallel(sessionId: string, tool: AnyAgentTool): AnyAgentTool {
  const originalExecute = tool instanceof BaseTool ? tool.execute.bind(tool) : tool.execute
  // BaseTool 实例直接读取 preExecute；MCP 等外部工具无此方法
  const preExecute = tool instanceof BaseTool ? tool.preExecute.bind(tool) : undefined
  parallelCoordinator.registerExecutor(sessionId, tool.name, tool, originalExecute, preExecute)

  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      // 让出一个 microtask，等待 handleMessageEnd 注册 batch
      await Promise.resolve()
      return parallelCoordinator.execute(
        sessionId,
        toolCallId,
        tool.name,
        params,
        signal,
        onUpdate,
        originalExecute
      )
    }
  }
}

/** 根据启用列表构建工具子集（内置 + MCP + Skill 合并） */
export function buildTools(ctx: ToolContext, enabledTools: string[]): AnyAgentTool[] {
  // 内置工具
  const builtinAll: Record<string, AnyAgentTool> = {
    bash: new BashTool(ctx),
    read: new ReadTool(ctx),
    write: new WriteTool(ctx),
    edit: new EditTool(ctx),
    ask: new AskTool(ctx),
    ls: new ListTool(ctx),
    grep: new GrepTool(ctx),
    glob: new GlobTool(ctx),
    ssh: new SshTool(ctx),
    'shuvix-project': new ShuvixProjectTool(ctx),
    'shuvix-setting': new ShuvixSettingTool(ctx)
  }
  // MCP 工具（动态），key = "mcp__<serverName>__<toolName>"
  const mcpAll: Record<string, AnyAgentTool> = {}
  for (const tool of mcpService.getAllAgentTools()) {
    mcpAll[tool.name] = tool
  }

  // 从 enabledTools 中提取 skill 名（skill:pdf → pdf）
  const enabledSkillNames = enabledTools
    .filter((n) => n.startsWith('skill:'))
    .map((n) => n.slice(6))

  // 合并内置 + MCP
  const all: Record<string, AnyAgentTool> = { ...builtinAll, ...mcpAll }

  // 有启用的 skill 时动态注册 skill 工具
  if (enabledSkillNames.length > 0) {
    all['skill'] = new SkillTool(enabledSkillNames)
  }

  // 过滤：排除 skill: 前缀项（它们通过 skill 工具统一处理）
  const regularTools = enabledTools
    .filter((name) => !name.startsWith('skill:'))
    .filter((name) => name in all)
    .map((name) => all[name])

  // 如果有 skill 工具，追加到末尾
  if (enabledSkillNames.length > 0 && all['skill']) {
    regularTools.push(all['skill'])
  }

  return regularTools.map((tool) => wrapToolForParallel(ctx.sessionId, tool))
}
