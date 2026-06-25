/**
 * 跨端内置工具的渲染定义（单一真源）—— read/write/edit/ask 在桌面与扩展显示一致。
 *
 * label 不在此固化（各端用自己的 i18n t 解析 labelKey）；icon/summaryField/formItems 等渲染配置共享。
 * 桌面 toolRegistry 与扩展 chatApiAdapter.tools.presentations 都消费这里，避免两端各写一份导致漂移。
 */
import type { ToolPresentation } from './types/toolPresentation'

export interface BuiltinToolPresentationDef {
  /** i18n label key（各端用自身 t 解析为本地化显示名） */
  labelKey: string
  /** 渲染配置（不含 label） */
  presentation?: Omit<ToolPresentation, 'label'>
}

export const BUILTIN_TOOL_PRESENTATIONS: Record<string, BuiltinToolPresentationDef> = {
  read: {
    labelKey: 'tool.readLabel',
    presentation: { icon: 'FileText', summaryField: 'path' }
  },
  write: {
    labelKey: 'tool.writeLabel',
    presentation: {
      icon: 'FileOutput',
      summaryField: 'path',
      formItems: [
        { field: 'path' },
        { field: 'content', renderer: { type: 'code', language: 'typescript' } }
      ]
    }
  },
  edit: {
    labelKey: 'tool.editLabel',
    presentation: {
      icon: 'FilePen',
      summaryField: 'path',
      formItems: [
        { field: 'path' },
        { field: 'oldText', renderer: { type: 'code', language: 'typescript' } },
        { field: 'newText', renderer: { type: 'code', language: 'typescript' } }
      ]
    }
  },
  ask: {
    labelKey: 'tool.askLabel',
    presentation: { icon: 'MessageCircleQuestion', iconColor: '#60a5fa', summaryField: 'question' }
  }
}

/**
 * 用注入的 t 把若干 BuiltinToolPresentationDef 解析为 chat-ui 期望的 Record<name, ToolPresentation>。
 * 桌面 toolRegistry 走 getLabel + presentation 自行拼装；扩展直接用本函数。
 */
export function resolveBuiltinToolPresentations(
  t: (key: string) => string,
  defs: Record<string, BuiltinToolPresentationDef> = BUILTIN_TOOL_PRESENTATIONS
): Record<string, ToolPresentation> {
  const out: Record<string, ToolPresentation> = {}
  for (const [name, def] of Object.entries(defs)) {
    out[name] = { label: t(def.labelKey), ...def.presentation }
  }
  return out
}
