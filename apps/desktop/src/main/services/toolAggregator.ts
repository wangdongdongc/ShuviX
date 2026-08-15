/**
 * 工具名称常量、启用工具解析
 * 独立于 agent / sessionService，避免循环依赖
 */

import { getBuiltinToolEntries } from './toolRegistry'
import { mcpService } from './mcpService'
import { skillService } from './skillService'
import { createLogger } from '../logger'
export type { ToolName } from '../types/tools'

const log = createLogger('Tools')

/** 获取所有可用工具名（内置 + MCP 动态 + 已启用 Skill） */
export function getAllToolNames(projectPath?: string): string[] {
  const builtinNames = getBuiltinToolEntries().map((e) => e.name)
  const skillNames = skillService.findEnabled(projectPath).map((s) => `skill:${s.name}`)
  return [...builtinNames, ...mcpService.getAllToolNames(), ...skillNames]
}

/**
 * 计算新会话/项目的默认 enabledTools 列表（创建时调用，结果持久化）。
 *
 * Why: 内置工具由 default 档案的工具清单编排（统一创建管线按名解析，不经用户白名单），
 * 此处只产出 mcp:/skill: 两类条目。
 */
export function getDefaultEnabledTools(projectPath?: string): string[] {
  const mcpNames = mcpService.getAllToolNames()
  const skillNames = skillService.findEnabled(projectPath).map((s) => `skill:${s.name}`)
  const result = [...mcpNames, ...skillNames]
  log.info(`getDefaultEnabledTools count=${result.length} skills=[${skillNames.join(',')}]`)
  return result
}

/** 过滤已保存的启用工具列表，移除已不存在的工具（读取已有会话时调用） */
export function filterAvailableTools(enabledTools: string[], projectPath?: string): string[] {
  const available = new Set(getAllToolNames(projectPath))
  const result = enabledTools.filter((name) => available.has(name))
  return result
}
