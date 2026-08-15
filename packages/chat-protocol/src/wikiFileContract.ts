/**
 * Wiki 契约文件（`shuvix: wiki-entry v1` / `shuvix: wiki-topic v1`）—— Wiki Curator
 * 维护的知识库文件的机器可读契约。
 *
 * 形态：YAML frontmatter（与 agent 定义文件、图表契约同形）+ 正文。关键在于**所有权切在
 * frontmatter 边界上**：
 *
 *   ---
 *   shuvix: wiki-entry v1
 *   name: 会话令牌校验
 *   description: MANAGED BY WIKI CURATOR. ...
 *   shuvix-wiki-content: |-
 *     <条目正文 —— 恰好一段话，由 agent 撰写与维护>
 *   shuvix-wiki-status: draft
 *   ---
 *
 *   <frontmatter 之下全部是用户自己的笔记，agent 读但永不改写>
 *
 * 设计取舍：
 *   - **条目正文放 frontmatter** —— 条目是原子单位（一段话即足以理解），把它放进
 *     `shuvix-wiki-content` 之后，「agent 拥有的内容」与「用户拥有的笔记」之间的边界
 *     就是 frontmatter 边界：已有解析器、不可能误越、`write` 覆盖之外没有别的越界方式。
 *     代价是通用 markdown 渲染器把条目正文显示成元数据行，故 ShuviX 自己的预览必须
 *     经本模块解析后渲染（这也是本模块存在的理由）。
 *   - 元数据词汇表与 agent md 一致：`shuvix` 类型标记 + 通用键 `name`/`description`，
 *     wiki 专属字段一律带 `shuvix-wiki-` 前缀（同 chart 的 `shuvix-chart-requirement`）。
 *   - **文件名是稳定 id，`name` 是显示名** —— 重命名只改 frontmatter，文件不动：git
 *     历史连续，`[[链接]]` 不断。链接目标始终是文件名/路径（与 Obsidian/GitHub 一致），
 *     可读性交给别名语法 `[[id|显示名]]`。
 *   - **宽容读取**（与 agent md 的严格拒绝相反）—— wiki 条目首先是用户要读的文档，
 *     解析失败不能让它从视图里消失：无标记 → 普通 markdown；字段缺失/异常 → 取缺省，
 *     调用方永远有兜底显示。
 *   - 不引 YAML 解析器 —— chat-protocol 是零依赖叶子包。本模块只按**规范形态**取值
 *     （agent 恒按此形态写出），非规范形态返回 null 由调用方降级；需要完整保真解析
 *     （sources 列表等）时，在有 `yaml` 依赖的 agent-runtime 侧另做。
 *
 * 消费方：wiki 内置提示词（md/wiki*.md 的条目模板与横幅逐字引用本模块常量，守护测试钉住）、
 * 以及 ShuviX 侧栏/预览的条目渲染 —— 单一真源，提示词与 UI 不漂移。
 */

/**
 * 文件类型标记的 frontmatter key 与两个取值 —— `shuvix: wiki-entry v1` / `shuvix: wiki-topic v1`
 * （与 `shuvix: agent v1`、`shuvix: chart v1` 同形；判别本身版本无关，为未来演进留位）。
 * 写入时恒输出，读取时不作要求。
 */
export const WIKI_FILE_MARKER_KEY = 'shuvix'
export const WIKI_ENTRY_MARKER = 'wiki-entry v1'
export const WIKI_TOPIC_MARKER = 'wiki-topic v1'

/**
 * 条目管理横幅 —— 写在 frontmatter 的 `description` 字段：读到原始文件的 Agent/人类
 * 都会看到所有权切在哪。它必须同时说清两件事，因为这份文件是两个主体共有的。
 */
export const WIKI_ENTRY_BANNER =
  'MANAGED BY WIKI CURATOR. This frontmatter is the entry itself — generated and maintained by the wiki agent; change it via the Agent tool with agent "wiki-writer", not by hand. Everything below the frontmatter is your own notes: the agent reads them but never edits them.'

/** 主题章程横幅 —— 章程整份由 agent 维护，故措辞比条目横幅简单 */
export const WIKI_TOPIC_BANNER =
  'MANAGED BY WIKI CURATOR. This charter is maintained by the wiki agent — change it via the Agent tool with agent "wiki-writer", not by hand.'

/** 条目生命周期状态（缺失/非法一律按 `draft` 处理） */
export const WIKI_ENTRY_STATUSES = ['draft', 'reviewed', 'stable'] as const
export type WikiEntryStatus = (typeof WIKI_ENTRY_STATUSES)[number]

/** 条目页面类型（可选字段；主题章程可用 `shuvix-wiki-allowed-types` 收窄本主题的取值） */
export const WIKI_ENTRY_TYPES = ['concept', 'entity', 'decision', 'guide'] as const
export type WikiEntryType = (typeof WIKI_ENTRY_TYPES)[number]

