/**
 * 工具名称常量、启用工具解析
 * 独立于 agent / sessionService，避免循环依赖
 */

import '../tools/allTools'
import { getBuiltinToolEntries } from '../tools/registry'
import { mcpService } from '../services/mcpService'
import { skillService } from '../services/skillService'
import { pluginRegistry } from '../services/pluginRegistry'
import { createLogger } from '../logger'
export type { ToolName } from '../types/tools'

const log = createLogger('Tools')

/** 获取所有可用工具名（内置 + 插件 + MCP 动态 + 已启用 Skill） */
export function getAllToolNames(projectPath?: string): string[] {
  const builtinNames = getBuiltinToolEntries().map((e) => e.name)
  const pluginNames = pluginRegistry.getAllToolNames()
  const skillNames = skillService.findEnabled(projectPath).map((s) => `skill:${s.name}`)
  return [...builtinNames, ...pluginNames, ...mcpService.getAllToolNames(), ...skillNames]
}

/** 计算新会话的默认启用工具列表（创建会话时调用，结果持久化） */
export function getDefaultEnabledTools(projectPath?: string): string[] {
  const defaultBuiltinNames = getBuiltinToolEntries()
    .filter((e) => e.defaultEnabled)
    .map((e) => e.name)
  const pluginNames = pluginRegistry.getDefaultEnabledToolNames()
  const mcpNames = mcpService.getAllToolNames()
  const skillNames = skillService.findEnabled(projectPath).map((s) => `skill:${s.name}`)
  const result = [...defaultBuiltinNames, ...pluginNames, ...mcpNames, ...skillNames]
  log.info(`getDefaultEnabledTools count=${result.length} skills=[${skillNames.join(',')}]`)
  return result
}

/** 过滤已保存的启用工具列表，移除已不存在的工具（读取已有会话时调用） */
export function filterAvailableTools(enabledTools: string[], projectPath?: string): string[] {
  const available = new Set(getAllToolNames(projectPath))
  const result = enabledTools.filter((name) => available.has(name))
  const skills = result.filter((n) => n.startsWith('skill:'))
  log.debug(`filterAvailableTools count=${result.length} skills=[${skills.join(',')}]`)
  return result
}
