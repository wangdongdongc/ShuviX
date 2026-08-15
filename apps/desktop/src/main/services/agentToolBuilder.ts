import { getBuiltinToolEntries } from './toolRegistry'
import type { BuiltinToolDefinition } from '@shuvix/chat-protocol/chatApi'
import { toBuiltinToolDefinitions, type ToolDefinitionEntry } from '@shuvix/agent-runtime'

// 注：工具装配（原 buildTools）已收敛到统一创建管线 —— 见 agents/agentHost.ts 的
// resolveTools（root 与派生统一按名解析，名单来自 agent 档案 + 会话 overlay）。

// ────────────────────────────────────────────────────────────────
// 内置工具定义枚举 —— 供「LLM 工具」设置页展示
// ────────────────────────────────────────────────────────────────

/**
 * 枚举所有内置工具的定义（name / description / 参数 schema），与 agent 实际发给 LLM 的内容一致。
 * 复用共享 toBuiltinToolDefinitions：只取声明了 describe() 的注册项（即应在设置页展示的工具），
 * describe 惰性求值、纯读、零实例化 —— 不含 `skill`（有独立设置页，未声明 describe）与 MCP（不在内置注册表）。
 */
export function getBuiltinToolDefinitions(): BuiltinToolDefinition[] {
  const entries: ToolDefinitionEntry[] = []
  for (const entry of getBuiltinToolEntries()) {
    if (!entry.describe) continue
    entries.push({
      name: entry.name,
      label: entry.getLabel(),
      group: entry.group,
      icon: entry.presentation?.icon,
      iconColor: entry.presentation?.iconColor,
      describe: entry.describe
    })
  }
  return toBuiltinToolDefinitions(entries)
}
