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
 * `warn` 承载两类话：返回 null 时它们是拒绝理由；返回对象时它们是软提示（管线残留）。调用方
 * 据返回值区分 —— 与 agent / workflow 解析器的通道同形。
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { readShuvixMarker } from '@shuvix/chat-protocol/shuvixMdContract'
import { splitFrontmatter } from '../markdownFrontmatter'

/** 文件类型标记 —— 写入 `shuvix: bot v2`；读取时不作要求（类型不符则拒绝） */
export const BOT_FILE_MARKER_KEY = 'shuvix'
export const BOT_FILE_MARKER = 'bot v2'
/** 标记的类型段（判别只看它 —— 版本升级不该让旧文件当场消失） */
export const BOT_FILE_MARKER_TYPE = 'bot'
/** v1 的管线绑定块键：读到只发软提示，不参与任何解析 */
export const BOT_RETIRED_PIPELINE_KEY = 'shuvix-bot-pipeline'

/** 解析产物（basePath 由调用方补齐） */
export interface ParsedBotFile {
  /** 稳定标识 —— 会话的 `settings.bot` 存的就是它 */
  name: string
  /** UI 显示名（缺省回退 name） */
  displayName: string
  /** 一句话介绍；可为空（纯展示，不参与任何判定） */
  description: string
  /** 正文：人设与记忆（已 trim；可为空 —— 新建出来就几乎是空的，由 bot 自己写） */
  body: string
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
 * （与 agent / workflow / policy 解析器同形同策：整份拒绝，不静默降级）。
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

  return {
    name,
    displayName: stringField(fields, 'shuvix-displayName') ?? name,
    description: stringField(fields, 'description') ?? '',
    body: split.body.trim()
  }
}

/**
 * ⚠️ **序列化器只服务「新建 bot」**（与测试往返）。它从固定键白名单重建 frontmatter，会丢
 * 注释、键序与未知键。**已存在文件的日常维护由 bot 自己用 `edit` 工具就地改**、或用户在档案页
 * 原样保存，不经这里。
 */
export function serializeBotDefinitionFile(data: {
  name: string
  displayName?: string
  description?: string
  body?: string
}): string {
  const fields: Record<string, unknown> = {
    [BOT_FILE_MARKER_KEY]: BOT_FILE_MARKER,
    name: data.name
  }
  if (data.description?.trim()) fields.description = data.description.trim()
  if (data.displayName?.trim() && data.displayName.trim() !== data.name) {
    fields['shuvix-displayName'] = data.displayName.trim()
  }
  const yaml = stringifyYaml(fields).trimEnd()
  const body = (data.body ?? '').trim()
  return `---\n${yaml}\n---\n\n${body}\n`
}
