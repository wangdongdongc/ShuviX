/**
 * Bot 定义文件（<name>.md，`shuvix: bot v1`）解析/序列化 —— 设计见 docs/bot-design.md §4。
 *
 * **bot md 是 agent md 的超集**：一个 bot 首先是一个 agent（人设 + 工具 + 模型），正文即
 * **任务段的系统提示词**，`shuvix-tools` / `shuvix-model` / 两个上下文注入声明直接约束
 * 任务段；在此之上加 bot 专属的三样东西 ——
 *
 *  - **管线声明** `shuvix-bot-pipeline`：本 bot 采用哪一份 workflow md 作为管线框架。
 *    管线不是硬编码的 TS 编排，而是一份可读可换的 workflow（设计 §3）；
 *  - **角色表** `shuvix-bot-agents`：**开放的「角色 → agent ref」映射**。角色集合由管线
 *    workflow 定义（内置 bot-chat 用 intent/task/notes），本层只校验形状不校验角色名 ——
 *    把角色枚举写死在格式层，等于让 md 格式追着某一份管线的实现走；
 *  - **笔记区**：正文里一条分界线（botNotes.ts）之下由 bot 自己维护的散文 —— 用户偏好、
 *    项目约定、在做的事。一个 bot 就是一份 md：人设与它学到的东西同处一篇文档，
 *    **整篇正文即任务段的系统提示词**（笔记也在其中 —— 那正是笔记存在的意义）。
 *    分界线是**组织性的**，不是权限墙：笔记段用文件工具就地编辑这份 md，用户要求改人设
 *    （「你以后扮演…」）时它也改得动。线的作用是让人一眼看出哪半边是 bot 自己写的、
 *    让笔记段知道往哪写、让门控段能只取一小片而不是整篇。
 *
 * 处理方式**与 agent md 保持一致**（同一族的第四种文件，不另立方言）：文件类型标记写入恒有、
 * 读取可选；agent 形状的键经 `parseAgentSharedFields` 共用同一份类型纪律与拒绝理由；
 * 未知键忽略；类型不符 = 整份文件非法（null + warn 人读原因）。
 *
 * 只有一处比 agent md 严：**`description` 必填非空** —— 它不是风格选择而是功能要件，
 * 意图段靠它判断「这条消息与我相关吗」，也是别的成员认识它的唯一材料（others 块）。
 *
 * ⚠️ **定义区硬失败，状态区软失败。** 上面那套「整份拒绝」纪律只作用于**定义**
 * （frontmatter）。笔记区是**状态**：它的任何结构异常都只记 anomaly + warn，绝不让整份
 * 文件非法 —— 一次坏的笔记写入不该把 bot 连人设一起从用户正在用的会话里删掉。
 *
 * ⚠️ **序列化器只服务「新建 bot」**（与测试往返）。它从固定键白名单重建 frontmatter，
 * 会丢注释、键序与未知键。**已存在文件的日常维护由笔记段用 `edit` 工具就地改**，
 * 不经这里 —— 宿主没有程序化的笔记写路径，也不需要。
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  BOT_RESPOND_KEY,
  BOT_RESPOND_MODES,
  BOT_RESPOND_TO_KEY,
  BOT_RESPOND_TO_MODES
} from '@shuvix/chat-protocol/shuvixMdDescriptors'
import { parseAgentSharedFields } from '../agentProfile/definitionFile'
import { splitFrontmatter } from '../markdownFrontmatter'
import { splitBotNotes } from './botNotes'

export const BOT_FILE_MARKER_KEY = 'shuvix'
export const BOT_FILE_MARKER = 'bot v1'

export const BOT_PIPELINE_KEY = 'shuvix-bot-pipeline'
export const BOT_INPUT_KEY = 'shuvix-bot-input'
export const BOT_NOTES_KEY = 'shuvix-bot-notes'
export const BOT_AGENTS_KEY = 'shuvix-bot-agents'
export const BOT_GREETING_KEY = 'shuvix-bot-greeting'
export const BOT_SUGGESTIONS_KEY = 'shuvix-bot-suggestions'
export {
  BOT_RESPOND_KEY,
  BOT_RESPOND_MODES,
  BOT_RESPOND_TO_KEY,
  BOT_RESPOND_TO_MODES
} from '@shuvix/chat-protocol/shuvixMdDescriptors'

/** 缺省管线 —— 内置的 `bot-chat` workflow（意图门控 → 任务执行 → 记忆沉淀） */
export const DEFAULT_BOT_PIPELINE = 'bot-chat'

/** 角色名的形状（角色**集合**归管线 workflow 定义，本层只校验形状） */
const ROLE_RE = /^[a-zA-Z][\w-]*$/

