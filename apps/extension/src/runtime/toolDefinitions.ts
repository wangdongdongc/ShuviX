/**
 * 扩展端内置工具定义枚举 —— 供共享「LLM 工具」设置页（@shuvix/app-shell BuiltinToolsView）只读展示。
 *
 * 各工具「自举」：定义条目从各自的真源派生，复用共享 toBuiltinToolDefinitions 输出与桌面一致的结构。
 * - 文件工具(read/write/edit)：共享参数 schema + 扩展端描述常量，无需句柄、无需实例化；
 * - browser 工具（multiplex）：描述/参数经共享 buildBrowserToolDescription/Schema 按扩展 caps 生成；
 * - ask：共享 schema + 描述常量。
 * 全程纯读、零实例化、无临时句柄/占位上下文。
 */
import {
  toBuiltinToolDefinitions,
  type ToolDefinitionEntry,
  ReadParamsSchema,
  WriteParamsSchema,
  EditParamsSchema,
  AskParamsSchema,
  ASK_DESCRIPTION,
  BROWSER_TOOL_NAME,
  buildBrowserToolDescription,
  buildBrowserParamsSchema
} from '@shuvix/agent-runtime'
import type { BuiltinToolDefinition } from '@shuvix/chat-protocol/chatApi'
import { extensionBrowserBackend } from './browserBackend'
import { READ_DESCRIPTION, WRITE_DESCRIPTION, EDIT_DESCRIPTION } from './fileTools'
import { getToolPresentations } from './toolPresentations'

export function getBuiltinToolDefinitions(): BuiltinToolDefinition[] {
  const pres = getToolPresentations()
  const labelOf = (name: string): string => pres[name]?.label ?? name
  const iconOf = (name: string): string | undefined => pres[name]?.icon

  const entries: ToolDefinitionEntry[] = [
    {
      name: 'ask',
      label: labelOf('ask'),
      group: 'general',
      icon: iconOf('ask'),
      describe: () => ({ description: ASK_DESCRIPTION, parameters: AskParamsSchema })
    },
    {
      name: 'read',
      label: labelOf('read'),
      group: 'general',
      icon: iconOf('read'),
      describe: () => ({ description: READ_DESCRIPTION, parameters: ReadParamsSchema })
    },
    {
      name: 'write',
      label: labelOf('write'),
      group: 'general',
      icon: iconOf('write'),
      describe: () => ({ description: WRITE_DESCRIPTION, parameters: WriteParamsSchema })
    },
    {
      name: 'edit',
      label: labelOf('edit'),
      group: 'general',
      icon: iconOf('edit'),
      describe: () => ({ description: EDIT_DESCRIPTION, parameters: EditParamsSchema })
    },
    // 统一 browser 工具（multiplex）：描述/参数按扩展端 caps 生成，与发给 LLM 的完全一致
    {
      name: BROWSER_TOOL_NAME,
      label: labelOf(BROWSER_TOOL_NAME),
      group: 'browser',
      icon: 'Globe',
      describe: () => ({
        description: buildBrowserToolDescription(extensionBrowserBackend.caps),
        parameters: buildBrowserParamsSchema(extensionBrowserBackend.caps)
      })
    }
  ]

  return toBuiltinToolDefinitions(entries)
}
