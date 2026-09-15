/**
 * 工具名称常量、启用工具解析
 * 独立于 agent / sessionService，避免循环依赖
 */

import { getBuiltinToolEntries } from './toolRegistry'
import { mcpService } from './mcpService'
import { skillService } from './skillService'
export type { ToolName } from '../types/tools'

/** 获取所有可用工具名（内置 + MCP 动态 + 已启用 Skill） */
export function getAllToolNames(projectPath?: string): string[] {
  const builtinNames = getBuiltinToolEntries().map((e) => e.name)
  const skillNames = skillService.findEnabled(projectPath).map((s) => `skill:${s.name}`)
  return [...builtinNames, ...mcpService.getAllToolNames(), ...skillNames]
}

/** 过滤已保存的扩展能力勾选，移除已不存在的工具（继承项目配置、创建 Agent 时调用） */
export function filterAvailableTools(enabledTools: string[], projectPath?: string): string[] {
  const available = new Set(getAllToolNames(projectPath))
  const result = enabledTools.filter((name) => available.has(name))
  return result
}
