/**
 * 工具名称常量、启用工具解析
 * 独立于 agent / sessionService，避免循环依赖
 */

import { getPlatformBuiltinToolEntries } from './toolRegistry'
import { mcpService } from './mcpService'
import { skillService } from './skillService'
export type { ToolName } from '../types/tools'

/**
 * 获取所有可用工具名（内置 + 已启用 MCP + 已启用 Skill）。
 *
 * MCP 按「配置里启用了」算可用，不看连接状态 —— 服务器是惰性启动的，创建 Agent 时才连，
 * 这里若按连接状态过滤就会把还没连的那台在前一刻抹掉。
 */
export function getAllToolNames(projectPath?: string): string[] {
  const builtinNames = getPlatformBuiltinToolEntries().map((e) => e.name)
  const skillNames = skillService.findEnabled(projectPath).map((s) => `skill:${s.name}`)
  return [...builtinNames, ...mcpService.getEnabledToolNames(), ...skillNames]
}

/** 过滤已保存的扩展能力勾选，移除已不存在的工具（继承项目配置、创建 Agent 时调用） */
export function filterAvailableTools(enabledTools: string[], projectPath?: string): string[] {
  const available = new Set(getAllToolNames(projectPath))
  const result = enabledTools.filter((name) => available.has(name))
  return result
}
