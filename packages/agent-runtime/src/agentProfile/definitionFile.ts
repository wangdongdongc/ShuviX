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
 *     条目大小写不敏感（内置工具名归一为小写注册名），`agent` 为嵌套派发 opt-in，
 *     `mcp:<server>` / `skill:<name>` 前缀语法为 ShuviX 扩展（余部大小写保留）；
 *   - ShuviX 自有字段带 `shuvix-` 前缀：`shuvix-displayName`、模型 `shuvix-model`、
 *     曝光开关 `shuvix-session-awareness`，与两个上下文注入声明：
 *     `shuvix-instruction-files`（**逗号分隔的文件清单**，如
 *     `shuvix-instruction-files: AGENTS.md, CLAUDE.md`：该 agent 认哪些项目指令文件，
 *     按列出顺序取**第一个存在且非空**的注入，至多一个；省略 = 不注入），
 *     与布尔开关 `shuvix-project-awareness`（**项目感知**：该 agent 是否了解它所在的项目 ——
 *     项目提示词与项目记忆索引一并注入）；
 *     项目感知曾是 `shuvix-project-prompt` / `shuvix-project-memory` 两个开关，合成一个是因为
 *     它们同源同废：都由「这个 agent 要不要知道自己在哪个项目里」这一个意图决定，都按**根会话
 *     的项目**解析、无项目时同样降级为不注入。拆成两问只是把同一个决定问了两遍，而两个答案
 *     不一致（认项目提示词却不认项目记忆）表达不出任何有用的策略。指令文件不并进来 ——
 *     它按 cwd 扫盘、顺序即优先级，是清单不是布尔，与「在不在项目里」无关；
 *     指令文件的「选哪个」曾是会话设置里的单选下拉，现已整体收进本文件 ——
 *     一个 agent 该吃哪份项目文档，是它的人格设定，不是每个会话各自的临时选择；
 *   - `shuvix-builtin: true` 是随包发布的内置档案的**自述标记**：本解析器不读它
 *     （builtin/user 的判定在加载方——buildBuiltinProfile 恒标 builtin，目录扫描恒标 user），
 *     它只在 md 里声明「这份文案出自 ShuviX 内置集」。GUI 写出的用户档案不会带上它
 *     （serialize 的键集是固定白名单），所以复制一份内置档案去改也不会自称内置；
 *   - `shuvix-session-awareness: true`（**会话感知**）表示该档案懂得「自己是一场会话的人格」，
 *     因而可被用户在输入框里选为会话的 agent（`/<agentName>` 切换目标）。**缺省 false** ——
 *     一个 agent 默认只是被派发的执行体：派发是一次性的新鲜上下文，而切成主会话意味着
 *     它要在一场长对话里持续成立，这是要显式声明才成立的能力（那些「政策必须跑在新鲜
 *     上下文里」的执行型 agent，如 wiki-writer，正是不声明它的原因：长对话会稀释系统
 *     提示词的权重，而它们违反政策的代价静默且不可逆）。只管切换、不管派发 ——
 *     不声明照样可被派发；与 BASE_PROFILE_NAMES 的区别是那是「两边都不进」；
 *   - `shuvix-model` 指定该 agent 用哪个模型：GUI 写出恒为 `<providerId>/<modelId>`
 *     （与 `agent.setModel` 的入参一一对应），手写的裸 `<modelId>` 也能读；省略 = 不声明
 *     （跟随会话 / 继承派发方）。本层只做「原样存取」，取值解释（拆前缀 / 对模型目录解析 /
 *     反向写出）是三端共用契约，在 `@shuvix/chat-protocol/agentModelRef`
 *     （渲染进程够不到 agent-runtime，故不放这里）；
 *   - 正文可内嵌 `{{shuvix:name}}` 占位符（createAgent 时按宿主变量表替换）；
 *   - frontmatter 用完整 YAML 解析（支持多行字符串、引号、注释等）。
 *
 * 无历史兼容：旧方言 key（`whenToUse` / `displayName`）、已废弃的 requiredMcp 系 key、
 * 被 `shuvix-session-awareness` 取代的反向开关 `shuvix-dispatch-only`（取值相反：旧文件
 * 不写这个键即可切换，新语义下不写 = 不可切换 —— 刻意不做迁移，见上），
 * `shuvix-prompt-sections`（动态段机制已被 {{shuvix:*}} 变量取代）、被 `shuvix-project-awareness`
 * 合并掉的 `shuvix-project-prompt` / `shuvix-project-memory` 与通用 `tools` key
 * （其他 app 语义，见上）都不再读取（未知 key 忽略）；`shuvix-tools` /
 * `shuvix-instruction-files` / `shuvix-model` 仅接受字符串、两个布尔 key 仅接受布尔，
 * 类型不符视为文件非法（跳过并记警告），宁可整体拒绝也不静默降级 —— 包括
 * `shuvix-instruction-files: true` 这种改制前的写法：布尔已不再是合法取值，
 * 拒绝理由里直说「改列文件名」，比默默按老语义猜一份清单可诊断。
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { splitFrontmatter } from '../markdownFrontmatter'

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
  /**
   * `shuvix-instruction-files`：该 agent 认的项目指令文件清单（工作目录内的相对路径，
   * 已归一去重保序）。**顺序即优先级** —— 注入侧取第一个存在且非空的，至多一个。
   * 缺省 = 空数组（不注入）。
   */
  instructionFiles: string[]
  /**
   * `shuvix-project-awareness`：项目感知 —— 是否向该 agent 注入项目提示词与项目记忆索引
   * （两者同一开关，都按根会话的项目解析）；缺省 false。
   */
  projectAwareness: boolean
  /**
   * `shuvix-session-awareness`：会话感知 —— 该档案可被选为会话自己的 agent
   * （`/<agentName>` 切换目标 / 输入框档案选择器）；缺省 false = 只可被派发。
   */
  sessionAwareness: boolean
}

