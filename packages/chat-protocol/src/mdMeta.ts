/**
 * md 扩展元数据的契约层 —— 设计见 docs/md-metadata-design.md。
 *
 * ShuviX 自定义的 md 定义文件（agent / bot / hook / policy）可以由数据库补上 md 没写的 frontmatter 键。
 * **元数据只认文件 frontmatter 里的 `shuvix-id`**：
 *   - 用户文件的 id 是一个 UUID（ShuviX 新建的文件一出生就带着，手写的文件由用户在 UI 里分配）；
 *   - 内置的 id 是 `<kind>:builtin:<name>`，直接写在随包发布的内置 md 里 —— 于是「只认 shuvix-id」没有例外，
 *     复制一份内置去覆盖时 id 跟着走，与复制任何文件一样共用同一套元数据；
 *   - 没有 id 就没有元数据：不按路径找、不按名字找、数据库也不预先分配；
 *   - 复制文件连同 `shuvix-id` 一起复制，副本与原件就是同一个对象 —— 这是有意的，不是冲突。
 *
 * 本模块是零依赖的纯函数：id 的形态判定、内置 id 的构造，以及「往 frontmatter 里写这一行」的文本操作
 * （主进程新建文件时用，渲染进程的属性卡往编辑器缓冲区里写时也用 —— 两边必须是同一种写法）。
 */

/** frontmatter 里的对象 id 键 */
export const SHUVIX_ID_KEY = 'shuvix-id'

/** 能挂元数据的文件类型 —— 与各自的 `shuvix: <type>` 标记同名 */
export const MD_OBJECT_KINDS = ['agent', 'bot', 'hook', 'policy'] as const
export type MdObjectKind = (typeof MD_OBJECT_KINDS)[number]

/** `md_attrs.ns`：fm = 补进 frontmatter 的键（md 优先，只补缺）；meta = 预留给宿主自己的键（启用开关等） */
export const MD_ATTR_NAMESPACES = ['fm', 'meta'] as const
export type MdAttrNamespace = (typeof MD_ATTR_NAMESPACES)[number]

/**
 * 各类文件能由数据库补的 frontmatter 键（`ns='fm'` 的白名单）。**md 优先，只补缺**：文件里写了的键
 * 永远以文件为准，补缺值只在文件没写（或写成空值）时生效，再交给这类文件自己的解析器校验。
 * 存储层不设限，放宽只改这里。第一期只开 agent 的模型与思考档位 —— 给内置 explore / coding / titler
 * 指定模型，不必复制一份覆盖文件、从此收不到内置正文的更新。hook / policy 的触发条件与安全语义
 * 应当留在文件里一眼可见；bot 只有身份加正文。
 * （键名写字面量：shuvixMdDescriptors 引本模块，反向引它会成环。）
 */
export const MD_FM_FILL_KEYS: Readonly<Record<MdObjectKind, readonly string[]>> = {
  agent: ['shuvix-model', 'shuvix-thinking'],
  bot: [],
  hook: [],
  policy: []
}

/** 这些键永远不可补：身份只来自文件本身 */
export const MD_IDENTITY_KEYS: readonly string[] = ['shuvix', 'name', SHUVIX_ID_KEY]

/**
 * 文件里「写了」这个键吗 —— 值是 null（`key:` 后面留空）或空白字符串与没写同义（解析器也把它们当作
 * 未声明），补缺值照样生效。合并（agent-runtime）与属性卡的「文件中已写」提示共用这一个判定。
 */
export function isDeclared(fields: Record<string, unknown>, key: string): boolean {
  const value = fields[key]
  if (value === undefined || value === null) return false
  return typeof value !== 'string' || value.trim() !== ''
}

/** `shuvix: <type>` 的类型段 → 能挂元数据的文件类型；别的类型（okf / memory / chart…）返回 null */
export function mdObjectKindOf(markerType: string): MdObjectKind | null {
  return (MD_OBJECT_KINDS as readonly string[]).includes(markerType)
    ? (markerType as MdObjectKind)
    : null
}

/**
 * 属性卡「ShuviX 设置」条的数据 —— 一份注册表笔记（按笔记本会话认，宿主不收渲染进程给的路径）
 * 的元数据视图。全部读自**磁盘上的文件**与数据库：编辑器里还没落盘的改动不在其中。
 */
