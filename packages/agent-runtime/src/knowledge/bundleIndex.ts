/**
 * 库的目录索引（`index.md`）与它的两个读者 —— 宿主无关的纯函数。
 *
 * **为什么又开始写 index.md（2026-11-19）**：知识库管理员会按主题把条目分进文件夹，但文件夹本身没有地方写
 * 「这里放什么、什么时候该进来看」。OKF 给文件夹描述留的唯一位置是**父目录 `index.md` 里的那一行**
 * （`* [auth](auth/) - 描述`，SPEC §8），所以描述就存在那里：index.md 的条目行由宿主按 frontmatter 现生成，
 * 文件夹行的描述是唯一「存」在里面的东西 —— 重新生成时原样带过去。管理员不直接改 index.md：它在结果里报
 * `folders`，宿主写（与 `verified` 同一条纪律：模型只回答，落盘是宿主的事）。
 *
 * 两个读者：
 *   - {@link renderBundleIndexes}：每个放着笔记的目录一份 index.md 的全文（宿主比对后落盘、随同一批变更提交）；
 *   - {@link buildKnowledgeOutline}：库**顶层**的简讯（文件夹 + 条目各一行），追加进 `<knowledge_bases>` 围栏
 *     （knowledgeGuide.ts）。只给项目库与 bot 库。
 *
 * 生成的 index.md 必须合 validate.ts `isProjectionText` 的行形状（`## 节` / `* [标题](路径) - 描述`）：
 * 那是扫描把它认作「宿主生成的、不是笔记」的唯一依据。
 *
 * 描述会进系统提示词，而它出自管理员对提交内容的转述（提交内容可能来自网页）：一律压成单行、去掉尖括号
 * （冒充不了围栏）、限长。
 */
import type { KnowledgeNote } from './conceptFile'
import type { BundleFile } from './validate'

/** 文件夹描述的上限（字符）：一行「放什么、什么时候看」 */
export const KNOWLEDGE_FOLDER_DESCRIPTION_MAX = 160
/** 简讯里一条条目描述的上限 */
export const KNOWLEDGE_OUTLINE_DESCRIPTION_MAX = 140
/** 简讯最多列多少行（文件夹在前）；多的只报个数 */
export const KNOWLEDGE_OUTLINE_MAX_LINES = 30

const INDEX_FILE = 'index.md'
/** 新建的根 index 的 frontmatter（已有的原样保留 —— OKF：重新生成时必须留着库的元数据） */
const DEFAULT_ROOT_FRONTMATTER = '---\nokf_version: "0.2"\n---\n'

/** 控制字符与行分隔符（码点写成转义，源码里不留不可见字符） */
// eslint-disable-next-line no-control-regex -- 要去掉的正是控制字符
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]+', 'g')

/** 进 index.md / 系统提示词的一行文字：单行、无尖括号、限长 */
export function cleanIndexLine(raw: string, max: number): string {
  const line = raw.replace(/[<>]/g, '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
  const chars = [...line]
  return chars.length <= max
    ? line
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
}

/** 库内路径的归一：反斜杠转正、去两头的 `/` */
function folderPath(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut)
}

/** 按码元排：与系统语言无关 —— 同一个库在哪台机器上生成的索引都一字不差 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function nameOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? path : path.slice(cut + 1)
}

/** 链接目标：只转会把 `[..](..)` 或 URI 引用弄坏的那几个字符（中文原样留着，人还要读） */
function linkTarget(name: string): string {
  return name.replace(/[%\s()]/g, (ch) => encodeURIComponent(ch).replace(/[()]/g, escapeParen))
}

function escapeParen(ch: string): string {
  return ch === '(' ? '%28' : '%29'
}

function linkText(text: string): string {
  return text.replace(/[[\]\\]/g, (ch) => `\\${ch}`)
}

/** `* [x](name/) - 描述` —— 一条文件夹行 */
const FOLDER_LINE = /^\*\s+\[(?:\\.|[^\]])*\]\(([^()]+)\/\)(?:\s+-\s+(.*))?$/