/**
 * 单个工具条目归一：
 *   - `mcp:` / `skill:` 前缀 → 前缀归小写，余部保留（server / skill 名大小写敏感）；
 *   - 其余 → 小写（对齐内置工具注册名，使 Claude Code 风格的 `Read, Grep` 直接可用；
 *     派发工具 `agent` 同为小写内置名，旧文件里的 `Agent` 由此自动归一）。
 */
function normalizeToolName(raw: string): string {
  const entry = raw.trim()
  if (!entry) return ''
  const prefixed = /^(mcp|skill):(.*)$/i.exec(entry)
  if (prefixed) return `${prefixed[1].toLowerCase()}:${prefixed[2].trim()}`
  return entry.toLowerCase()
}

/**
 * 单个指令文件条目归一：分隔符统一为 `/`，剥掉 `./` 与空段。
 *
 * 只接受**工作目录内的相对路径** —— 绝对路径与含 `..` 的越界段返回 null（判文件非法）。
 * 清单是用户自己写的，本不是攻击面；拦它是因为两端的解析底座不同（桌面 join+读盘、
 * 扩展按目录句柄逐级下钻），越界路径在扩展端根本无从表达，与其一端能一端不能，
 * 不如在契约层就把可写的形状收敛成两端都成立的那一种。
 */
