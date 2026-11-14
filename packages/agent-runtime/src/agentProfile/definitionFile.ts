/**
 * Agent 定义文件（<name>.md）解析 —— 标准化格式。
 *
 * 格式对齐 Claude Code 社区惯例：YAML frontmatter + 正文即 system prompt。
 *   - 首行 `shuvix: agent v1` 是**文件类型标记**（与 `shuvix: policy v1` 同形）：
 *     声明这份 markdown 是 ShuviX 的智能体定义文件。写入时恒输出，读取时**可选** ——
 *     标记引入之前的用户档案不带它，不能因此失效；经 GUI 再保存一次即自动补上；
 *   - 通用 key 与社区惯例同名同义：`name` / `description`；
 *   - 工具白名单用 `shuvix-tools`（逗号分隔字符串，如 `shuvix-tools: read, grep, bash`）——
 *     刻意不用通用的 `tools` key：ShuviX 工具名与其他 app 不兼容，带前缀可避免
 *     agent md 迁移到其他应用时被误读。省略 = 空白名单（无工具）；
 *     条目大小写不敏感（内置工具名归一为小写注册名），`agent` 为嵌套派发 opt-in，
 *     `mcp:<server>` 前缀语法为 ShuviX 扩展（余部大小写保留）；`skill` 给这个 agent 技能工具 ——
 *     货架是侧栏里启用着的全部技能，档案不再逐个点名（2026-10-28，按主流用法）：旧写法
 *     `skill:<name>` 读作 `skill`；
 *   - ShuviX 自有字段带 `shuvix-` 前缀：`shuvix-displayName`、模型 `shuvix-model`，
 *     与提示词块清单 `shuvix-prompt-blocks`（逗号分隔，固定词表见 chat-protocol `agentPromptBlocks.ts`，
 *     如 `shuvix-prompt-blocks: environment, drawing, agents_md, claude_md, project_prompt`）：
 *     系统提示词在正文之后还追加哪几块，每块由宿主渲染、包在一个 XML 标签里。它是集合不是顺序
 *     （先后由宿主固定）；省略 = 一块都不追加；不认识的名字忽略并发一条软提示（词表以后会长，
 *     新版本写的档案不该在旧版本里整份失效）。它取代了正文里的 `{{shuvix:*}}` 变量（对用户难懂）
 *     与两个旧键 `shuvix-instruction-files`（拆成 `agents_md` / `claude_md` 两项，各读各的）、
 *     `shuvix-project-awareness`（`project_prompt`）—— 2026-11-13，无迁移：旧键按未知键忽略，
 *     正文里的旧变量原样留着；
 *   - 布尔开关 `shuvix-user-words`（**用户原话**：这个 agent 作为子会话收父会话的消息时，宿主把用户在父会话里自己
 *     写的话原样附上 —— 打的消息与对 ask 卡片的回答，父 agent 改不了；桌面 services/userWords.ts）。它写在**接收方**
 *     档案里，因为要不要知道用户的原话是这个 agent 怎么干活的一部分（2026-11-07 裁定，与 `shuvix-thinking` 同理：
 *     运行方式写在档案里，打开就看得见，而不是宿主替它悄悄决定）；省略 = false；
 *   - `shuvix-builtin: true` 是随包发布的内置档案的**自述标记**：本解析器不读它
 *     （builtin/user 的判定在加载方——buildBuiltinProfile 恒标 builtin，目录扫描恒标 user），
 *     它只在 md 里声明「这份文案出自 ShuviX 内置集」。GUI 写出的用户档案不会带上它
 *     （serialize 的键集是固定白名单），所以复制一份内置档案去改也不会自称内置；
 *   - `shuvix-id` 是对象 id（UUID，或内置的 `agent:builtin:<name>`）：ShuviX 的扩展元数据只认它
 *     （chat-protocol mdMeta.ts）。写错不判非法，按「没有 id」读并发一条软提示；序列化恒写在标记之后；
 *   - `shuvix-model` 指定该 agent 用哪个模型：GUI 写出恒为 `<providerId>/<modelId>`
 *     （与 `agent.setModel` 的入参一一对应），手写的裸 `<modelId>` 也能读；省略 = 不声明
 *     （跟随会话 / 继承派发方）。本层只做「原样存取」，取值解释（拆前缀 / 对模型目录解析 /
 *     反向写出）是三端共用契约，在 `@shuvix/chat-protocol/agentModelRef`
 *     （渲染进程够不到 agent-runtime，故不放这里）；
 *   - `shuvix-thinking` 声明该 agent 的思考档位，取值是界面可选的那几档（`SELECTABLE_THINKING_LEVELS`：
 *     off / low / medium / high / xhigh / max；大小写不敏感，写出恒小写）；省略 = 不声明（跟随派发方 /
 *     父会话）。生效口径与 `shuvix-model` 平行：派生 agent 创建时压过派发方的档位；被 `agent_profile`
 *     点名的子会话把它作为种子写进会话树；写在基座上是这类会话没选过档位时的缺省（会话里选的优先）。它是一个键而不是
 *     宿主规则，是因为「这个 agent 不思考」这类运行方式必须写在档案里、打开就看得见 —— 宿主替某个
 *     agent 悄悄关掉，用户既看不到，也不知道该去改哪里；
 *   - frontmatter 用完整 YAML 解析（支持多行字符串、引号、注释等）。
 *
 * 无历史兼容：旧方言 key（`whenToUse` / `displayName`）、已废弃的 requiredMcp 系 key、
 * 曝光开关 `shuvix-dispatch-only` 及后来取代它的 `shuvix-session-awareness`（「能否当一场
 * 会话的人格」曾是档案的属性；会话内切换档案下线、根档案改由会话形态推导之后，唯一还问
 * 这个问题的是子会话的 `agent_profile`，而它只需要「不是基座」——一个只剩一个消费方、
 * 又要用户自己在 GUI 里勾的开关不值得留，刻意不做迁移：老文件里的这一行按未知键忽略），
 * `shuvix-prompt-sections`、`shuvix-instruction-files`、`shuvix-project-awareness`、更早的
 * `shuvix-project-prompt` / `shuvix-project-memory` 与通用 `tools` key
 * （其他 app 语义，见上）都不再读取（未知 key 忽略）；`shuvix-tools` /
 * `shuvix-prompt-blocks` / `shuvix-model` 仅接受字符串、`shuvix-thinking` 仅接受那几档之一、
 * 布尔 key `shuvix-user-words` 仅接受布尔，
 * 类型不符视为文件非法（跳过并记警告），宁可整体拒绝也不静默降级。
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  SELECTABLE_THINKING_LEVELS,
  isSelectableThinkingLevel,
  type SelectableThinkingLevel
} from '@shuvix/chat-protocol/types/thinking'
import {
  AGENT_PROMPT_BLOCKS,
  AGENT_PROMPT_BLOCKS_KEY,
  isAgentPromptBlock,
  orderPromptBlocks,
  type AgentPromptBlock
} from '@shuvix/chat-protocol/agentPromptBlocks'
import {
  MD_FM_FILL_KEYS,
  MD_IDENTITY_KEYS,
  SHUVIX_ID_KEY,
  isDeclared
} from '@shuvix/chat-protocol/mdMeta'
import { splitFrontmatter } from '../markdownFrontmatter'
import { readObjectIdField } from '../mdObjectId'

/**
 * 文件类型标记的 frontmatter key 与值 —— `shuvix: agent v1`。
 * 序列化时恒写在首位；解析时不作要求（见文件头注释的向后兼容说明）。
 */
