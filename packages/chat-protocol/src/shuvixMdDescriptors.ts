/**
 * shuvix 契约 md 的「类型描述符」—— 统一 frontmatter 属性卡（app-shell 的 frontmatterCard）
 * 按 `shuvix: <type>` 标记查表，得到已知字段的渲染方式与文案键。
 *
 * 纯数据、零依赖：描述符放 chat-protocol、解析器留 agent-runtime，是本仓既有的分层先例
 * （agentModelRef.ts —— 渲染进程够不到 agent-runtime）。描述符只回答
 * 「怎么展示/编辑」，不做合法性判定 —— 校验语义永远归各自解析器
 * （definitionFile.ts / policyFile.ts），后续经宿主校验接缝回传 UI。
 *
 * 覆盖策略：okf / agent / policy / hook / bot / memory 已各有描述符。没有描述符的类型（chart）
 * 与未列出的键落属性卡的通用 key/value 行 —— 新类型零描述符也有降级展示，补一份
 * 描述符即得完整卡片；嵌套结构（policy 的 rules/lets）按设计只做摘要不做表单，
 * 等专属 summarize 能力时再扩展本类型。
 */

import { OKF_STATUS_KEY, OKF_TYPE_KEY } from './knowledge'

/**
 * 字段渲染方式。前五种是可编辑/可点选的标量面：
 *   text 普通文本 / mono 等宽（标识符）/ boolean 开关 /
 *   csv 逗号分隔列表（chips，宿主给候选项时可增删）/ select 单选（宿主给候选项时可换）。
 * 后八种是**只读展示**（点击跳源码编辑）—— 嵌套/长文按设计不做表单：
 *   conditions 条件映射（键即 CEL 路径，值为字符串或字符串列表）
 *   exprMap 具名表达式映射（policy 的 lets）
 *   policyRules 规则数组（effect 徽章 + 条件/match 摘要）
 *   hookBindings 触发绑定数组（埋点 id 徽章 + CEL when 摘要）
 *   sources OKF 来源数组（`{id, resource, title}` 映射或裸定位符字符串，逐条一行）
 *   stamp OKF 的宿主章（`generated` / `verified`：`{by, at}` 单值或列表）—— 只读**不是**排版
 *     偏好而是契约：`generated` 由写钩子盖、`verified` 只由 UI 动作盖，谁都不该在卡上手改
 * 另有 hidden：已知但不渲染（机器面的所有权声明之类对人只是噪音 —— 列进描述符防它落通用行，
 * 渲染时整行跳过；源码视图仍可见）。
 * 值的实际形状与 kind 不符时一律退回通用标量渲染 —— 合法性判定归解析器，卡片只展示。
 */
export type ShuvixMdFieldKind =
  | 'text'
  | 'mono'
  | 'boolean'
  | 'csv'
  | 'select'
  | 'conditions'
  | 'exprMap'
  | 'policyRules'
  | 'hookBindings'
  | 'sources'
  | 'stamp'
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

/** agent 档案的模型键 —— 属性卡据它把槽位分派给 ModelSelect（唯一走模型选择器的键） */
export const AGENT_MODEL_KEY = 'shuvix-model'

