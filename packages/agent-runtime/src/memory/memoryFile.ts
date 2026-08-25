/**
 * 项目记忆文件（`<slug>.md`）解析 —— `shuvix: memory v1` 契约。
 *
 * 与 agent md / policy md 同形：YAML frontmatter + 正文，`shuvix-` 前缀承载自有字段，
 * 首行文件类型标记写时恒有、读时可选。差异只在**两个描述字段是分开的**：
 *   - `description` 给人看（设置页列表），回答「这条记了什么」；
 *   - `shuvix-memory-recall` 给模型看，回答「什么时候值得展开」，且**只有它进索引**。
 * 索引是每个会话必付的常驻成本，它的每个字节都该花在召回判断上；内容摘要与召回条件
 * 是两个读者的两件事，合成一个字段必然有一头是凑合。
 *
 * 暂不分类：记忆一律按「写下当时的观察」对待，时效由 `shuvix-memory-updated` 承担，
 * 核实要求写在注入表头。类别字段在只有一个合法取值时不携带任何信息，却多一条把整份
 * 文件判非法的路径；将来真要分类，加一个 `shuvix-memory-type` 键即可（未知键本就忽略）。
 * 时效信息放 frontmatter 而不是交给读取工具附带 —— agent 可以 `cat` 绕过任何专用读路径，
 * 绑在工具边界上的声明一定会被另一条路径绕掉。
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { splitFrontmatter } from '../markdownFrontmatter'

export const MEMORY_FILE_MARKER_KEY = 'shuvix'
export const MEMORY_FILE_MARKER = 'memory v1'

export interface ParsedMemoryFile {
  /** slug，= 文件名 = `[[链接]]` 锚点 */
  name: string
  /** 给人看的一句话摘要；不进注入 */
  description: string
  /** `shuvix-memory-recall`：什么时候该展开它 —— 唯一进索引的描述字段 */
  recall: string
  /** `shuvix-memory-pinned`：正文常驻系统提示词，不靠模型自己决定展开；缺省 false */
  pinned: boolean
  /** `shuvix-memory-session`：写下它的会话 id（溯源，可缺） */
  session?: string
  /** `shuvix-memory-updated`：最后更新日期（YYYY-MM-DD，可缺） */
  updated?: string
  /** 正文 = 记忆本体 */
  body: string
}

function stringField(fields: Record<string, unknown>, key: string): string | undefined {
  const v = fields[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/**
 * 解析记忆 markdown。格式非法（无 frontmatter / YAML 语法错 / 字段类型不符 / 正文为空）
 * 返回 null，由扫描方记日志跳过。`defaultName` 为文件 basename。
 * `warn` 是诊断出口，同 parseAgentDefinitionFile / policyFile 的形与策。
 */
export function parseMemoryFile(
  raw: string,
  defaultName: string,
  warn?: (msg: string) => void
): ParsedMemoryFile | null {
  const rejectAs = (who: string, why: string): null => {
    warn?.(`memory '${who}': ${why}; the whole file is rejected`)
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
      return rejectAs(defaultName, 'frontmatter is not a key/value mapping')
    }
  } catch (e) {
    return rejectAs(defaultName, `invalid YAML frontmatter (${(e as Error).message})`)
  }

  const name = stringField(fields, 'name') ?? defaultName
  const reject = (why: string): null => rejectAs(name, why)

  for (const key of [
    'description',
    'shuvix-memory-recall',
    'shuvix-memory-session',
    'shuvix-memory-updated'
  ] as const) {
    const v = fields[key] ?? null
    if (v !== null && typeof v !== 'string') return reject(`'${key}' must be a string`)
  }
  const pinnedRaw = fields['shuvix-memory-pinned'] ?? null
  if (pinnedRaw !== null && typeof pinnedRaw !== 'boolean') {
    return reject("'shuvix-memory-pinned' must be a boolean (true / false)")
  }

  const body = split.body.trim()
  if (!body) return reject('the body is empty — a memory with no content records nothing')

  return {
    name,
    description: stringField(fields, 'description') ?? '',
    recall: stringField(fields, 'shuvix-memory-recall') ?? '',
    pinned: pinnedRaw ?? false,
    session: stringField(fields, 'shuvix-memory-session'),
    updated: stringField(fields, 'shuvix-memory-updated'),
    body
  }
}

/** 序列化为标准格式（GUI 保存路径）。与 parseMemoryFile 互逆，空值字段省略、标记居首。 */
export function serializeMemoryFile(data: ParsedMemoryFile): string {
  const fields: Record<string, string | boolean> = {
    [MEMORY_FILE_MARKER_KEY]: MEMORY_FILE_MARKER,
    name: data.name
  }
  if (data.description.trim()) fields.description = data.description.trim()
  if (data.recall.trim()) fields['shuvix-memory-recall'] = data.recall.trim()
  if (data.pinned) fields['shuvix-memory-pinned'] = true
  if (data.session?.trim()) fields['shuvix-memory-session'] = data.session.trim()
  if (data.updated?.trim()) fields['shuvix-memory-updated'] = data.updated.trim()

  const frontmatter = stringifyYaml(fields, { lineWidth: 0 }).trimEnd()
  const body = data.body.trim()
  return `---\n${frontmatter}\n---\n${body ? `\n${body}\n` : ''}`
}