export const AGENT_FILE_MARKER_KEY = 'shuvix'
export const AGENT_FILE_MARKER = 'agent v1'

/** 解析产物：AgentProfile 中来自文件本身的字段（source/basePath 由调用方补齐） */
export interface ParsedAgentFile {
  name: string
  /** `shuvix-id`：对象 id（已归一）；没写或写错 = 省略（不挂任何扩展元数据） */
  objectId?: string
  displayName: string
  description: string
  systemPrompt: string
  tools: string[]
  /** `shuvix-model` 原样字符串（`<modelId>` 或 `<provider>/<modelId>`）；省略 = 不声明 */
  model?: string
  /** `shuvix-thinking` 声明的思考档位（已归一为小写）；省略 = 不声明 */
  thinkingLevel?: SelectableThinkingLevel
  /**
   * `shuvix-prompt-blocks`：正文之后追加哪几块（已归一：去重、按词表次序）。缺省 = 空数组（一块都不追加）。
   */
  promptBlocks: AgentPromptBlock[]
  /**
   * `shuvix-user-words`：作为子会话时收不收父会话里用户的原话（宿主原样附上）；只在为真时出现，省略 = false
   */
  userWords?: boolean
}

/**
 * 单个工具条目归一：
 *   - `mcp:` 前缀 → 前缀归小写，余部保留（server 名大小写敏感）；
 *   - `skill:<name>` → `skill`：技能不再按档案点名，点过名的档案要的是技能工具，货架是全部启用着的
 *     （与 Claude Code / Codex 同一用法；去重之后一份档案至多一个 `skill`）；
 *   - 其余 → 小写（对齐内置工具注册名，使 Claude Code 风格的 `Read, Grep` 直接可用；
 *     派发工具 `agent` 同为小写内置名，旧文件里的 `Agent` 由此自动归一）。
 */
