/**
 * Bot 定义文件（`<name>.md`，`shuvix: bot`）解析 / 序列化。
 *
 * 一个 bot 就是一份 markdown：**身份三行 + 一篇正文**。正文是这个 bot 的人设与记忆，由宿主
 * 围栏后追加到它那条会话**根** Agent 的系统提示词末尾（`renderBotContext`）。没有管线、没有
 * 槽位、没有工具与模型声明 —— 那些是**会话**的事（它是一条普通有根会话，模型选择器、工具
 * 勾选、子会话一应俱全），怎么干活由基座档案 `bot` 统一规定。
 *
 * **格式沿革：v2 去掉了管线。** v1 文件把「用哪条 workflow 当管线、每个槽位派哪个 agent」写在
 * `shuvix-bot-pipeline` 块里；那套管线已整体拆除。v1 文件**照常解析** —— 正文本来就是人设与
 * 记忆，语义没变 —— 残留的管线块被忽略，并经 `warn` 发一条软提示请用户删掉：它看起来像在起
 * 作用，其实什么也不做。v1 必填的 `description` 在 v2 里可选：它曾是意图门判断相关性的材料，
 * 门没了，它只剩「列表里的一句话」。
 *
 * 处理方式与同族 md 一致：文件类型标记**写入恒有、读取可选**（手写文件漏了首行仍能用），但
 * **标记类型不符 = 整份文件非法** —— 一份 agent md 掉进 bots 目录会被明确拒绝，而不是被当成
 * 人设读进系统提示词；判别只看类型段，版本号升级不让旧文件消失。其余未知键忽略。
 *
 * `shuvix-id` 是对象 id（ShuviX 扩展元数据只认它，见 chat-protocol mdMeta.ts）：写错不判非法，
 * 按「没有 id」读并发一条软提示。
 *
 * **触发绑定**（`shuvix-bot-on`，可选，2026-10-24）：`[{trigger, when?, message}]` —— 与 hook 的 `shuvix-hook-on`
 * 同一张埋点表、同一套 CEL `when`（上下文 `{event, env}`），多一个 `message`：命中时宿主新建一条绑定这个 bot 的
 * 会话，把 `message`（后面附上事件围栏）作为来源为 `trigger` 的用户消息发进去。bot 只订阅**全局**埋点（如
 * `timer.fired`）：会话域埋点每轮都发，而 bot 的每次触发都新建一条会话 —— 订阅它们等于让会话自己生会话，判非法。
 * 未知埋点 id 与 hook 同策：绑定惰性化 + 软提示。
 *
 * `warn` 承载两类话：返回 null 时它们是拒绝理由；返回对象时它们是软提示（管线残留）。调用方
 * 据返回值区分 —— 与 agent / hook 解析器的通道同形。
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { readShuvixMarker } from '@shuvix/chat-protocol/shuvixMdContract'
import { SHUVIX_ID_KEY } from '@shuvix/chat-protocol/mdMeta'
import { splitFrontmatter } from '../markdownFrontmatter'
import { readObjectIdField } from '../mdObjectId'
import { getTriggerPoint } from '../hook/triggerPoints'
import { compileWhen } from '../hook/when'

/** 文件类型标记 —— 写入 `shuvix: bot v2`；读取时不作要求（类型不符则拒绝） */
export const BOT_FILE_MARKER_KEY = 'shuvix'
export const BOT_FILE_MARKER = 'bot v2'
/** 标记的类型段（判别只看它 —— 版本升级不该让旧文件当场消失） */
export const BOT_FILE_MARKER_TYPE = 'bot'
/** v1 的管线绑定块键：读到只发软提示，不参与任何解析 */
export const BOT_RETIRED_PIPELINE_KEY = 'shuvix-bot-pipeline'
/** 触发绑定列表的键 */
export const BOT_ON_KEY = 'shuvix-bot-on'

/** 一条触发绑定：在哪个埋点、满足什么条件时，新建一条会话并对 bot 说这段话 */
export interface BotBinding {
  trigger: string
  /** CEL；缺省 = 每次都命中 */
  when?: string
  /** 发给 bot 的话（宿主在后面附上事件围栏） */
  message: string
  /**
   * 运行会话的工作位置：一个项目的名字（2026-10-30 用户：定时运行可以指定项目或临时）。缺省 = 临时工作区。
   * 按名字找没归档的项目（大小写不敏感），找不到或有不止一个同名项目时这一次不跑、记进触发日志
   */
  project?: string
}

/** 解析产物（basePath 由调用方补齐） */
export interface ParsedBotFile {
  /** 稳定标识 —— 会话的 `settings.bot` 存的就是它 */
  name: string
  /** `shuvix-id`：对象 id（已归一）；没写或写错 = 省略（不挂任何扩展元数据） */
  objectId?: string
  /** UI 显示名（缺省回退 name） */
  displayName: string
  /** 一句话介绍；可为空（纯展示，不参与任何判定） */
  description: string
  /** 正文：人设与记忆（已 trim；可为空 —— 新建出来就几乎是空的，由 bot 自己写） */
  body: string
  /** 触发绑定（`shuvix-bot-on`）；没写这个键 = 省略（读的一侧按空列表） */
  bindings?: BotBinding[]
}

