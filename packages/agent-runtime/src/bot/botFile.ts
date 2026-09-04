/**
 * Bot 定义文件（<name>.md，`shuvix: bot v1`）解析/序列化 —— 设计见 docs/bot-design.md §4。
 *
 * **一个 bot 是一份绑定：身份 + 管线 + 槽位 + 一篇正文。** 它自己不再是 agent ——
 * 模型、工具、指令文件这些是 agent md 的事，bot 只说「用哪份 workflow 当管线、管线的
 * 每个槽位由哪份 agent md 来干」：
 *
 *  - **管线声明** `shuvix-bot-pipeline`：本 bot 采用哪一份 workflow md 作为管线框架，
 *    缺省内置 `bot-chat`；
 *  - **槽位表** `shuvix-bot-agents`：**开放的「槽位 → agent 名」映射**。槽位集合由管线
 *    workflow 定义（内置 bot-chat 要 intent / task，可选 recheck），本层只校验形状不校验
 *    槽位名 —— 把槽位枚举写死在格式层，等于让 md 格式追着某一份管线的实现走。哪些槽位
 *    必填、填了不存在的 agent 怎么办，都是宿主对照管线现判的事（惰性化：agent 文件可后补）；
 *  - **正文**：这个 bot 的**人设与记忆**，一篇普通的 markdown 散文。它不是任何一个 agent 的
 *    系统提示词，而是像项目上下文那样，被宿主围栏后**追加到参与本 bot 执行的每一个 agent
 *    的系统提示词末尾**（`renderBotContext`）。正文由 bot 自己维护 —— 任务段 agent 拿自己
 *    的文件工具就地改这份 md（用户说「以后用日语答」、说了一条长期偏好，它就写进去）。
 *    没有分界线、没有条目格式、没有「笔记」这个概念：人设和记忆是同一篇文档的不同段落。
 *
 * 处理方式**与 agent md 保持一致**（同一族的第四种文件，不另立方言）：文件类型标记写入恒有、
 * 读取可选；未知键忽略（`shuvix-tools` / `shuvix-model` 这些 agent 键写在 bot 上也只是被
 * 忽略，不判非法）；类型不符 = 整份文件非法（null + warn 人读原因）。
 *
 * 只有一处比 agent md 严：**`description` 必填非空** —— 它不是风格选择而是功能要件，
 * 意图段靠它判断「这条消息与我相关吗」，也是别的成员认识它的唯一材料（others 块）。
 *
 * ⚠️ **序列化器只服务「新建 bot」**（与测试往返）。它从固定键白名单重建 frontmatter，
 * 会丢注释、键序与未知键。**已存在文件的日常维护由 bot 自己用 `edit` 工具就地改**、
 * 或用户在设置页原样保存，不经这里。
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { splitFrontmatter } from '../markdownFrontmatter'

export const BOT_FILE_MARKER_KEY = 'shuvix'
export const BOT_FILE_MARKER = 'bot v1'

export const BOT_PIPELINE_KEY = 'shuvix-bot-pipeline'
export const BOT_INPUT_KEY = 'shuvix-bot-input'
export const BOT_AGENTS_KEY = 'shuvix-bot-agents'

/** 缺省管线 —— 内置的 `bot-chat` workflow（意图门控 → 任务执行） */
export const DEFAULT_BOT_PIPELINE = 'bot-chat'

/** 槽位名的形状（槽位**集合**归管线 workflow 定义，本层只校验形状） */
const ROLE_RE = /^[a-zA-Z][\w-]*$/

export interface ParsedBotFile {
  name: string
  displayName: string
  /** 一句话人设摘要 —— 必填（意图段的相关性判据） */
  description: string
  /**
   * 正文：这个 bot 的人设与记忆（已 trim；可为空）。围栏后追加到参与本 bot 执行的
   * 每个 agent 的系统提示词末尾 —— 见 `renderBotContext`。
   */
  body: string
  /** 管线框架：一份 workflow md 的注册表名；缺省 `bot-chat` */
  pipeline: string
  /** 传给管线 workflow 的额外入参（对应其 `shuvix-workflow-input`）；缺省 `{}` */
  pipelineInput: Record<string, unknown>
  /** 开放的「槽位 → agent 名」表；缺省空表 */
  agents: Record<string, string>
}

function stringField(fields: Record<string, unknown>, key: string): string | undefined {
  const v = fields[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 解析 bot 定义 markdown。结构非法返回 null，原因经 `warn`
 * （与 agent/workflow/policy 解析器同形同策）。
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

  // ── 身份 ──
  const displayNameRaw = fields['shuvix-displayName'] ?? null
  if (displayNameRaw !== null && typeof displayNameRaw !== 'string') {
    return reject("'shuvix-displayName' must be a string")
  }
  const descriptionRaw = fields.description ?? null
  if (descriptionRaw !== null && typeof descriptionRaw !== 'string') {
    return reject("'description' must be a string")
  }
  // description 必填 —— bot 专属的功能要件（见文件头注释）
  const description = stringField(fields, 'description')
  if (!description) {
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

  // ── 槽位表（开放：只校验形状，不校验槽位名） ──
  const agents: Record<string, string> = {}
  const agentsRaw = fields[BOT_AGENTS_KEY] ?? null
  if (agentsRaw !== null) {
    if (!isMapping(agentsRaw)) {
      return reject(`'${BOT_AGENTS_KEY}' must be a mapping of slot → agent name`)
    }
    for (const [role, value] of Object.entries(agentsRaw)) {
      if (!ROLE_RE.test(role)) {
        return reject(`'${BOT_AGENTS_KEY}': '${role}' is not a valid slot name`)
      }
      if (typeof value !== 'string' || !value.trim()) {
        return reject(`'${BOT_AGENTS_KEY}.${role}' must be an agent name`)
      }
      agents[role] = value.trim()
    }
  }
  // 槽位指向不存在的 agent、或管线要求的槽位没填，都**不判非法**：agent 文件可以后补，
  // 而哪些槽位是必填的只有对照管线才知道。运行时由宿主判定并在会话里可见地说明。

  return {
    name,
    displayName: stringField(fields, 'shuvix-displayName') ?? name,
    description,
    body: split.body.trim(),
    pipeline: (pipelineRaw as string | null)?.trim() || DEFAULT_BOT_PIPELINE,
    pipelineInput: (inputRaw as Record<string, unknown> | null) ?? {},
    agents
  }
}

/**
 * 序列化为标准格式文件内容。**只服务「新建 bot」与测试往返** —— 见文件头注释：
 * 它从固定键白名单重建 frontmatter，用户手写的注释、键序与未知键都会丢，所以已存在的
 * 文件永远不走这里。与 parse 互逆：缺省值省略、key 顺序固定（文件类型标记居首）。
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
  if (data.pipeline && data.pipeline !== DEFAULT_BOT_PIPELINE) {
    fields[BOT_PIPELINE_KEY] = data.pipeline
  }
  if (Object.keys(data.pipelineInput).length > 0) fields[BOT_INPUT_KEY] = data.pipelineInput
  // 槽位是开放集合，没有「阶段顺序」可依；按字母序输出以保证同一份数据恒得同一份文件
  const roles = Object.keys(data.agents).sort()
  if (roles.length > 0) {
    fields[BOT_AGENTS_KEY] = Object.fromEntries(roles.map((r) => [r, data.agents[r]]))
  }

  const frontmatter = stringifyYaml(fields, { lineWidth: 0 }).trimEnd()
  const body = data.body.trim()
  return `---\n${frontmatter}\n---\n${body ? `\n${body}\n` : ''}`
}
