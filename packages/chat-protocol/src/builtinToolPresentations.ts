/**
 * 跨端内置工具的渲染定义（单一真源）—— read/write/edit/ask 在桌面与扩展显示一致。
 *
 * label 不在此固化（各端用自己的 i18n t 解析 labelKey）；icon/formItems 等渲染配置共享，
 * 折叠态摘要经 buildSummary 函数生成（由 toolSummaries.ts 注册表收集）。
 * 桌面 toolRegistry 与扩展 chatApiAdapter.tools.presentations 都消费这里，避免两端各写一份导致漂移。
 */
import type { ToolPresentation } from './types/toolPresentation'
import type { ToolSummaryBuilder } from './toolSummaries'
import { asStr, field, fileField } from './toolSummaryHelpers'

export interface BuiltinToolPresentationDef {
  /** i18n label key（各端用自身 t 解析为本地化显示名） */
  labelKey: string
  /** 渲染配置（不含 label） */
  presentation?: Omit<ToolPresentation, 'label'>
  /**
   * 折叠态摘要函数（根据 args 生成摘要文本）
   *
   * 不随 presentation 序列化下发——由 toolSummaries.ts 注册表收集，chat-ui 直接 import。
   */
  buildSummary?: ToolSummaryBuilder
}

export const BUILTIN_TOOL_PRESENTATIONS: Record<string, BuiltinToolPresentationDef> = {
  read: {
    labelKey: 'tool.readLabel',
    presentation: { icon: 'FileText' },
    buildSummary: fileField('path')
  },
  write: {
    labelKey: 'tool.writeLabel',
    presentation: {
      icon: 'FileOutput',
      // content 不固化 language —— 渲染层按 args.path 扩展名推导
      formItems: [{ field: 'path' }, { field: 'content', renderer: { type: 'code' } }]
    },
    buildSummary: fileField('path')
  },
  edit: {
    labelKey: 'tool.editLabel',
    presentation: {
      icon: 'FilePen',
      // oldText/newText 不固化 language —— 渲染层按 args.path 扩展名推导
      formItems: [
        { field: 'path' },
        { field: 'oldText', renderer: { type: 'code' } },
        { field: 'newText', renderer: { type: 'code' } }
      ]
    },
    buildSummary: fileField('path')
  },
  ask: {
    labelKey: 'tool.askLabel',
    presentation: { icon: 'MessageCircleQuestion', iconColor: '#60a5fa' },
    buildSummary: field('question')
  },
  preview: {
    labelKey: 'tool.previewLabel',
    presentation: { icon: 'Eye', iconColor: '#38bdf8' },
    buildSummary: fileField('path')
  },
  session: {
    labelKey: 'tool.sessionLabel',
    presentation: { icon: 'Archive', iconColor: '#8b5cf6' },
    buildSummary: field('action')
  },
  git: {
    labelKey: 'tool.gitLabel',
    presentation: { icon: 'GitBranch', iconColor: '#f59e0b' },
    // action + 该 action 最有信息量的参数 + 目标仓库目录
    buildSummary: (args) => {
      const action = asStr(args.action)
      if (!action) return undefined
      const detail =
        asStr(args.message) ??
        asStr(args.name) ??
        asStr(args.ref) ??
        (Array.isArray(args.paths) ? args.paths.join(' ') : undefined) ??
        asStr(args.path)
      const dir = asStr(args.dir)
      return [action, detail, dir && `(${dir})`].filter(Boolean).join(' ')
    }
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
