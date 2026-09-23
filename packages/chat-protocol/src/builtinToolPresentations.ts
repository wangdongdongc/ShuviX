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

/** 多行参数的折叠行摘要：第一行非空文字，过长截断 */
function firstLine(v: unknown): string | undefined {
  const text = asStr(v)
  const line = text
    ?.split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  if (!line) return undefined
  return line.length > 48 ? `${line.slice(0, 47)}…` : line
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
  // 协作编辑（md 窗口的 coedit 基座）：改的是编辑器里那份活文档，不是磁盘文件 —— 折叠行摘要取
  // 定位原文 / 插入文字的第一行，参数单独渲染成代码块
  doc_read: {
    labelKey: 'tool.docReadLabel',
    presentation: { icon: 'BookOpen', iconColor: '#8b5cf6' }
  },
  doc_edit: {
    labelKey: 'tool.docEditLabel',
    presentation: {
      icon: 'FilePen',
      iconColor: '#8b5cf6',
      formItems: [
        { field: 'find', renderer: { type: 'code', language: 'markdown' } },
        { field: 'replace', renderer: { type: 'code', language: 'markdown' } }
      ]
    },
    buildSummary: (args) => firstLine(args.find)
  },
  doc_insert: {
    labelKey: 'tool.docInsertLabel',
    presentation: {
      icon: 'FileOutput',
      iconColor: '#8b5cf6',
      formItems: [
        { field: 'after' },
        { field: 'before' },
        { field: 'text', renderer: { type: 'code', language: 'markdown' } }
      ]
    },
    buildSummary: (args) => firstLine(args.text)
  },
  ask: {
    labelKey: 'tool.askLabel',
    presentation: { icon: 'MessageCircleQuestion', iconColor: '#60a5fa' },
    buildSummary: field('question')
  },
  artifact: {
    labelKey: 'tool.artifactLabel',
    presentation: { icon: 'Archive', iconColor: '#8b5cf6' },
    // 折叠行上把动作摆出来（list / adopt / create）—— 这张表同时喂 TOOL_SUMMARY_BUILDERS，
    // 不进表的工具在步骤行里只有标签、没有摘要
    buildSummary: field('action')
  },
  session: {
    labelKey: 'tool.sessionLabel',
    presentation: { icon: 'Wrench', iconColor: '#8b5cf6' },
    // action + 该 action 最有信息量的参数（set-title → 新标题）
    buildSummary: (args) =>
      [asStr(args.action), asStr(args.title)].filter(Boolean).join(' · ') || undefined
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
  },
  knowledge: {
    labelKey: 'tool.knowledgeLabel',
    presentation: { icon: 'BookOpen', iconColor: '#10b981' },
    // action + 该 action 最有信息量的参数（locate → 标题；read/validate → 路径；search → 查询词）
    buildSummary: (args) =>
      [asStr(args.action), asStr(args.title) ?? asStr(args.path) ?? asStr(args.query)]
        .filter(Boolean)
        .join(' · ') || undefined
  },
  agent: {
    labelKey: 'tool.agentLabel',
    presentation: { icon: 'Bot' },
    // 派发目标 ref（现参数 `name`；兼容历史消息的 `agent` / `subagent_type`）+ 任务描述
    buildSummary: (args) =>
      [asStr(args.name) ?? asStr(args.agent) ?? asStr(args.subagent_type), asStr(args.description)]
        .filter(Boolean)
        .join(' · ') || undefined
  }
}
