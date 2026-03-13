/**
 * 工具名称常量、启用工具解析
 * 独立于 agent / sessionService，避免循环依赖
 */

import { mcpService } from '../services/mcpService'
import { skillService } from '../services/skillService'
import { ALL_TOOL_NAMES, DEFAULT_TOOL_NAMES } from '../types/tools'
export { ALL_TOOL_NAMES, type ToolName } from '../types/tools'

/** 获取所有可用工具名（内置 + MCP 动态 + 已启用 Skill） */
export function getAllToolNames(): string[] {
  const skillNames = skillService.findEnabled().map((s) => `skill:${s.name}`)
  return [...ALL_TOOL_NAMES, ...mcpService.getAllToolNames(), ...skillNames]
}

/** 解析会话的 enabledTools（session 覆盖 > project settings > 全部） */
export function resolveEnabledTools(
  sessionEnabledTools: string[] | undefined,
  projectSettings: { enabledTools?: string[] } | undefined
): string[] {
  let tools: string[]
  // 优先使用 session 级别覆盖
  if (Array.isArray(sessionEnabledTools)) tools = sessionEnabledTools
  // 其次使用 project settings
  else if (Array.isArray(projectSettings?.enabledTools)) tools = projectSettings.enabledTools
  // 默认：核心内置工具 + 已连接 MCP 工具 + 已启用 Skills
  else {
    const mcpNames = mcpService.getAllToolNames()
    const skillNames = skillService.findEnabled().map((s) => `skill:${s.name}`)
    return [...(DEFAULT_TOOL_NAMES as unknown as string[]), ...mcpNames, ...skillNames]
  }

  // 过滤掉已不存在的工具名（如已禁用的 Skill、已移除的 MCP 工具）
  const available = new Set(getAllToolNames())
  return tools.filter((name) => available.has(name))
}