/** wiki 专属字段名 —— 提示词与解析共用，避免两处各写一份字符串 */
export const WIKI_CONTENT_KEY = 'shuvix-wiki-content'
export const WIKI_STATUS_KEY = 'shuvix-wiki-status'
export const WIKI_ENTRY_TYPE_KEY = 'shuvix-wiki-entry-type'
export const WIKI_UPDATED_KEY = 'shuvix-wiki-updated'
export const WIKI_SOURCES_KEY = 'shuvix-wiki-sources'
export const WIKI_ALLOWED_TYPES_KEY = 'shuvix-wiki-allowed-types'

/** 文件开头的 frontmatter 块（不带 m 标志：`^` 即字符串起始，故只认文件开头） */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** frontmatter 内的类型标记行（容忍缩进、引号与种类之后的版本号） */
const ENTRY_MARKER_RE = /^[ \t]*shuvix[ \t]*:[ \t]*['"]?wiki-entry\b/m
const TOPIC_MARKER_RE = /^[ \t]*shuvix[ \t]*:[ \t]*['"]?wiki-topic\b/m

/** 剥 BOM 与前导空白 —— frontmatter 必须落在文件开头 */
function head(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/^\s+/, '')
}

function frontmatterOf(text: string): string | null {
  const m = FRONTMATTER_RE.exec(head(text))
  return m ? m[1] : null
}

/** 该文本是否为 wiki 条目文件 */
export function isWikiEntryFile(text: string): boolean {
  const fm = frontmatterOf(text)
  return fm !== null && ENTRY_MARKER_RE.test(fm)
}

/** 该文本是否为 wiki 主题章程（`WIKI.md`） */
export function isWikiTopicFile(text: string): boolean {
  const fm = frontmatterOf(text)
  return fm !== null && TOPIC_MARKER_RE.test(fm)
}

/** 条目的可展示头部：`name` 与条目正文。取不到的字段为 null,调用方各自兜底 */
export interface WikiEntryHead {
  /** `name` 字段;省略时为 null —— 调用方回退到文件名 stem(同 agent md 的 defaultName 策略) */
  name: string | null
  /** `shuvix-wiki-content` 的正文;非规范形态取不到时为 null —— 调用方降级为原文显示 */
  content: string | null
}

/** 顶层 `name:` 标量（锚在行首零缩进：正文块内的同名行有缩进，不会被误取） */
const NAME_LINE_RE = /^name[ \t]*:[ \t]*(.*)$/m

/** 剥单/双引号包裹（不做转义还原 —— 规范形态不带转义，带了就走 null 降级） */
function unquote(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && ((v[0] === "'" && v.endsWith("'")) || (v[0] === '"' && v.endsWith('"')))) {
    return v.slice(1, -1).trim()
  }
  return v
}

/**
 * 取块标量正文：`key: |-` / `|` / `>-` 之后按 YAML 缩进块收集，首个非空且缩进不足的行终止。
 * 命中返回去缩进后的文本（`>` 折叠为空格、空行为段落分隔），未命中返回 null。
 */
function blockScalar(lines: string[], startIndex: number, folded: boolean): string | null {
  const body: string[] = []
  let indent = -1
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '')
    if (line.trim() === '') {
      body.push('')
      continue
    }
    const lead = line.length - line.trimStart().length
    if (indent === -1) {
      if (lead === 0) break // 紧跟着的就是下一个 key —— 空块
      indent = lead
    } else if (lead < indent) {
      break
    }
    body.push(line.slice(indent))
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop()
  if (body.length === 0) return null
  if (!folded) return body.join('\n')
  // 折叠标量：一段内的行以空格相接，空行是段落分隔（折叠后为单个换行）
  const paragraphs: string[][] = [[]]
  for (const line of body) {
    if (line === '') paragraphs.push([])
    else paragraphs[paragraphs.length - 1].push(line)
  }
  return paragraphs
    .filter((p) => p.length > 0)
    .map((p) => p.join(' '))
    .join('\n')
}

/**
 * 解析条目头部（`name` + 条目正文）。非条目文件返回 null —— 调用方以此降级回普通
 * markdown 渲染（永远有兜底显示）。
 *
 * 只认规范形态：`name` 为单行标量，`shuvix-wiki-content` 为块标量（`|-` 规范，`|`/`>` 亦可）
 * 或单行纯标量。带 YAML 转义的双引号长串、锚点/别名等一律取不到值（content 为 null），
 * 这是刻意的：与其在零依赖包里复刻半个 YAML 解析器，不如让调用方显示原文。
 */
export function parseWikiEntryHead(text: string): WikiEntryHead | null {
  const fm = frontmatterOf(text)
  if (fm === null || !ENTRY_MARKER_RE.test(fm)) return null

  const nameMatch = NAME_LINE_RE.exec(fm)
  const name = nameMatch ? unquote(nameMatch[1]) || null : null

  let content: string | null = null
  const lines = fm.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^shuvix-wiki-content[ \t]*:[ \t]*(.*)$/.exec(lines[i].replace(/\r$/, ''))
    if (!m) continue
    const rest = m[1].trim()
    const block = /^([|>])[+-]?$/.exec(rest)
    content = block ? blockScalar(lines, i + 1, block[1] === '>') : unquote(rest) || null
    break
  }

  return { name, content }
}