/**
 * 从一份 index.md 里读出它列的文件夹的描述（子目录名 → 描述；没写描述的不在其中）。
 * 只认直接子目录（`name/`）。
 */
export function readFolderDescriptions(indexText: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of indexText.split(/\r?\n/)) {
    const hit = FOLDER_LINE.exec(line.trim())
    if (!hit || !hit[2]) continue
    let name: string
    try {
      name = decodeURIComponent(hit[1])
    } catch {
      name = hit[1]
    }
    if (!name || name.includes('/')) continue
    const description = cleanIndexLine(hit[2], KNOWLEDGE_FOLDER_DESCRIPTION_MAX)
    if (description) out.set(name, description)
  }
  return out
}

/**
 * 全库的文件夹描述（库内路径 → 描述）：每份宿主生成的 index.md 各管它的直接子目录。
 * `indexes` 只该给宿主生成的那些（用户手写的同名笔记不是索引）。
 */
export function collectFolderDescriptions(indexes: readonly BundleFile[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const file of indexes) {
    const dir = parentOf(folderPath(file.path))
    for (const [name, description] of readFolderDescriptions(file.text)) {
      out.set(dir ? `${dir}/${name}` : name, description)
    }
  }
  return out
}

/** 放着笔记的目录（直接放着，或子目录里放着）；顶层是空串 */
export function foldersWithNotes(notes: readonly Pick<KnowledgeNote, 'path'>[]): Set<string> {
  const out = new Set<string>()
  for (const note of notes) {
    let dir = parentOf(folderPath(note.path))
    out.add(dir)
    while (dir) {
      dir = parentOf(dir)
      out.add(dir)
    }
  }
  return out
}

/** 放着笔记、却还没有描述的文件夹（库内路径，字典序；顶层不算 —— 它的描述是库自己的事） */
export function undescribedFolders(
  notes: readonly Pick<KnowledgeNote, 'path'>[],
  descriptions: ReadonlyMap<string, string>
): string[] {
  return [...foldersWithNotes(notes)].filter((dir) => dir && !descriptions.has(dir)).sort()
}

type IndexNote = Pick<KnowledgeNote, 'path' | 'title' | 'description'>

function frontmatterBlock(text: string): string | null {
  const hit = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  return hit
    ? hit[0]
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n')
        .replace(/\n?$/, '\n')
    : null
}

/**
 * 每个放着笔记的目录一份 index.md（目录的库内路径 → 全文；顶层是空串）。文件夹在前、条目在后，各按名字排。
 * `descriptions` 是文件夹描述（库内路径 → 描述）；`rootIndex` 是现有的根 index 原文 —— 它的 frontmatter 原样保留。
 */
export function renderBundleIndexes(
  notes: readonly IndexNote[],
  opts: { descriptions?: ReadonlyMap<string, string>; rootIndex?: string } = {}
): Map<string, string> {
  const dirs = foldersWithNotes(notes)
  const out = new Map<string, string>()
  for (const dir of dirs) {
    const folders = [...dirs].filter((d) => d && parentOf(d) === dir).sort()
    const entries = notes
      .map((n) => ({ ...n, path: folderPath(n.path) }))
      .filter((n) => parentOf(n.path) === dir)
      .sort((a, b) => byCodeUnit(a.path, b.path))
    const lines: string[] = []
    if (folders.length > 0) {
      lines.push('## Folders', '')
      for (const folder of folders) {
        const name = nameOf(folder)
        const description = cleanIndexLine(
          opts.descriptions?.get(folder) ?? '',
          KNOWLEDGE_FOLDER_DESCRIPTION_MAX
        )
        lines.push(
          `* [${linkText(name)}](${linkTarget(name)}/)${description ? ` - ${description}` : ''}`
        )
      }
      lines.push('')
    }
    if (entries.length > 0) {
      lines.push('## Entries', '')
      for (const entry of entries) {
        const name = nameOf(entry.path)
        const title = cleanIndexLine(entry.title, 120) || name
        const description = cleanIndexLine(entry.description, 240)
        lines.push(
          `* [${linkText(title)}](${linkTarget(name)})${description ? ` - ${description}` : ''}`
        )
      }
      lines.push('')
    }
    const body = lines.join('\n').replace(/\n+$/, '\n')
    if (dir === '') {
      const frontmatter =
        (opts.rootIndex ? frontmatterBlock(opts.rootIndex) : null) ?? DEFAULT_ROOT_FRONTMATTER
      out.set(dir, `${frontmatter}\n${body}`)
    } else {
      out.set(dir, body)
    }
  }
  return out
}

