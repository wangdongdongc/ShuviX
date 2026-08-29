/**
 * shuvix 契约 md 的「类型描述符」—— 统一 frontmatter 属性卡（app-shell 的 frontmatterCard）
 * 按 `shuvix: <type>` 标记查表，得到已知字段的渲染方式与文案键。
 *
 * 纯数据、零依赖：描述符放 chat-protocol、解析器留 agent-runtime，是本仓既有的分层先例
 * （agentProfile.ts / agentModelRef.ts —— 渲染进程够不到 agent-runtime）。描述符只回答
 * 「怎么展示/编辑」，不做合法性判定 —— 校验语义永远归各自解析器
 * （definitionFile.ts / policyFile.ts），后续经宿主校验接缝回传 UI。
 *
 * 覆盖策略：agent / policy / memory / wiki-* 已各有描述符。没有描述符的类型（chart）
 * 与未列出的键落属性卡的通用 key/value 行 —— 新类型零描述符也有降级展示，补一份
 * 描述符即得完整卡片；嵌套结构（policy 的 rules/lets）按设计只做摘要不做表单，
 * 等专属 summarize 能力时再扩展本类型。
 */

import {
  WIKI_ALLOWED_TYPES_KEY,
  WIKI_CONTENT_KEY,
  WIKI_ENTRY_TYPE_KEY,
  WIKI_SOURCES_KEY,
  WIKI_STATUS_KEY,
  WIKI_UPDATED_KEY
} from './wikiFileContract'

/**
 * 字段渲染方式。前五种是可编辑/可点选的标量面：
 *   text 普通文本 / mono 等宽（标识符）/ boolean 开关 /
 *   csv 逗号分隔列表（chips，宿主给候选项时可增删）/ select 单选（宿主给候选项时可换）。
 * 后五种是**只读展示**（点击跳源码编辑）—— 嵌套/长文按设计不做表单：
 *   prose 长文段落（wiki 条目正文：标签在上、整宽左对齐阅读排版）
 *   list 标量数组（wiki 来源：逐行等宽展示）
 *   conditions 条件映射（键即 CEL 路径，值为字符串或字符串列表）
 *   exprMap 具名表达式映射（policy 的 lets）
 *   policyRules 规则数组（effect 徽章 + 条件/match 摘要）
 * 另有 hidden：已知但不渲染（wiki 的 description 横幅是机器面所有权声明，
 * 对人只是噪音 —— 列进描述符防它落通用行，渲染时整行跳过；源码视图仍可见）。
 * 值的实际形状与 kind 不符时一律退回通用标量渲染 —— 合法性判定归解析器，卡片只展示。
 */
export type ShuvixMdFieldKind =
  | 'text'
  | 'mono'
  | 'boolean'
  | 'csv'
  | 'select'
  | 'prose'
  | 'list'
  | 'conditions'
  | 'exprMap'
  | 'policyRules'
  | 'hidden'

/**
 * 候选项（csv / select 字段的可选值）。由宿主按 frontmatter 键提供 —— 工具名与模型 ref
 * 是运行时事实（已连接的 MCP server、启用的模型目录），描述符是静态数据，不可能内置它们。
 */
export interface ShuvixMdFieldOption {
  value: string
  label: string
  /** 分组标题（工具按 builtin/mcp/skill 分组；模型按提供商分组） */
  group?: string
}

export interface ShuvixMdFieldSpec {
  /** frontmatter 键名 */
  key: string
  /** 行标签的 i18n 键（宿主 t() 解析） */
  labelKey: string
  kind: ShuvixMdFieldKind
}

export interface ShuvixMdTypeDescriptor {
  /** `shuvix: <type>` 的 type 段 */
  type: string
  /** 卡片徽章文案（产品名词，不参与 i18n；版本号由卡片按标记追加） */
  badge: string
  /** 已知字段（卡片按此顺序渲染；缺失的键显示「未设置」，未列出的键落通用行） */
  fields: ShuvixMdFieldSpec[]
}

/** agent 定义文件（agent-runtime definitionFile.ts 的键集；labelKey 复用智能体设置页文案） */
const AGENT_DESCRIPTOR: ShuvixMdTypeDescriptor = {
  type: 'agent',
  badge: 'ShuviX agent',
  fields: [
    { key: 'name', labelKey: 'tool.subAgentName', kind: 'mono' },
    { key: 'shuvix-displayName', labelKey: 'tool.subAgentDisplayName', kind: 'text' },
    { key: 'description', labelKey: 'tool.subAgentDescription', kind: 'text' },
    { key: 'shuvix-model', labelKey: 'tool.subAgentModel', kind: 'select' },
    { key: 'shuvix-tools', labelKey: 'tool.subAgentTools', kind: 'csv' },
    { key: 'shuvix-instruction-files', labelKey: 'tool.subAgentInstructionFiles', kind: 'csv' },
    { key: 'shuvix-project-awareness', labelKey: 'tool.subAgentProjectAwareness', kind: 'boolean' },
    { key: 'shuvix-dispatch-only', labelKey: 'tool.subAgentDispatchOnly', kind: 'boolean' }
  ]
}

