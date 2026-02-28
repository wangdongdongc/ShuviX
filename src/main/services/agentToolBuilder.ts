import type { AgentState } from '@mariozechner/pi-agent-core'
import { createBashTool } from '../tools/bash'
import { createReadTool } from '../tools/read'
import { createWriteTool } from '../tools/write'
import { createEditTool } from '../tools/edit'
import { createAskTool } from '../tools/ask'
import { createListTool } from '../tools/ls'
import { createGrepTool } from '../tools/grep'
import { createGlobTool } from '../tools/glob'
import { createSshTool } from '../tools/ssh'
import { createShuvixProjectTool } from '../tools/shuvixProject'
import { createShuvixSettingTool } from '../tools/shuvixSetting'
import { createSkillTool } from '../tools/skill'
import type { ToolContext } from '../tools/types'
import { mcpService } from './mcpService'
import { parallelCoordinator } from './parallelExecution'

type AnyAgentTool = AgentState['tools'][number]

/** 包装单个工具的 execute 方法，接入并行执行协调器 */
function wrapToolForParallel(sessionId: string, tool: AnyAgentTool): AnyAgentTool {
  const originalExecute = tool.execute
  // 从工具对象读取可选的 preExecute 生命周期函数（duck typing）
  const preExecute = (tool as unknown as Record<string, unknown>).preExecute as
    | ((toolCallId: string, params: Record<string, unknown>) => Promise<void>)
    | undefined
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
    bash: createBashTool(ctx),
    read: createReadTool(ctx),
    write: createWriteTool(ctx),
    edit: createEditTool(ctx),
    ask: createAskTool(ctx),
    ls: createListTool(ctx),
    grep: createGrepTool(ctx),
    glob: createGlobTool(ctx),
    ssh: createSshTool(ctx),
    'shuvix-project': createShuvixProjectTool(ctx),
    'shuvix-setting': createShuvixSettingTool(ctx)
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
    all['skill'] = createSkillTool(enabledSkillNames)
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