/** 目录的库内路径 → 它那份 index.md 的库内路径 */
export function indexPathOf(dir: string): string {
  return dir ? `${dir}/${INDEX_FILE}` : INDEX_FILE
}

// ─────────────────────────── 简讯 ───────────────────────────

/** 简讯里的一个顶层文件夹 */
export interface KnowledgeOutlineFolder {
  /** 文件夹名（顶层，不带 `/`） */
  name: string
  /** 它底下（含子文件夹）现行的条目数 */
  entries: number
  /** 管理员写的那一行；还没有就是空串 */
  description: string
}

/** 简讯里的一条顶层条目 */
export interface KnowledgeOutlineEntry {
  /** 条目名（库内路径，传给 `read` 的 `entry`） */
  name: string
  /** frontmatter 的 description；没有就用标题（与文件名说的是一回事时为空串） */
  description: string
}

/** 一个库顶层的简讯 */
export interface KnowledgeOutline {
  folders: KnowledgeOutlineFolder[]
  entries: KnowledgeOutlineEntry[]
  /** 顶层没列出来的行数（超过上限时） */
  more: number
}

/**
 * 库顶层的简讯：顶层文件夹（带条目数与描述）在前，顶层条目在后。`deprecated` 的条目不算也不列 —— 那是留给链接与
 * 历史的。库是空的返回 null。
 */
export function buildKnowledgeOutline(
  notes: readonly Pick<KnowledgeNote, 'path' | 'title' | 'description' | 'status'>[],
  descriptions: ReadonlyMap<string, string>,
  maxLines = KNOWLEDGE_OUTLINE_MAX_LINES
): KnowledgeOutline | null {
  const current = notes
    .filter((n) => n.status !== 'deprecated')
    .map((n) => ({ ...n, path: folderPath(n.path) }))
  if (current.length === 0) return null

  const counts = new Map<string, number>()
  const top: typeof current = []
  for (const note of current) {
    const cut = note.path.indexOf('/')
    if (cut < 0) top.push(note)
    else counts.set(note.path.slice(0, cut), (counts.get(note.path.slice(0, cut)) ?? 0) + 1)
  }
  const folders: KnowledgeOutlineFolder[] = [...counts]
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([name, entries]) => ({
      name: cleanIndexLine(name, 80),
      entries,
      description: cleanIndexLine(descriptions.get(name) ?? '', KNOWLEDGE_FOLDER_DESCRIPTION_MAX)
    }))
  const entries: KnowledgeOutlineEntry[] = top
    .sort((a, b) => byCodeUnit(a.path, b.path))
    .map((note) => {
      const title = cleanIndexLine(note.title, KNOWLEDGE_OUTLINE_DESCRIPTION_MAX)
      const stem = note.path.replace(/\.md$/i, '')
      return {
        name: cleanIndexLine(note.path, 200),
        description:
          cleanIndexLine(note.description, KNOWLEDGE_OUTLINE_DESCRIPTION_MAX) ||
          (title.toLowerCase() === stem.toLowerCase() ? '' : title)
      }
    })

  const keptFolders = folders.slice(0, maxLines)
  const keptEntries = entries.slice(0, Math.max(0, maxLines - keptFolders.length))
  return {
    folders: keptFolders,
    entries: keptEntries,
    more: folders.length + entries.length - keptFolders.length - keptEntries.length
  }
}
