/**
 * 内置工具自注册表
 *
 * 每个工具文件在模块末尾调用 registerBuiltinTool()，声明自身的名称、分组、标签等元数据。
 * 消费方（agentToolBuilder、DefaultChatGateway 等）通过 getBuiltinToolEntries() 读取。
 *
 * 好处：新增工具只需在工具文件末尾注册一次，无需修改 ALL_TOOL_NAMES、labelMap 等多处硬编码。
 */

import type { TSchema } from 'typebox'
import type { ToolContext } from '../services/toolContext'
import type { ToolPresentation } from '@shuvix/chat-protocol/types/toolPresentation'
import type { ToolPlatform } from '@shuvix/chat-protocol/chatApi'

/** 工具在 UI 中的分组标识 */
export type BuiltinGroup = 'general' | 'ripgrep' | 'remote' | 'agent' | 'system'

export interface BuiltinToolMeta {
  name: string
  group: BuiltinGroup
  // 注：原 defaultEnabled 字段已退役 —— 主会话默认工具集由 default 档案
  // （agent-runtime DEFAULT_AGENT_PROFILE / 用户 ~/.shuvix/agents/default.md）显式列出。
  /** 隐藏工具不在工具选择器中展示，由系统自动管理 */
  hidden?: boolean
  /**
   * 平台特定工具：只在这些平台上解析给 agent（缺省 = 全平台）。
   *
   * 档案可以同时列出几个平台各自的版本（内置档案写 `bash, powershell`），宿主按当前平台
   * 只装配其中存在的那个 —— 档案因此与平台无关，用户的 agent md 拷到另一台机器上照样成立。
   * 注册与展示不受影响：设置页恒列出全部工具，给平台特定的那些挂上平台标签。
   */
  platforms?: readonly ToolPlatform[]
  getLabel: () => string
  getHint: () => string
  /**
   * 构造工具实例。子智能体工具（如 explore）无需此方法，
   * 由 subAgentRegistry 管理其构造。
   */
  factory?: (ctx: ToolContext) => object
  /** 工具调用的 UI 渲染声明（折叠图标、摘要字段、展开表单项） */
  presentation?: ToolPresentation
  /**
   * 惰性给出该工具「发给 LLM」的描述与参数 schema，供设置页只读展示（toBuiltinToolDefinitions）。
   * 纯读、无副作用、不需运行时上下文；声明了此项的工具才会出现在「LLM 工具」设置页。
   */
  describe?: () => { description: string; parameters: TSchema }
}

const _entries: BuiltinToolMeta[] = []

export function registerBuiltinTool(meta: BuiltinToolMeta): void {
  _entries.push(meta)
}

export function getBuiltinToolEntries(): readonly BuiltinToolMeta[] {
  return _entries
}

/** 这个工具在给定平台（缺省 = 当前进程平台）上存不存在 */
export function isToolOnPlatform(
  meta: Pick<BuiltinToolMeta, 'platforms'>,
  platform: string = process.platform
): boolean {
  return !meta.platforms || (meta.platforms as readonly string[]).includes(platform)
}

/**
 * 当前平台上存在的内置工具 —— agent 装配、工具列表这类「这台机器上能用什么」的消费方读它；
 * 只有设置页的只读展示读全量（getBuiltinToolEntries）。
 */
export function getPlatformBuiltinToolEntries(): readonly BuiltinToolMeta[] {
  return _entries.filter((e) => isToolOnPlatform(e))
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