export interface MdMetaNoteView {
  kind: MdObjectKind
  /** 磁盘上这份文件的对象 id（已归一）；没写或写错为 null */
  objectId: string | null
  idStatus: 'none' | 'malformed' | 'ok'
  /** 这类文件能补的键（MD_FM_FILL_KEYS） */
  fillKeys: string[]
  /** 已存的补缺值（只含 fillKeys 里的键；没有 id 时为空对象） */
  fill: Record<string, unknown>
  /** fillKeys 里文件已经写了的键 —— 这些键的补缺值不生效（md 优先） */
  declared: string[]
  /** 补缺值没能生效的原因（解析器不接受合并结果时）；空 = 没有这种问题 */
  warnings: string[]
  /** 文件只读（随包发布的内置）：写不进 id（不能自动分配、不能换新），补缺值照样能改（它存在数据库里） */
  readOnly: boolean
}

/** 写元数据的结果；失败不写任何东西 */
export type MdMetaWriteResult =
  | { success: true }
  | {
      success: false
      /**
       * not-registry-note：这条会话不是 agent / bot / hook / policy 文件的笔记本；
       * no-object-id：磁盘上的文件没有这个 id（还没落盘、或已被换掉）；
       * key-not-allowed：这类文件不能补这个键；invalid-value：解析器不接受这个值
       */
      reason: 'not-registry-note' | 'no-object-id' | 'key-not-allowed' | 'invalid-value'
      message?: string
    }

/** 一个合法 id 的两种形态（id 已归一：UUID 转小写） */
export type ParsedObjectId =
  | { id: string; form: 'uuid' }
  | { id: string; form: 'builtin'; kind: MdObjectKind; name: string }

/** 任意版本的 UUID（8-4-4-4-12 十六进制，大小写不敏感） —— 新建只写 v7，手写的 v4 照样认 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `<kind>:builtin:<name>`：kind 只认小写的四个；name 非空、首尾无空白、不跨行，余下部分整体是名字 */
const BUILTIN_RE = /^(agent|bot|hook|policy):builtin:(\S(?:[^\r\n]*\S)?)$/

/** 内置对象的 id —— 写进随包发布的内置 md，守护测试钉住它与文件的 kind / name 一致 */
export function builtinObjectId(kind: MdObjectKind, name: string): string {
  return `${kind}:builtin:${name}`
}

/**
 * 判定一个 frontmatter 值是不是合法的对象 id。不是字符串、空串、两种形态都不符 → null，
 * 调用方把它当作「没有 id」（写错的 id 不连累文件里的定义，解析器只发一条软提示）。
 * 首尾空白剥掉再判；UUID 归一为小写，内置形态原样（大小写敏感）。
 */
export function parseObjectId(value: unknown): ParsedObjectId | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (UUID_RE.test(text)) return { id: text.toLowerCase(), form: 'uuid' }
  const m = BUILTIN_RE.exec(text)
  if (m) return { id: text, form: 'builtin', kind: m[1] as MdObjectKind, name: m[2] }
  return null
}

/** 归一后的 id；不合法返回 null */
export function normalizeObjectId(value: unknown): string | null {
  return parseObjectId(value)?.id ?? null
}

/**
 * 值能否原样存进 `md_attrs.value`：YAML 1.2 core schema 解析得到的那棵树里，JSON 表达得了的部分
 * （null / 布尔 / 有限数字 / 字符串 / 数组 / 纯对象，任意深度）。`.nan` / `.inf` 与 undefined、
 * 函数、Date、`!!binary` 解出的 Buffer、`!!set` 解出的 Set、稀疏数组的洞都不行 —— JSON.stringify 会把它们
 * 悄悄变成 null、`{}` 或丢掉，存进去就不是原来的值了。唯一放过的近似是 `-0`（存成 0，数值相等）。
 */
export function isJsonValue(value: unknown): boolean {
  if (value === null) return true
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'object': {
      if (Array.isArray(value)) {
        // 逐下标而不是 every：every 跳过空位，而稀疏数组的洞存进去会变成 null
        for (let i = 0; i < value.length; i++) {
          if (!(i in value) || !isJsonValue(value[i])) return false
        }
        return true
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) return false
      return Object.values(value as Record<string, unknown>).every(isJsonValue)
    }
    default:
      return false
  }
}

/**
 * 文件开头的 frontmatter（与 agent-runtime 解析侧 markdownFrontmatter.ts 同一条正则：容忍 CRLF、
 * 空 frontmatter、结尾无换行）。内容组里的每一行都以换行结尾 —— 插入与替换按整行做的前提。
 */
const FRONTMATTER_RE = /^---\r?\n((?:[\s\S]*?\r?\n)??)---[ \t]*(?:\r?\n|$)/

/** 顶层的 `shuvix-id:` 行（不缩进；键可带引号 —— 漏认带引号的写法会插出重复键，YAML 整份解析失败） */
const ID_KEY_LINE_RE = /^(?:shuvix-id|"shuvix-id"|'shuvix-id')[ \t]*:/