function normalizeInstructionEntry(raw: string): string | null {
  const entry = raw.trim().replace(/\\/g, '/')
  if (!entry) return null
  // 绝对路径：POSIX 的 /x、Windows 的 C:/x 与 UNC 的 //host/share
  if (entry.startsWith('/') || /^[a-zA-Z]:\//.test(entry)) return null
  const parts = entry.split('/').filter((s) => s && s !== '.')
  if (parts.length === 0 || parts.includes('..')) return null
  return parts.join('/')
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
 * agent 形状字段（displayName / description / tools / model / 两个上下文注入声明）——
 * bot md（`shuvix: bot v1`）是 agent md 的**超集**，这几个键在两种文件里必须逐字同义：
 * 同一套类型纪律、同一句拒绝理由。抽成共享函数而非各写一遍，是为了让 agent md 将来
 * 加键/改纪律时 bot 自动跟上 —— 两份复制品迟早会漂移，而漂移出来的差异没人解释得清。
 *
 * `shuvix-session-awareness` 不在其列：它是「能否被切成会话档案」的开关，bot 没有这个概念。
 */
export interface AgentSharedFields {
  displayName: string
  description: string
  tools: string[]
  model?: string
  instructionFiles: string[]
  projectAwareness: boolean
}

export function parseAgentSharedFields(
  fields: Record<string, unknown>,
  name: string
): { fields: AgentSharedFields } | { error: string } {
  // 列表字段仅接受逗号分隔字符串、布尔字段仅接受布尔；类型不符 = 文件非法
  const toolsRaw = fields['shuvix-tools'] ?? null
  if (toolsRaw !== null && typeof toolsRaw !== 'string') {
    return {
      error: '\'shuvix-tools\' must be a comma-separated string (e.g. "read, bash"), not a list'
    }
  }
  const modelRaw = fields['shuvix-model'] ?? null
  if (modelRaw !== null && typeof modelRaw !== 'string') {
    return { error: "'shuvix-model' must be a string (`<modelId>` or `<provider>/<modelId>`)" }
  }
  const projectAwarenessRaw = fields['shuvix-project-awareness'] ?? null
  if (projectAwarenessRaw !== null && typeof projectAwarenessRaw !== 'boolean') {
    return { error: "'shuvix-project-awareness' must be a boolean (true / false)" }
  }
  const instructionRaw = fields['shuvix-instruction-files'] ?? null
  if (instructionRaw !== null && typeof instructionRaw !== 'string') {
    return {
      error:
        "'shuvix-instruction-files' must be a comma-separated file list " +
        '(e.g. "AGENTS.md, CLAUDE.md"); the boolean form is gone — list the file names instead'
    }
  }

  // 省略 = 空白名单（无工具）；去重保序
  const tools =
    toolsRaw === null
      ? []
      : [...new Set(splitList(toolsRaw).map(normalizeToolName))].filter(Boolean)

  // 指令文件清单：逐条归一，越界条目判整份文件非法
  const instructionFiles: string[] = []
  for (const entry of instructionRaw === null ? [] : splitList(instructionRaw)) {
    const normalized = normalizeInstructionEntry(entry)
    if (!normalized) {
      return {
        error: `'shuvix-instruction-files' entry '${entry}' must be a relative path inside the working directory`
      }
    }
    if (!instructionFiles.includes(normalized)) instructionFiles.push(normalized)
  }

  return {
    fields: {
      displayName: stringField(fields, 'shuvix-displayName') ?? name,
      description: stringField(fields, 'description') ?? '',
      tools,
      model: stringField(fields, 'shuvix-model'),
      instructionFiles,
      projectAwareness: projectAwarenessRaw ?? false
    }
  }
}

/**
 * 解析 agent 定义 markdown。格式非法（无 frontmatter / YAML 语法错误 / 字段类型不符）
 * 返回 null，由调用方记日志跳过。`defaultName` 为文件 basename（frontmatter `name` 可覆盖）。
 * `warn`（可选）：诊断出口 —— 判非法时输出人读原因。原文编辑（设置页 / 笔记本属性卡）
 * 下用户会写出非法结构，只返回 null 说不清「哪里错了」；与 policyFile 的 warn 同形同策。
 */
export function parseAgentDefinitionFile(
  raw: string,
  defaultName: string,
  warn?: (msg: string) => void
): ParsedAgentFile | null {
  // 早期失败时 frontmatter 还没解析出 name，用文件 basename 报（原因照样要可见）
  const rejectAs = (who: string, why: string): null => {
    warn?.(`agent '${who}': ${why}; the whole file is rejected`)
    return null
  }

  const split = splitFrontmatter(raw)
  if (!split) return rejectAs(defaultName, 'no YAML frontmatter block')

  let fields: Record<string, unknown>
  try {
    const parsed: unknown = parseYaml(split.yaml)
    if (parsed === null || parsed === undefined) {
      fields = {}
    } else if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      fields = parsed as Record<string, unknown>
    } else {
      return rejectAs(defaultName, 'frontmatter must be a mapping')
    }
  } catch (e) {
    return rejectAs(defaultName, `invalid YAML (${e instanceof Error ? e.message : e})`)
  }

  const name = stringField(fields, 'name') ?? defaultName
  const reject = (why: string): null => rejectAs(name, why)

  // agent 形状字段（与 bot md 共用同一份纪律）
  const shared = parseAgentSharedFields(fields, name)
  if ('error' in shared) return reject(shared.error)

  const sessionAwarenessRaw = fields['shuvix-session-awareness'] ?? null
  if (sessionAwarenessRaw !== null && typeof sessionAwarenessRaw !== 'boolean') {
    return reject("'shuvix-session-awareness' must be a boolean (true / false)")
  }

  return {
    name,
    ...shared.fields,
    systemPrompt: split.body.trim(),
    sessionAwareness: sessionAwarenessRaw ?? false
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
  if (data.instructionFiles.length > 0) {
    fields['shuvix-instruction-files'] = data.instructionFiles.join(', ')
  }
  if (data.projectAwareness) fields['shuvix-project-awareness'] = true
  if (data.sessionAwareness) fields['shuvix-session-awareness'] = true

  const frontmatter = stringifyYaml(fields, { lineWidth: 0 }).trimEnd()
  const body = data.systemPrompt.trim()
  return `---\n${frontmatter}\n---\n${body ? `\n${body}\n` : ''}`
}
