/**
 * 内置工具自注册表
 *
 * 每个工具文件在模块末尾调用 registerBuiltinTool()，声明自身的名称、分组、标签等元数据。
 * 消费方（agentToolBuilder、DefaultChatGateway 等）通过 getBuiltinToolEntries() 读取。
 *
 * 好处：新增工具只需在工具文件末尾注册一次，无需修改 ALL_TOOL_NAMES、labelMap 等多处硬编码。
 */

import type { ToolContext } from '../services/toolContext'
import type { ToolPresentation } from '../../shared/types/toolPresentation'

/** 工具在 UI 中的分组标识 */
export type BuiltinGroup = 'general' | 'ripgrep' | 'remote' | 'subagent' | 'system'

export interface BuiltinToolMeta {
  name: string
  group: BuiltinGroup
  /** 新建会话时是否默认启用 */
  defaultEnabled: boolean
  /** 隐藏工具不在工具选择器中展示，由系统自动管理 */
  hidden?: boolean
  getLabel: () => string
  getHint: () => string
  /**
   * 构造工具实例。子智能体工具（如 explore）无需此方法，
   * 由 subAgentRegistry 管理其构造。
   */
  factory?: (ctx: ToolContext) => object
  /** 工具调用的 UI 渲染声明（折叠图标、摘要字段、展开表单项） */
  presentation?: ToolPresentation
}

const _entries: BuiltinToolMeta[] = []

export function registerBuiltinTool(meta: BuiltinToolMeta): void {
  _entries.push(meta)
}

export function getBuiltinToolEntries(): readonly BuiltinToolMeta[] {
  return _entries
}

export function unregisterBuiltinTool(name: string): void {
  const idx = _entries.findIndex((e) => e.name === name)
  if (idx >= 0) _entries.splice(idx, 1)
}

export function getBuiltinToolPresentations(): Record<string, ToolPresentation> {
  const result: Record<string, ToolPresentation> = {}
  for (const meta of _entries) {
    const label = meta.getLabel()
    if (meta.presentation) {
      result[meta.name] = { label, ...meta.presentation }
    } else {
      result[meta.name] = { label }
    }
  }
  return result
}
