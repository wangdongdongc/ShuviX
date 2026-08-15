/**
 * Agent 定义文件（<name>.md）解析 —— 标准化格式。
 *
 * 格式对齐 Claude Code 社区惯例：YAML frontmatter + 正文即 system prompt。
 *   - 首行 `shuvix: agent v1` 是**文件类型标记**（与图表契约的 `shuvix:chart v1` 同形）：
 *     声明这份 markdown 是 ShuviX 的智能体定义文件。写入时恒输出，读取时**可选** ——
 *     标记引入之前的用户档案不带它，不能因此失效；经 GUI 再保存一次即自动补上；
 *   - 通用 key 与社区惯例同名同义：`name` / `description`；
 *   - 工具白名单用 `shuvix-tools`（逗号分隔字符串，如 `shuvix-tools: read, grep, bash`）——
 *     刻意不用通用的 `tools` key：ShuviX 工具名与其他 app 不兼容，带前缀可避免
 *     agent md 迁移到其他应用时被误读。省略 = 空白名单（无工具）；
 *     条目大小写不敏感（内置工具名归一为小写注册名），`Agent` 为嵌套派发 opt-in，
 *     `mcp:<server>` / `skill:<name>` 前缀语法为 ShuviX 扩展（余部大小写保留）；
 *   - ShuviX 自有字段带 `shuvix-` 前缀：`shuvix-displayName`、模型 `shuvix-model`、
 *     曝光开关 `shuvix-dispatch-only`，与两个注入开关 `shuvix-instruction-files` /
 *     `shuvix-project-prompt`（布尔：是否向该 agent 注入项目指令文件 / 项目提示词）；
 *   - `shuvix-dispatch-only: true` 表示该档案只能被派发、不作为 `/<agentName>` 切换目标。
 *     用于那些「政策必须跑在新鲜上下文里」的执行型 agent（如 wiki-writer）：一旦被切成
 *     主会话，长对话会稀释系统提示词的权重，而它们违反政策的代价是静默且不可逆的。
 *     与 BASE_PROFILE_NAMES 的区别是只挡切换、不挡派发；
 *   - `shuvix-model` 指定该 agent 用哪个模型：GUI 写出恒为 `<providerId>/<modelId>`
 *     （与 `agent.setModel` 的入参一一对应），手写的裸 `<modelId>` 也能读；省略 = 不声明
 *     （跟随会话 / 继承派发方）。本层只做「原样存取」，取值解释（拆前缀 / 对模型目录解析 /
 *     反向写出）是三端共用契约，在 `@shuvix/chat-protocol/agentModelRef`
 *     （渲染进程够不到 agent-runtime，故不放这里）；
 *   - 正文可内嵌 `{{shuvix:name}}` 占位符（createAgent 时按宿主变量表替换）；
 *   - frontmatter 用完整 YAML 解析（支持多行字符串、引号、注释等）。
 *
 * 无历史兼容：旧方言 key（`whenToUse` / `displayName`）、已废弃的 requiredMcp 系 key、
 * `shuvix-prompt-sections`（动态段机制已被 {{shuvix:*}} 变量取代）与通用 `tools` key
 * （其他 app 语义，见上）都不再读取（未知 key 忽略）；`shuvix-tools` / `shuvix-model`
 * 仅接受字符串、注入开关仅接受布尔，类型不符视为文件非法（跳过并记警告），
 * 宁可整体拒绝也不静默降级。
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/**
 * 文件类型标记的 frontmatter key 与值 —— `shuvix: agent v1`。
 * 序列化时恒写在首位；解析时不作要求（见文件头注释的向后兼容说明）。
 */
export const AGENT_FILE_MARKER_KEY = 'shuvix'
export const AGENT_FILE_MARKER = 'agent v1'

/** 解析产物：AgentProfile 中来自文件本身的字段（source/basePath 由调用方补齐） */
export interface ParsedAgentFile {
  name: string
  displayName: string
  description: string
  systemPrompt: string
  tools: string[]
  /** `shuvix-model` 原样字符串（`<modelId>` 或 `<provider>/<modelId>`）；省略 = 不声明 */
  model?: string
  /** `shuvix-instruction-files`；缺省 false */
  instructionFiles: boolean
  /** `shuvix-project-prompt`；缺省 false */
  projectPrompt: boolean
  /** `shuvix-dispatch-only`：只可派发、不可切换为会话档案；缺省 false */
  dispatchOnly: boolean
}

/** 匹配文件头部的 frontmatter 块：`---` 行 + YAML + `---` 行（容忍 CRLF、空 frontmatter、文件结尾无换行） */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m