/** 顶层的 `shuvix:` 类型标记行（`shuvix-xxx:` 不算 —— 冒号必须紧跟在 shuvix 与可选空白之后） */
const MARKER_LINE_RE = /^shuvix[ \t]*:/

/** 空行（含只有空白的行）与整行注释 —— 找「第一条内容行」时跳过它们 */
const BLANK_LINE_RE = /^[ \t]*\r?\n?$/
const COMMENT_LINE_RE = /^[ \t]*#/

/** 续行：缩进的行，或零缩进的序列项（`- a` / 单独一个 `-`）—— 都属于上面那个顶层键的值 */
const CONTINUATION_RE = /^(?:[ \t]|-(?:[ \t]|\r?\n?$))/

/**
 * 不加引号也能原样读回的值：先得是合法 id（UUID 或内置形态 —— 于是 `true` / `null` / `123` 这类在 YAML 里
 * 会读成别的类型的字符串永远走不到这里），再只含常规字符、且不以冒号结尾（行尾的冒号会被读成映射键）。
 * 其余一律双引号（JSON 字符串即合法 YAML）。
 */
const PLAIN_SCALAR_RE = /^[A-Za-z0-9](?:[A-Za-z0-9:._-]*[A-Za-z0-9._-])?$/

/**
 * 第 i 行开始的那个顶层条目占到哪一行为止（不含）：后面的续行，以及夹在续行之间的空行（块标量里可以有空行）
 * 都算它的；末尾的空行不算 —— 那是条目之间的分隔，原样留着。
 */
function entryEnd(lines: string[], i: number): number {
  let end = i + 1
  for (let j = i + 1; j < lines.length; j++) {
    if (BLANK_LINE_RE.test(lines[j])) continue
    if (!CONTINUATION_RE.test(lines[j])) break
    end = j + 1
  }
  return end
}

/**
 * 把 frontmatter 里的 `shuvix-id` 设为 `id`，**只改这一行文本**：不重新序列化 YAML，注释、键序、
 * 引号风格、换行符（LF / CRLF，取开头那条定界线的）与文件开头的 BOM / 空白原样保留。
 *   - 已有顶层 `shuvix-id` 条目（不论值是否合法）→ 换成一行，连同它的续行（块标量、序列之类）；
 *   - 否则插在 `shuvix:` 标记条目之后（标记写成块标量时插在它的续行之后）；没有标记就插在 frontmatter 第一行；
 *   - 返回 null = 这里没法安全地只改一行：文件开头没有 frontmatter，或者 frontmatter 不是顶格的块映射
 *     （整块 flow 写法 `{name: x}`、整体缩进、顶层是序列）。
 * 极端写法（id 的值带锚点、别处又引用了它）改完会解析失败 —— 调用方写盘前要用解析器复核（ensureObjectId 就这么做）。
 */
export function setShuvixIdLine(text: string, id: string): string | null {
  // 与解析侧一致：剥掉 BOM 与前导空白之后才找 frontmatter（JS 正则的 \s 含 U+FEFF）—— 但它们原样留在输出里
  const lead = /^\s*/.exec(text)![0]
  const rest = text.slice(lead.length)
  const m = FRONTMATTER_RE.exec(rest)
  if (!m) return null

  const openLen = rest.startsWith('---\r\n') ? 5 : 4
  const eol = openLen === 5 ? '\r\n' : '\n'
  const yaml = m[1]
  const lines = yaml === '' ? [] : yaml.split(/(?<=\n)/)

  const firstContent = lines.find(
    (line) => !BLANK_LINE_RE.test(line) && !COMMENT_LINE_RE.test(line)
  )
  if (firstContent !== undefined && /^(?:[ \t{[]|-(?:[ \t]|\r?\n?$))/.test(firstContent)) {
    return null
  }

  const value = parseObjectId(id) !== null && PLAIN_SCALAR_RE.test(id) ? id : JSON.stringify(id)
  const idLine = `${SHUVIX_ID_KEY}: ${value}${eol}`

  const existing = lines.findIndex((line) => ID_KEY_LINE_RE.test(line))
  if (existing >= 0) {
    lines.splice(existing, entryEnd(lines, existing) - existing, idLine)
  } else {
    const marker = lines.findIndex((line) => MARKER_LINE_RE.test(line))
    lines.splice(marker >= 0 ? entryEnd(lines, marker) : 0, 0, idLine)
  }

  return lead + rest.slice(0, openLen) + lines.join('') + rest.slice(openLen + yaml.length)
}