function stringField(fields: Record<string, unknown>, key: string): string | undefined {
  const v = fields[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 解析 bot 定义 markdown。结构非法返回 null，原因经 `warn` 回报
 * （与 agent / hook / policy 解析器同形同策：整份拒绝，不静默降级）。
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

  // 标记：缺省放行（手写文件可以没有），写错了则拒绝 —— 一份 agent md 掉进 bots 目录
  // 会被当成人设读进系统提示词，那比报错糟得多
  const marker = readShuvixMarker(split.yaml)
  if (marker && marker.type !== BOT_FILE_MARKER_TYPE) {
    return reject(
      `'${BOT_FILE_MARKER_KEY}: ${marker.type}' is not a bot file — ` +
        `expected '${BOT_FILE_MARKER_KEY}: ${BOT_FILE_MARKER}'`
    )
  }

  const displayNameRaw = fields['shuvix-displayName'] ?? null
  if (displayNameRaw !== null && typeof displayNameRaw !== 'string') {
    return reject("'shuvix-displayName' must be a string")
  }
  const descriptionRaw = fields.description ?? null
  if (descriptionRaw !== null && typeof descriptionRaw !== 'string') {
    return reject("'description' must be a string")
  }

  // v1 残留：不拒绝（正文照用），但说一句 —— 那块看起来像配置，其实已经什么都不控制
  if (BOT_RETIRED_PIPELINE_KEY in fields) {
    warn?.(
      `bot '${name}': '${BOT_RETIRED_PIPELINE_KEY}' is no longer used — bots no longer run a pipeline, so this block does nothing; delete it`
    )
  }

  const declared = fields[BOT_ON_KEY] !== undefined && fields[BOT_ON_KEY] !== null
  const bindings = declared ? parseBindings(fields[BOT_ON_KEY], name, warn) : []
  if (typeof bindings === 'string') return reject(bindings)

  const objectId = readObjectIdField(fields, `bot '${name}'`, warn)
  return {
    name,
    ...(objectId ? { objectId } : {}),
    displayName: stringField(fields, 'shuvix-displayName') ?? name,
    description: stringField(fields, 'description') ?? '',
    body: split.body.trim(),
    ...(declared ? { bindings } : {})
  }
}

/** `shuvix-bot-on` → 绑定列表；结构非法 → 拒绝理由（字符串） */
function parseBindings(
  raw: unknown,
  name: string,
  warn?: (msg: string) => void
): BotBinding[] | string {
  // 写成空列表合法（暂时停掉所有触发的一种写法）；没写 / 写成 `~` 在调用方就按没有绑定处理了
  if (!Array.isArray(raw)) return `'${BOT_ON_KEY}' must be a list of bindings`
  const bindings: BotBinding[] = []
  for (const entry of raw) {
    if (!isMapping(entry)) return `'${BOT_ON_KEY}' entries must be mappings`
    const trigger = typeof entry.trigger === 'string' ? entry.trigger.trim() : ''
    if (!trigger) return `each '${BOT_ON_KEY}' entry needs a 'trigger' id`
    for (const k of Object.keys(entry)) {
      if (k !== 'trigger' && k !== 'when' && k !== 'message' && k !== 'project') {
        return `binding '${trigger}': unknown key '${k}' — a binding has only trigger, when, message and project`
      }
    }
    let when: string | undefined
    if (entry.when !== undefined && entry.when !== null) {
      if (typeof entry.when !== 'string' || !entry.when.trim()) {
        return `binding '${trigger}': 'when' must be a CEL expression string`
      }
      when = entry.when.trim()
      const celError = compileWhen(when)
      if (celError) return `binding '${trigger}': invalid when CEL — ${celError}`
    }
    if (typeof entry.message !== 'string' || !entry.message.trim()) {
      return `binding '${trigger}': 'message' must be the non-empty text sent to the bot`
    }
    let project: string | undefined
    if (entry.project !== undefined && entry.project !== null) {
      if (typeof entry.project !== 'string' || !entry.project.trim()) {
        return `binding '${trigger}': 'project' must be a project name (omit it to run in a temporary workspace)`
      }
      project = entry.project.trim()
    }
    const point = getTriggerPoint(trigger)
    if (!point) {
      warn?.(`bot '${name}': trigger '${trigger}' is not known on this build — binding is inert`)
    } else if (point.scope !== 'global') {
      return `binding '${trigger}': '${trigger}' happens inside a session — a bot binding opens a new session each time it fires, so it can bind only triggers that belong to no session (such as timer.fired)`
    }
    bindings.push({
      trigger,
      ...(when === undefined ? {} : { when }),
      message: entry.message.trim(),
      ...(project === undefined ? {} : { project })
    })
  }
  return bindings
}

/**
 * ⚠️ **序列化器只服务「新建 bot」**（与测试往返）。它从固定键白名单重建 frontmatter，会丢
 * 注释、键序与未知键。**已存在文件的日常维护由 bot 自己用 `edit` 工具就地改**、或用户在档案页
 * 原样保存，不经这里。
 */
export function serializeBotDefinitionFile(data: {
  name: string
  /** 对象 id；写在标记之后 */
  objectId?: string
  displayName?: string
  description?: string
  body?: string
}): string {
  const fields: Record<string, unknown> = {
    [BOT_FILE_MARKER_KEY]: BOT_FILE_MARKER
  }
  if (data.objectId) fields[SHUVIX_ID_KEY] = data.objectId
  fields.name = data.name
  if (data.description?.trim()) fields.description = data.description.trim()
  if (data.displayName?.trim() && data.displayName.trim() !== data.name) {
    fields['shuvix-displayName'] = data.displayName.trim()
  }
  const yaml = stringifyYaml(fields).trimEnd()
  const body = (data.body ?? '').trim()
  return `---\n${yaml}\n---\n\n${body}\n`
}