/**
 * 单个工具条目归一：
 *   - `Agent`（任意大小写）→ 规范名 'Agent'（嵌套派发 opt-in 白名单值）；
 *   - `mcp:` / `skill:` 前缀 → 前缀归小写，余部保留（server / skill 名大小写敏感）；
 *   - 其余 → 小写（对齐内置工具注册名，使 Claude Code 风格的 `Read, Grep` 直接可用）。
 */
function normalizeToolName(raw: string): string {
  const entry = raw.trim()
  if (!entry) return ''
  if (/^agent$/i.test(entry)) return 'Agent'
  const prefixed = /^(mcp|skill):(.*)$/i.exec(entry)
  if (prefixed) return `${prefixed[1].toLowerCase()}:${prefixed[2].trim()}`
  return entry.toLowerCase()
}

/** 拆分逗号分隔的列表字段（唯一合法写法，对齐 Claude Code） */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function stringField(fields: Record<string, unknown>, key: string): string | undefined {
  const v = fields[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/**
 * 解析 agent 定义 markdown。格式非法（无 frontmatter / YAML 语法错误）返回 null，
 * 由调用方记日志跳过。`defaultName` 为文件 basename（frontmatter `name` 可覆盖）。
 */
export function parseAgentDefinitionFile(raw: string, defaultName: string): ParsedAgentFile | null {
  // 剥 BOM 与前导空白后必须以 `---` 起始
  const text = raw.replace(/^\uFEFF/, '').replace(/^\s+/, '')
  const match = FRONTMATTER_RE.exec(text)
  if (!match) return null

  let fields: Record<string, unknown>
  try {
    const parsed: unknown = parseYaml(match[1])
    if (parsed === null || parsed === undefined) {
      fields = {}
    } else if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      fields = parsed as Record<string, unknown>
    } else {
      return null
    }
  } catch {
    return null
  }

  // 列表字段仅接受逗号分隔字符串、布尔字段仅接受布尔；类型不符 = 文件非法
  const toolsRaw = fields['shuvix-tools'] ?? null
  if (toolsRaw !== null && typeof toolsRaw !== 'string') return null
  const modelRaw = fields['shuvix-model'] ?? null
  if (modelRaw !== null && typeof modelRaw !== 'string') return null
  const instructionRaw = fields['shuvix-instruction-files'] ?? null
  if (instructionRaw !== null && typeof instructionRaw !== 'boolean') return null
  const projectPromptRaw = fields['shuvix-project-prompt'] ?? null
  if (projectPromptRaw !== null && typeof projectPromptRaw !== 'boolean') return null
  const dispatchOnlyRaw = fields['shuvix-dispatch-only'] ?? null
  if (dispatchOnlyRaw !== null && typeof dispatchOnlyRaw !== 'boolean') return null

  const name = stringField(fields, 'name') ?? defaultName

  // 省略 = 空白名单（无工具）；去重保序
  const tools =
    toolsRaw === null
      ? []
      : [...new Set(splitList(toolsRaw).map(normalizeToolName))].filter(Boolean)

  return {
    name,
    displayName: stringField(fields, 'shuvix-displayName') ?? name,
    description: stringField(fields, 'description') ?? '',
    systemPrompt: text.slice(match[0].length).trim(),
    tools,
    model: stringField(fields, 'shuvix-model'),
    instructionFiles: instructionRaw ?? false,
    projectPrompt: projectPromptRaw ?? false,
    dispatchOnly: dispatchOnlyRaw ?? false
  }
}

/**
 * 序列化为标准格式文件内容（编辑 GUI 的保存路径）。与 parseAgentDefinitionFile 互逆：
 * 空值字段省略（displayName 等于 name 时不写；tools 空 / model 未声明 = 省略），
 * key 顺序固定（文件类型标记 `shuvix` 居首），标量经 YAML 引号规则安全转义
 * （lineWidth: 0 禁止折行）。
 */
export function serializeAgentDefinitionFile(data: ParsedAgentFile): string {
  const fields: Record<string, string | boolean> = {
    [AGENT_FILE_MARKER_KEY]: AGENT_FILE_MARKER,
    name: data.name
  }
  if (data.description.trim()) fields.description = data.description.trim()
  if (data.tools.length > 0) fields['shuvix-tools'] = data.tools.join(', ')
  if (data.model?.trim()) fields['shuvix-model'] = data.model.trim()
  if (data.displayName.trim() && data.displayName.trim() !== data.name) {
    fields['shuvix-displayName'] = data.displayName.trim()
  }
  if (data.dispatchOnly) fields['shuvix-dispatch-only'] = true
  if (data.instructionFiles) fields['shuvix-instruction-files'] = true
  if (data.projectPrompt) fields['shuvix-project-prompt'] = true

  const frontmatter = stringifyYaml(fields, { lineWidth: 0 }).trimEnd()
  const body = data.systemPrompt.trim()
  return `---\n${frontmatter}\n---\n${body ? `\n${body}\n` : ''}`
}
