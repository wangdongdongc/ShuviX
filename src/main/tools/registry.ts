/**
 * 内置工具自注册表
 *
 * 每个工具文件在模块末尾调用 registerBuiltinTool()，声明自身的名称、分组、标签等元数据。
 * 消费方（agentToolBuilder、DefaultChatGateway 等）通过 getBuiltinToolEntries() 读取。
 *
 * 好处：新增工具只需在工具文件末尾注册一次，无需修改 ALL_TOOL_NAMES、labelMap 等多处硬编码。
 */

import type { ToolContext } from './types'

/** 工具在 UI 中的分组标识 */
export type BuiltinGroup = 'general' | 'ripgrep' | 'remote' | 'subagent' | 'system'

export interface BuiltinToolMeta {
  name: string
  group: BuiltinGroup
  /** 新建会话时是否默认启用 */
  defaultEnabled: boolean
  getLabel: () => string
  getHint: () => string
  /**
   * 构造工具实例。子智能体工具（explore、claude-code）无需此方法，
   * 由 subAgentRegistry 管理其构造。
   */
  factory?: (ctx: ToolContext) => object
}

const _entries: BuiltinToolMeta[] = []

export function registerBuiltinTool(meta: BuiltinToolMeta): void {
  _entries.push(meta)
}

export function getBuiltinToolEntries(): readonly BuiltinToolMeta[] {
  return _entries
}