/**
 * 安全策略文件（agent-runtime security/policyFile.ts 的键集）。三个结构化键只做只读摘要：
 * 规则数组/条件映射做成表单的成本远高于收益，而「编辑原文 + 解析器实时校验」恰好是
 * policy 最贴合的模式（解析器对非法文件本就给人读原因）。
 */
const POLICY_DESCRIPTOR: ShuvixMdTypeDescriptor = {
  type: 'policy',
  badge: 'ShuviX policy',
  fields: [
    { key: 'name', labelKey: 'tool.subAgentName', kind: 'mono' },
    { key: 'shuvix-displayName', labelKey: 'tool.subAgentDisplayName', kind: 'text' },
    { key: 'description', labelKey: 'tool.subAgentDescription', kind: 'text' },
    { key: 'shuvix-policy-scope', labelKey: 'settings.policyScope', kind: 'conditions' },
    { key: 'shuvix-policy-lets', labelKey: 'settings.policyLets', kind: 'exprMap' },
    { key: 'shuvix-policy-rules', labelKey: 'settings.policyRules', kind: 'policyRules' }
  ]
}

/**
 * 项目记忆文件（agent-runtime memory/memoryFile.ts 的键集）。侧栏「项目记忆」点开的就是它，
 * 所以卡片是用户改记忆元数据的主要入口：`name` 是人话标题（**不参与路径**，路径只认文件名，
 * 故用 text 而非 agent 那种标识符 mono），`shuvix-memory-recall` 是唯一进注入索引的描述字段。
 */
const MEMORY_DESCRIPTOR: ShuvixMdTypeDescriptor = {
  type: 'memory',
  badge: 'ShuviX memory',
  fields: [
    { key: 'name', labelKey: 'tool.subAgentName', kind: 'text' },
    { key: 'description', labelKey: 'tool.subAgentDescription', kind: 'text' },
    { key: 'shuvix-memory-recall', labelKey: 'memory.recall', kind: 'text' },
    { key: 'shuvix-memory-pinned', labelKey: 'memory.pinned', kind: 'boolean' },
    { key: 'shuvix-memory-updated', labelKey: 'memory.updated', kind: 'text' },
    { key: 'shuvix-memory-session', labelKey: 'memory.session', kind: 'mono' }
  ]
}

/**
 * wiki 条目（wikiFileContract 的键集，键名直接引契约常量 —— 单一真源）。
 * 条目正文是卡片的主角（prose 阅读排版）；status/entry-type 是契约封闭枚举（select，
 * 候选项由宿主 picker 引契约常量）；updated 由写后处理盖章（shuvixMdWrite 的 FIELD_FILLERS）；
 * description 是 MANAGED BY WIKI CURATOR 横幅 —— 对机器/源码读者有意义，卡片隐藏。
 */
const WIKI_ENTRY_DESCRIPTOR: ShuvixMdTypeDescriptor = {
  type: 'wiki-entry',
  badge: 'ShuviX wiki entry',
  fields: [
    { key: 'name', labelKey: 'tool.subAgentName', kind: 'text' },
    { key: 'description', labelKey: 'tool.subAgentDescription', kind: 'hidden' },
    { key: WIKI_CONTENT_KEY, labelKey: 'notebook.frontmatter.wikiContent', kind: 'prose' },
    { key: WIKI_STATUS_KEY, labelKey: 'notebook.frontmatter.wikiStatus', kind: 'select' },
    { key: WIKI_ENTRY_TYPE_KEY, labelKey: 'notebook.frontmatter.wikiEntryType', kind: 'select' },
    { key: WIKI_UPDATED_KEY, labelKey: 'notebook.frontmatter.wikiUpdated', kind: 'mono' },
    { key: WIKI_SOURCES_KEY, labelKey: 'notebook.frontmatter.wikiSources', kind: 'list' }
  ]
}

/** wiki 主题章程（`WIKI.md`）：显示名 + 本主题允许的条目类型；横幅同条目卡隐藏 */
const WIKI_TOPIC_DESCRIPTOR: ShuvixMdTypeDescriptor = {
  type: 'wiki-topic',
  badge: 'ShuviX wiki topic',
  fields: [
    { key: 'name', labelKey: 'tool.subAgentName', kind: 'text' },
    { key: 'description', labelKey: 'tool.subAgentDescription', kind: 'hidden' },
    { key: WIKI_ALLOWED_TYPES_KEY, labelKey: 'notebook.frontmatter.wikiAllowedTypes', kind: 'csv' }
  ]
}

export const SHUVIX_MD_DESCRIPTORS: readonly ShuvixMdTypeDescriptor[] = [
  AGENT_DESCRIPTOR,
  POLICY_DESCRIPTOR,
  MEMORY_DESCRIPTOR,
  WIKI_ENTRY_DESCRIPTOR,
  WIKI_TOPIC_DESCRIPTOR
]

/** 按标记 type 查描述符；无 → null（属性卡降级为通用 key/value 卡） */
export function descriptorForType(type: string): ShuvixMdTypeDescriptor | null {
  return SHUVIX_MD_DESCRIPTORS.find((d) => d.type === type) ?? null
}
