/**
 * 工具定义枚举 —— 宿主无关的共享机制，供「LLM 工具」设置页只读展示。
 *
 * 各端的内置工具「自举」：在各自工具模块声明一个 ToolDefinitionEntry（name + 分组 + 惰性 describe），
 * 宿主把这些条目交给 toBuiltinToolDefinitions() 得到与发给 LLM 完全一致的 name/description/参数。
 * describe 惰性求值 —— 静态工具直接返回常量 schema+描述，动态工具（ssh 列凭据 / Agent 列子代理）
 * 在调用时计算；全程不实例化工具、不需要宿主运行时上下文，因此各端无需占位 ctx / 临时句柄。
 */
import type { TSchema } from 'typebox'
import type { BuiltinToolDefinition } from '@shuvix/chat-protocol/chatApi'

/** 单个工具「发给 LLM」定义的注册条目（宿主无关） */
export interface ToolDefinitionEntry {
  name: string
  label: string
  group: string
  /** 折叠图标名（lucide），来自工具 presentation */
  icon?: string
  iconColor?: string
  /** 惰性求出该工具发给 LLM 的描述与参数 schema；纯读、无副作用 */
  describe: () => { description: string; parameters: TSchema }
}

/**
 * 把注册条目映射为前端可消费的纯数据：逐个调用 describe()，序列化参数 schema。
 * 某条 describe 抛错时跳过该条，不拖垮整张列表。
 */
export function toBuiltinToolDefinitions(
  entries: Iterable<ToolDefinitionEntry>
): BuiltinToolDefinition[] {
  const out: BuiltinToolDefinition[] = []
  for (const e of entries) {
    let described: { description: string; parameters: TSchema }
    try {
      described = e.describe()
    } catch {
      continue
    }
    out.push({
      name: e.name,
      label: e.label,
      group: e.group,
      icon: e.icon,
      iconColor: e.iconColor,
      description: described.description,
      parameters: described.parameters as BuiltinToolDefinition['parameters']
    })
  }
  return out
}