function normalizeToolName(raw: string): string {
  const entry = raw.trim()
  if (!entry) return ''
  if (/^skill:/i.test(entry)) return 'skill'
  const prefixed = /^mcp:(.*)$/i.exec(entry)
  if (prefixed) return `mcp:${prefixed[1].trim()}`
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
 * agent 形状字段（displayName / description / tools / model / thinking / 提示词块清单）。
 *
 * 抽成独立函数是 bot md v1 时代的遗留：那时 bot md 是 agent md 的超集，这几个键在两种文件里
 * 必须逐字同义。bot md v2 只剩身份与正文，已不调用它 —— 这里的键如今只属于 agent md，
 * 加键不会让 bot md 跟着多认一个键。
 */
export interface AgentSharedFields {
  displayName: string
  description: string
  tools: string[]
  model?: string
  thinkingLevel?: SelectableThinkingLevel
  promptBlocks: AgentPromptBlock[]
  /** `shuvix-user-words`；只在为真时出现 */
  userWords?: boolean
  knowledge?: boolean
}

export function parseAgentSharedFields(
  fields: Record<string, unknown>,
  name: string,
  warn?: (msg: string) => void
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
  // 空串与省略同义（同 shuvix-model）；其余必须是界面可选的那几档之一 ——
  // 写成布尔（`shuvix-thinking: false`）或别的词都判非法，宁可说清也不猜
  const thinkingRaw = fields['shuvix-thinking'] ?? null
  const thinking = typeof thinkingRaw === 'string' ? thinkingRaw.trim().toLowerCase() : thinkingRaw
  if (thinking !== null && thinking !== '' && !isSelectableThinkingLevel(thinking)) {
    return {
      error: `'shuvix-thinking' must be one of: ${SELECTABLE_THINKING_LEVELS.join(', ')}`
    }
  }
  const userWordsRaw = fields['shuvix-user-words'] ?? null
  if (userWordsRaw !== null && typeof userWordsRaw !== 'boolean') {
    return { error: "'shuvix-user-words' must be a boolean (true / false)" }
  }
  const blocksRaw = fields[AGENT_PROMPT_BLOCKS_KEY] ?? null
  if (blocksRaw !== null && typeof blocksRaw !== 'string') {
    return {
      error: `'${AGENT_PROMPT_BLOCKS_KEY}' must be a comma-separated string (e.g. "environment, drawing"), not a list`
    }
  }

  // 省略 = 空白名单（无工具）；去重保序
  const tools =
    toolsRaw === null
      ? []
      : [...new Set(splitList(toolsRaw).map(normalizeToolName))].filter(Boolean)

  // 提示词块：大小写不敏感；不认识的名字忽略并提示（词表会长，旧版本读新档案不该整份拒绝）
  const blockNames = (blocksRaw === null ? [] : splitList(blocksRaw)).map((entry) =>
    entry.toLowerCase()
  )
  for (const entry of blockNames) {
    if (!isAgentPromptBlock(entry)) {
      warn?.(
        `agent '${name}': unknown prompt block '${entry}' in '${AGENT_PROMPT_BLOCKS_KEY}' is ignored (known: ${AGENT_PROMPT_BLOCKS.join(', ')})`
      )
    }
  }
  const promptBlocks = orderPromptBlocks(blockNames)

  return {
    fields: {
      displayName: stringField(fields, 'shuvix-displayName') ?? name,
      description: stringField(fields, 'description') ?? '',
      tools,
      model: stringField(fields, 'shuvix-model'),
      ...(isSelectableThinkingLevel(thinking) ? { thinkingLevel: thinking } : {}),
      promptBlocks,
      ...(userWordsRaw === true ? { userWords: true } : {})
      // 只在为真时写出：类型上可选、省略等同 false（既有的档案字面量与往返断言零改动）
    }
  }
}

/**
 * 一组补缺值能不能被 agent 解析器接受（属性卡写入前的校验）：放进一份最小文件里走同一套字段校验。
 * 返回拒绝原因；null = 接受。补缺键只有模型与思考档位两项，彼此没有交叉约束，单独校验即合并后的结论。
 */
export function validateAgentFill(fill: Record<string, unknown>): string | null {
  const result = parseAgentSharedFields(fill, 'agent')
  return 'error' in result ? result.error : null
}

/**
 * 解析 agent 定义 markdown。格式非法（无 frontmatter / YAML 语法错误 / 字段类型不符）
 * 返回 null，由调用方记日志跳过。`defaultName` 为文件 basename（frontmatter `name` 可覆盖）。
 * `warn`（可选）：诊断出口 —— 判非法时输出人读原因。原文编辑（设置页 / 笔记本属性卡）
 * 下用户会写出非法结构，只返回 null 说不清「哪里错了」；与 policyFile 的 warn 同形同策。
 */
export interface ParseAgentFileOptions {
  /**
   * ShuviX 扩展元数据的补缺值（chat-protocol mdMeta.ts）：按这份文件的对象 id 取。只认 agent 白名单
   * （MD_FM_FILL_KEYS.agent）里的键 —— 宿主本该只交这些，解析器再筛一遍，补缺通道放宽不了别的键。
   * **md 优先，只补缺** —— 文件里写了的键不动（isDeclared），身份键永不补；补完交给同一套字段校验，
   * 合并结果不合法就整体弃用补缺、按文件本身解析，并经 warn 说一句（补缺值不能把一份好文件弄坏）。
   * 没有 id 的文件不调它。
   */
  fill?: (objectId: string) => Record<string, unknown> | undefined
}

export function parseAgentDefinitionFile(
  raw: string,
  defaultName: string,
  warn?: (msg: string) => void,
  options?: ParseAgentFileOptions
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
  let shared = parseAgentSharedFields(fields, name, warn)
  if ('error' in shared) return reject(shared.error)

  const objectId = readObjectIdField(fields, `agent '${name}'`, warn)
  const fill = objectId ? options?.fill?.(objectId) : undefined
  if (fill) {
    // 白名单在这里再筛一遍（宿主本该只交白名单内的键）：补缺通道不能被用来放宽工具白名单之类
    const missing = Object.entries(fill).filter(
      ([key]) =>
        MD_FM_FILL_KEYS.agent.includes(key) &&
        !MD_IDENTITY_KEYS.includes(key) &&
        !isDeclared(fields, key)
    )
    if (missing.length > 0) {
      const merged = parseAgentSharedFields({ ...fields, ...Object.fromEntries(missing) }, name)
      if ('error' in merged) {
        warn?.(
          `agent '${name}': ShuviX settings not applied (${merged.error}) — the file's own values are used`
        )
      } else {
        shared = merged
      }
    }
  }
  return {
    name,
    ...(objectId ? { objectId } : {}),
    ...shared.fields,
    systemPrompt: split.body.trim()
  }
}

/**
 * 序列化为标准格式文件内容（编辑 GUI 的保存路径）。与 parseAgentDefinitionFile 互逆：
 * 空值字段省略（displayName 等于 name 时不写；tools 空 / model 未声明 = 省略），
 * key 顺序固定（文件类型标记 `shuvix` 居首，`shuvix-id` 紧随其后），标量经 YAML 引号规则安全转义
 * （lineWidth: 0 禁止折行）。
 */
export function serializeAgentDefinitionFile(data: ParsedAgentFile): string {
  const fields: Record<string, string | boolean> = {
    [AGENT_FILE_MARKER_KEY]: AGENT_FILE_MARKER
  }
  // 对象 id 紧跟标记（与内置 md、setShuvixIdLine 的落点一致）—— 覆盖副本由此沿用内置 id
  if (data.objectId) fields[SHUVIX_ID_KEY] = data.objectId
  fields.name = data.name
  if (data.description.trim()) fields.description = data.description.trim()
  if (data.tools.length > 0) fields['shuvix-tools'] = data.tools.join(', ')
  if (data.model?.trim()) fields['shuvix-model'] = data.model.trim()
  if (data.thinkingLevel) fields['shuvix-thinking'] = data.thinkingLevel
  if (data.displayName.trim() && data.displayName.trim() !== data.name) {
    fields['shuvix-displayName'] = data.displayName.trim()
  }
  if (data.promptBlocks.length > 0) {
    fields[AGENT_PROMPT_BLOCKS_KEY] = orderPromptBlocks(data.promptBlocks).join(', ')
  }
  if (data.userWords) fields['shuvix-user-words'] = true

  const frontmatter = stringifyYaml(fields, { lineWidth: 0 }).trimEnd()
  const body = data.systemPrompt.trim()
  return `---\n${frontmatter}\n---\n${body ? `\n${body}\n` : ''}`
}