/** 门控模式：`auto` = 过意图段判断；`mention-only` = 未被 @ 提及即终止（零 LLM 成本） */
export type BotRespondMode = (typeof BOT_RESPOND_MODES)[number]
/** 响应谁说的话：`user` = 只响应用户消息（缺省）；`all` = 也响应其它 bot 的消息 */
export type BotRespondToMode = (typeof BOT_RESPOND_TO_MODES)[number]

export interface ParsedBotFile {
  name: string
  displayName: string
  /** 一句话人设摘要 —— 必填（意图段的相关性判据） */
  description: string
  /**
   * **整篇正文**（人设 + 笔记），即任务段的系统提示词 —— bot 当然要知道自己学过什么。
   * 需要只要人设或只要笔记的调用方（如门控段的预算）用下面两个字段。
   */
  systemPrompt: string
  tools: string[]
  model?: string
  instructionFiles: string[]
  projectAwareness: boolean
  /** 管线框架：一份 workflow md 的注册表名；缺省 `bot-chat` */
  pipeline: string
  /** 传给管线 workflow 的额外入参（对应其 `shuvix-workflow-input`）；缺省 `{}` */
  pipelineInput: Record<string, unknown>
  /** 门控模式；缺省 'auto' */
  respond: BotRespondMode
  /**
   * 响应谁说的话（v2）。缺省 `user` —— 与 v1「bot 的回复不触发 bot」的硬规则等价。
   * 置 `all` 时才有 bot→bot 接力，届时由 hop / 单轮扇出两道护栏保证终止（见 botGate）。
   */
  respondTo: BotRespondToMode
  /** 笔记开关：这个 bot 要不要维护自己的笔记；缺省 true */
  notesEnabled: boolean
  /** 开放的「角色 → agent ref」表；缺省空表（角色各走管线定义的缺省） */
  agents: Record<string, string>
  /** 开场白（会话首次出现该 bot 时作为真实 bot 消息落树）；缺省空串 */
  greeting: string
  /** 建议问题（点击 = 文本进输入框 + 隐式定向该 bot）；缺省空数组 */
  suggestions: string[]
  /**
   * 笔记区的散文（分界线之下，已 trim）；无分界线为 null。
   *
   * **派生字段**：它是 `systemPrompt` 的一个切片，不是与之并列的另一份内容 —— 单列出来
   * 只为门控段按预算取片与设置页显示用量。序列化器因此**只写 `systemPrompt`**、忽略本字段，
   * 免得两者能各说各话。
   */
  notes: string | null
}