/** agent 定义文件（agent-runtime definitionFile.ts 的键集；labelKey 复用智能体设置页文案） */
const AGENT_DESCRIPTOR: ShuvixMdTypeDescriptor = {
  type: 'agent',
  badge: 'ShuviX agent',
  fields: [
    { key: 'name', labelKey: 'tool.subAgentName', kind: 'mono' },
    { key: 'shuvix-displayName', labelKey: 'tool.subAgentDisplayName', kind: 'text' },
    { key: 'description', labelKey: 'tool.subAgentDescription', kind: 'text' },
    { key: AGENT_MODEL_KEY, labelKey: 'tool.subAgentModel', kind: 'select' },
    { key: 'shuvix-tools', labelKey: 'tool.subAgentTools', kind: 'csv' },
    { key: 'shuvix-instruction-files', labelKey: 'tool.subAgentInstructionFiles', kind: 'csv' },
    { key: 'shuvix-project-awareness', labelKey: 'tool.subAgentProjectAwareness', kind: 'boolean' }
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
 * hook 文件（agent-runtime hook/hookFile.ts 的键集）：「在哪些埋点、满足什么条件时，把哪个 agent
 * 叫起来」—— 这就是全部键。`shuvix-hook-on` 是最要紧的一行（什么时候会跑），给它专属摘要
 * （埋点 id + when 表达式），同 policy 的 rules；`shuvix-hook-agent` 是派发的 agent 名。
 * 正文是交给 agent 的任务文本，不是 frontmatter 字段，卡上没有它。
 *
 * **刻意没有模型字段**：派发用哪个模型是被派发 agent 的属性（agent md 的 `shuvix-model`，
 * 不声明则跟随会话当前模型），hook 不另开覆盖入口。
 */
const HOOK_DESCRIPTOR: ShuvixMdTypeDescriptor = {
  type: 'hook',
  badge: 'ShuviX hook',
  fields: [
    { key: 'name', labelKey: 'tool.subAgentName', kind: 'mono' },
    { key: 'shuvix-displayName', labelKey: 'tool.subAgentDisplayName', kind: 'text' },
    { key: 'description', labelKey: 'tool.subAgentDescription', kind: 'text' },
    { key: 'shuvix-hook-agent', labelKey: 'settings.hookAgent', kind: 'mono' },
    { key: 'shuvix-hook-on', labelKey: 'settings.hookOn', kind: 'hookBindings' }
  ]
}

/**
 * bot 定义文件（`shuvix: bot`，agent-runtime bot/botFile.ts 的键集）。
 *
 * 一个 bot 只声明**自己是谁**（身份三项）：没有管线、没有槽位、没有工具与模型 —— 它怎么干活
 * 由基座档案 `bot` 统一规定，跑在哪条会话上由会话自己说了算。正文（人设与记忆）不是
 * frontmatter 字段，所以卡上没有它：那是文档本身。旧格式残留的 `shuvix-bot-pipeline` 块不在
 * 描述符里 —— 它落通用行，解析器另发一条软提示请用户删掉。
 */
const BOT_DESCRIPTOR: ShuvixMdTypeDescriptor = {
  type: 'bot',
  badge: 'ShuviX bot',
  fields: [
    { key: 'name', labelKey: 'tool.subAgentName', kind: 'mono' },
    { key: 'shuvix-displayName', labelKey: 'tool.subAgentDisplayName', kind: 'text' },
    { key: 'description', labelKey: 'tool.subAgentDescription', kind: 'text' }
  ]
}

/**
 * OKF 知识库条目（`shuvix: okf v0.2`）—— 设计 docs/okf-knowledge-design.md §8.3。
 *
 * 字段名是 **OKF 规范自己的**，不带 ShuviX 前缀：这份卡描述的是一份对任何 OKF 消费者都合规的
 * 文件，不是 ShuviX 的私有格式。所以它与别家描述符有一处不同 —— 键名（`type` / `status` /
 * `title`…）是通用词，选择器按键分派候选项时得当心重名（见 knowledge.ts 的键常量注释）。
 *
 * 可编辑的是人写的那一半：`type` 与 `status` 是开放枚举（下拉列词汇表，手改成表外的值照样
 * 保留 —— OKF 要求消费者容忍未知 type），`title` / `description` / `tags` / `stale_after` 是标量。
 * `description` 给 text 而不是 prose：它按设计 D6 是**一行**召回条件（索引里显示的就是它），
 * 排成段落会诱人写成摘要。
 *
 * 只读的是机器写的那一半：`sources` 是溯源清单（agent 写、人不该在卡上编），`generated` 与
 * `verified` 是宿主与 UI 动作盖的章 —— 卡上可改就等于可以自称已核实，那正是设计 P4 要防的事。
 * `resource` 是绑定 URI（`shuvix://project/<id>`）：改它等于换绑，给 mono 展示、要改就去源码。
 */
const OKF_DESCRIPTOR: ShuvixMdTypeDescriptor = {
  type: 'okf',
  badge: 'OKF entry',
  fields: [
    { key: OKF_TYPE_KEY, labelKey: 'notebook.frontmatter.okfType', kind: 'select' },
    { key: 'title', labelKey: 'notebook.frontmatter.okfTitle', kind: 'text' },
    { key: 'description', labelKey: 'notebook.frontmatter.okfDescription', kind: 'text' },
    { key: 'tags', labelKey: 'notebook.frontmatter.okfTags', kind: 'csv' },
    { key: OKF_STATUS_KEY, labelKey: 'notebook.frontmatter.okfStatus', kind: 'select' },
    { key: 'stale_after', labelKey: 'notebook.frontmatter.okfStaleAfter', kind: 'mono' },
    { key: 'resource', labelKey: 'notebook.frontmatter.okfResource', kind: 'mono' },
    { key: 'sources', labelKey: 'notebook.frontmatter.okfSources', kind: 'sources' },
    { key: 'generated', labelKey: 'notebook.frontmatter.okfGenerated', kind: 'stamp' },
    { key: 'verified', labelKey: 'notebook.frontmatter.okfVerified', kind: 'stamp' }
  ]
}

/**
 * 技能定义文件（`SKILL.md` 的 frontmatter）—— **不是 ShuviX 自己的契约**：这批文件与
 * Claude Code 的 skills 通用，键只有 `name` / `description`，没有 `shuvix:` 自述行。
 * 所以它不靠标记选中，而是由技能笔记本传 `frontmatterFallbackType: 'skill'` 兜底
 * （同知识库条目的 `okf`）—— 没有这层兜底，一份技能打开就是裸 YAML。
 *
 * `description` 是**触发条件**（agent 靠它判断这个技能该不该加载），不是摘要，所以给 text：
 * 排成段落会诱人写成介绍。正文是技能本身，不是 frontmatter 字段，卡上没有它。
 */
const SKILL_DESCRIPTOR: ShuvixMdTypeDescriptor = {
  type: 'skill',
  badge: 'Skill',
  fields: [
    { key: 'name', labelKey: 'tool.subAgentName', kind: 'mono' },
    { key: 'description', labelKey: 'tool.subAgentDescription', kind: 'text' }
  ]
}

export const SHUVIX_MD_DESCRIPTORS: readonly ShuvixMdTypeDescriptor[] = [
  OKF_DESCRIPTOR,
  AGENT_DESCRIPTOR,
  POLICY_DESCRIPTOR,
  HOOK_DESCRIPTOR,
  BOT_DESCRIPTOR,
  MEMORY_DESCRIPTOR,
  SKILL_DESCRIPTOR
]

/** 按标记 type 查描述符；无 → null（属性卡降级为通用 key/value 卡） */
export function descriptorForType(type: string): ShuvixMdTypeDescriptor | null {
  return SHUVIX_MD_DESCRIPTORS.find((d) => d.type === type) ?? null
}