function stringField(fields: Record<string, unknown>, key: string): string | undefined {
  const v = fields[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 解析 bot 定义 markdown。**定义**结构非法返回 null，原因经 `warn`
 * （与 agent/workflow/policy 解析器同形同策）。**记忆区**的结构异常只经 `warn` 提示，
 * 不影响返回值 —— 见文件头注释的「定义区硬失败、状态区软失败」。
 */
export function parseBotDefinitionFile(
  raw: string,
  defaultName: string,
  warn?: (msg: string) => void
): ParsedBotFile | null {
  const rejectAs = (who: string, why: string): null => {
    warn?.(`bot '${who}': ${why}; the whole file is rejected`)
    return null
  }

  const split = splitFrontmatter(raw)
  if (!split) return rejectAs(defaultName, 'no YAML frontmatter block')

  let fields: Record<string, unknown>
  try {
    const parsed: unknown = parseYaml(split.yaml)
    if (parsed === null || parsed === undefined) fields = {}
    else if (isMapping(parsed)) fields = parsed
    else return rejectAs(defaultName, 'frontmatter must be a mapping')
  } catch (e) {
    return rejectAs(defaultName, `invalid YAML (${e instanceof Error ? e.message : e})`)
  }

  const name = stringField(fields, 'name') ?? defaultName
  const reject = (why: string): null => rejectAs(name, why)

  // ── agent 形状字段（与 agent md 逐字同义） ──
  const shared = parseAgentSharedFields(fields, name)
  if ('error' in shared) return reject(shared.error)

  // description 必填 —— bot 专属的功能要件（见文件头注释）
  if (!shared.fields.description) {
    return reject("'description' is required — the intent stage uses it to judge relevance")
  }

  // ── 管线声明 ──
  const pipelineRaw = fields[BOT_PIPELINE_KEY] ?? null
  if (pipelineRaw !== null && (typeof pipelineRaw !== 'string' || !pipelineRaw.trim())) {
    return reject(`'${BOT_PIPELINE_KEY}' must be the name of a workflow`)
  }
  const inputRaw = fields[BOT_INPUT_KEY] ?? null
  if (inputRaw !== null && !isMapping(inputRaw)) {
    return reject(`'${BOT_INPUT_KEY}' must be a mapping of parameters for the pipeline workflow`)
  }

  // ── 门控 / 记忆开关 ──
  const respondRaw = fields[BOT_RESPOND_KEY] ?? null
  if (respondRaw !== null && !(BOT_RESPOND_MODES as readonly unknown[]).includes(respondRaw)) {
    return reject(`'${BOT_RESPOND_KEY}' must be one of: ${BOT_RESPOND_MODES.join(' | ')}`)
  }
  const respondToRaw = fields[BOT_RESPOND_TO_KEY] ?? null
  if (
    respondToRaw !== null &&
    !(BOT_RESPOND_TO_MODES as readonly unknown[]).includes(respondToRaw)
  ) {
    return reject(`'${BOT_RESPOND_TO_KEY}' must be one of: ${BOT_RESPOND_TO_MODES.join(' | ')}`)
  }
  const notesRaw = fields[BOT_NOTES_KEY] ?? null
  if (notesRaw !== null && typeof notesRaw !== 'boolean') {
    return reject(`'${BOT_NOTES_KEY}' must be a boolean (true / false)`)
  }

  // ── 角色表（开放：只校验形状，不校验角色名） ──
  const agents: Record<string, string> = {}
  const agentsRaw = fields[BOT_AGENTS_KEY] ?? null
  if (agentsRaw !== null) {
    if (!isMapping(agentsRaw)) {
      return reject(`'${BOT_AGENTS_KEY}' must be a mapping of role → agent name`)
    }
    for (const [role, value] of Object.entries(agentsRaw)) {
      if (!ROLE_RE.test(role)) {
        return reject(`'${BOT_AGENTS_KEY}': '${role}' is not a valid role name`)
      }
      if (typeof value !== 'string' || !value.trim()) {
        return reject(`'${BOT_AGENTS_KEY}.${role}' must be an agent name`)
      }
      agents[role] = value.trim()
    }
  }
  // 角色指向不存在的 agent **不判非法**：agent 文件可以后补（同 workflow 未知埋点的惰性化
  // 理由）。运行时回落管线缺省并在决策记录里注明；本层只管形状。

  // ── 表现层 ──
  const greetingRaw = fields[BOT_GREETING_KEY] ?? null
  if (greetingRaw !== null && typeof greetingRaw !== 'string') {
    return reject(`'${BOT_GREETING_KEY}' must be a string`)
  }
  const suggestionsRaw = fields[BOT_SUGGESTIONS_KEY] ?? null
  const suggestions: string[] = []
  if (suggestionsRaw !== null) {
    // 刻意用 YAML 列表而非 `shuvix-tools` 式的逗号串：建议问题是整句，逗号是它的正常内容
    if (!Array.isArray(suggestionsRaw)) {
      return reject(`'${BOT_SUGGESTIONS_KEY}' must be a list of strings`)
    }
    for (const entry of suggestionsRaw) {
      if (typeof entry !== 'string' || !entry.trim()) {
        return reject(`'${BOT_SUGGESTIONS_KEY}' entries must be non-empty strings`)
      }
      suggestions.push(entry.trim())
    }
  }

  // ── 正文切分：整篇即系统提示词，人设/笔记各自单列 ──
  const parts = splitBotNotes(split.body)
  const systemPrompt = split.body.trim()
  // 人设（分界线之上）只用于「正文得有东西」这条校验 —— 不进解析产物：它是 systemPrompt
  // 的切片，存两份就会有两份各说各话的可能
  const persona = parts.persona.trim()
  // 笔记区的异常经 warn 提示但**不带 rejected 后缀** —— 状态区软失败
  for (const anomaly of parts.anomalies) {
    warn?.(`bot '${name}': notes: ${anomaly}`)
  }

  if (!persona && !agents.task) {
    return reject(
      `the body is the task stage's system prompt — write one, or point '${BOT_AGENTS_KEY}.task' at an agent`
    )
  }
  if (persona && agents.task) {
    warn?.(`bot '${name}': '${BOT_AGENTS_KEY}.task' replaces the task stage — the body is not used`)
  }

  return {
    name,
    ...shared.fields,
    systemPrompt,
    pipeline: (pipelineRaw as string | null)?.trim() || DEFAULT_BOT_PIPELINE,
    pipelineInput: (inputRaw as Record<string, unknown> | null) ?? {},
    respond: (respondRaw as BotRespondMode | null) ?? 'auto',
    respondTo: (respondToRaw as BotRespondToMode | null) ?? 'user',
    notesEnabled: notesRaw ?? true,
    agents,
    greeting: greetingRaw?.trim() ?? '',
    suggestions,
    notes: parts.notes
  }
}

/**
 * 序列化为标准格式文件内容。**只服务「新建 bot」与测试往返** —— 见文件头注释：
 * 它从固定键白名单重建 frontmatter，用户手写的注释、键序与未知键都会丢，所以已存在的
 * 文件永远不走这里。与 parse 互逆：缺省值省略、key 顺序固定（文件类型标记居首）。
 * 正文原样写出 —— `notes` 是 `systemPrompt` 的派生切片，不参与序列化。
 */
export function serializeBotDefinitionFile(data: ParsedBotFile): string {
  const fields: Record<string, unknown> = {
    [BOT_FILE_MARKER_KEY]: BOT_FILE_MARKER,
    name: data.name
  }
  if (data.description.trim()) fields.description = data.description.trim()
  if (data.displayName.trim() && data.displayName.trim() !== data.name) {
    fields['shuvix-displayName'] = data.displayName.trim()
  }
  if (data.tools.length > 0) fields['shuvix-tools'] = data.tools.join(', ')
  if (data.model?.trim()) fields['shuvix-model'] = data.model.trim()
  if (data.pipeline && data.pipeline !== DEFAULT_BOT_PIPELINE) {
    fields[BOT_PIPELINE_KEY] = data.pipeline
  }
  if (Object.keys(data.pipelineInput).length > 0) fields[BOT_INPUT_KEY] = data.pipelineInput
  // 角色是开放集合，没有「阶段顺序」可依；按字母序输出以保证同一份数据恒得同一份文件
  const roles = Object.keys(data.agents).sort()
  if (roles.length > 0) {
    fields[BOT_AGENTS_KEY] = Object.fromEntries(roles.map((r) => [r, data.agents[r]]))
  }
  if (data.respond !== 'auto') fields[BOT_RESPOND_KEY] = data.respond
  if (data.respondTo !== 'user') fields[BOT_RESPOND_TO_KEY] = data.respondTo
  if (!data.notesEnabled) fields[BOT_NOTES_KEY] = false
  if (data.greeting.trim()) fields[BOT_GREETING_KEY] = data.greeting.trim()
  if (data.suggestions.length > 0) fields[BOT_SUGGESTIONS_KEY] = data.suggestions
  if (data.instructionFiles.length > 0) {
    fields['shuvix-instruction-files'] = data.instructionFiles.join(', ')
  }
  if (data.projectAwareness) fields['shuvix-project-awareness'] = true

  const frontmatter = stringifyYaml(fields, { lineWidth: 0 }).trimEnd()
  // 正文原样写出（`systemPrompt` 就是整篇正文，笔记已在其中）—— 不从 notes 再拼一次，
  // 否则同一段文字会被写两遍，且两个字段一旦不一致就没有哪一份说了算
  const body = data.systemPrompt.trim()
  return `---\n${frontmatter}\n---\n${body ? `\n${body}\n` : ''}`
}

/**
 * 任务段 agent 的 ref 前缀。
 *
 * **必须是全局可寻址的 `bot:<name>`，不能是 `bot:self`**：引擎的 `resolveAgentProfile`
 * 是一个无 run 上下文的全局 dep，相对 ref 在那里永远解析不出来（M4′ 定名时的裁决）。
 */
export const BOT_AGENT_REF_PREFIX = 'bot:'

/** `bot:<name>` → `<name>`；不是 bot ref 则 null。名字原样保留（CJK / 空格都合法） */
export function parseBotAgentRef(ref: string): string | null {
  if (!ref.startsWith(BOT_AGENT_REF_PREFIX)) return null
  const name = ref.slice(BOT_AGENT_REF_PREFIX.length).trim()
  return name || null
}

/**
 * ParsedBotFile → 运行投影。**agent 即 bot 自身**（设计 §6.2）：正文就是它的系统提示词、
 * `shuvix-tools` / `shuvix-model` / 指令文件 / 项目感知全部照常生效。
 *
 * 与 `toInProcessAgentType`（AgentProfile 那条）刻意分开写而不是让两种文件共用一个类型：
 * bot md 比 agent md 多出管线、门控模式、开场白、笔记这些**只有 bot 才有**的字段，
 * 硬凑成一个类型会让「哪些字段对 agent 有意义」变得不可读。这里是投影，不是继承。
 *
 * `systemPrompt` 取的是**整篇正文（含笔记区）** —— bot 当然要知道自己学过什么。
 */
export function botToInProcessAgentType(bot: ParsedBotFile): {
  name: string
  displayName: string
  description: string
  tools: string[]
  systemPrompt: string
  model?: string
  instructionFiles: string[]
  projectAwareness: boolean
} {
  return {
    name: bot.name,
    displayName: bot.displayName,
    description: bot.description,
    tools: [...bot.tools],
    systemPrompt: bot.systemPrompt,
    ...(bot.model ? { model: bot.model } : {}),
    instructionFiles: [...bot.instructionFiles],
    projectAwareness: bot.projectAwareness
  }
}
