/**
 * 知识库分组的树形派生 —— `KnowledgeEntry[]`（bundle 相对路径清单）→ 目录树。
 *
 * 纯函数、无 React，判定都在这里：**保留**作用域目录（global / projects / sessions / bots）与
 * 项目下的 `sessions` 用固定文案（UI 按 `scopeDir` 取 i18n），用户自建的顶层目录按目录名显示；
 * `projects/<slug>` / `bots/<name>` 用绑定概念（project.md / bot.md）的 title 当目录名
 * （目录名只是 slug），绑定概念置于所在目录首位；顶层按保留作用域固定序（全局 → 项目 →
 * 会话 → Bots）、其余按显示名排在它们之后。
 * 只画存在的目录 —— 空作用域不占行（与 WikiGroup 同口径：清单来自文件，空文件夹只是噪声）。
 *
 * 绑定概念的 title 给了目录之后，它自己那一行显示文件名 stem（`project` / `bot`）—— 目录行正下方
 * 再重复一遍同一个名字毫无信息量（同 WikiGroup 的 WIKI.md 章程行）。解析器把缺省 title 落成
 * 文件名 stem，所以 title 等于 stem 的绑定概念视同**没有**命名目录：目录回退显示 slug，而不是
 * 把每个没写 title 的项目都标成「project」。
 *
 * 路径归一与 agent-runtime 的 normalizeBundlePath 同规则（反斜杠 → `/`、压缩重复分隔符、去
 * 前导 `./` 与 `/`、去尾随 `/`）；同一路径出现两次只取第一条（行 key 是路径）。
 */
import {
  BOT_CONCEPT_FILE,
  KNOWLEDGE_DIRS,
  PROJECT_CONCEPT_FILE,
  type KnowledgeEntry
} from '@shuvix/chat-protocol/knowledge'

/** 固定文案的目录：顶层六个作用域目录，以及项目下的 `sessions` */
export type KnowledgeScopeDir = keyof typeof KNOWLEDGE_DIRS

export interface KnowledgeTreeFile {
  entry: KnowledgeEntry
  /** 绑定概念（project.md、bot.md）：置于所在目录首位、换图标 */
  charter: boolean
  /** 行显示名：一般为 title；命名了所在目录的绑定概念显示文件名 stem（见文件头） */
  label: string
}

export interface KnowledgeTreeDir {
  /** bundle 相对目录路径（根为 ''） */
  path: string
  /** 末段目录名 */
  name: string
  /** 固定文案的目录；null = 按 title（绑定概念）/ name 显示 */
  scopeDir: KnowledgeScopeDir | null
  /** 绑定概念的 title（`projects/<slug>/project.md`、`bots/<name>/bot.md`）；无则 null */
  title: string | null
  dirs: KnowledgeTreeDir[]
  files: KnowledgeTreeFile[]
}

const TOP_ORDER: readonly string[] = [
  KNOWLEDGE_DIRS.global,
  KNOWLEDGE_DIRS.projects,
  KNOWLEDGE_DIRS.sessions,
  KNOWLEDGE_DIRS.bots
]

const SCOPE_DIR_BY_NAME = new Map<string, KnowledgeScopeDir>(
  (Object.entries(KNOWLEDGE_DIRS) as Array<[KnowledgeScopeDir, string]>).map(([k, v]) => [v, k])
)

/** 目录的固定文案键：顶层作用域目录，或项目目录下的 `sessions` */
function scopeDirOf(dirPath: string): KnowledgeScopeDir | null {
  const segs = dirPath.split('/')
  if (segs.length === 1) return SCOPE_DIR_BY_NAME.get(segs[0]) ?? null
  if (
    segs.length === 3 &&
    segs[0] === KNOWLEDGE_DIRS.projects &&
    segs[2] === KNOWLEDGE_DIRS.sessions
  ) {
    return 'sessions'
  }
  return null
}

/** 绑定概念：`projects/<slug>/project.md`、`bots/<name>/bot.md` */
function isCharter(path: string): boolean {
  const segs = path.split('/')
  if (segs.length !== 3) return false
  return (
    (segs[0] === KNOWLEDGE_DIRS.projects && segs[2] === PROJECT_CONCEPT_FILE) ||
    (segs[0] === KNOWLEDGE_DIRS.bots && segs[2] === BOT_CONCEPT_FILE)
  )
}

const compareLabel = (a: string, b: string): number =>
  a.localeCompare(b, 'zh-CN', { sensitivity: 'base', numeric: true })

/** 与 agent-runtime normalizeBundlePath 同规则（app-shell 不引 agent-runtime，规则复述一遍） */
function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

/** 文件名 stem（无扩展名） */
function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name.replace(/\.(md|markdown|mdx)$/i, '')
}

/** 目录的显示名（固定文案的目录由 UI 另取 i18n，这里只用于排序） */
export function dirDisplayName(dir: KnowledgeTreeDir): string {
  return dir.title ?? dir.name
}

export function buildKnowledgeTree(entries: readonly KnowledgeEntry[]): KnowledgeTreeDir {
  const root: KnowledgeTreeDir = {
    path: '',
    name: '',
    scopeDir: null,
    title: null,
    dirs: [],
    files: []
  }
  const index = new Map<string, KnowledgeTreeDir>([['', root]])
  const ensureDir = (dirPath: string): KnowledgeTreeDir => {
    const hit = index.get(dirPath)
    if (hit) return hit
    const cut = dirPath.lastIndexOf('/')
    const parent = ensureDir(cut === -1 ? '' : dirPath.slice(0, cut))
    const node: KnowledgeTreeDir = {
      path: dirPath,
      name: cut === -1 ? dirPath : dirPath.slice(cut + 1),
      scopeDir: scopeDirOf(dirPath),
      title: null,
      dirs: [],
      files: []
    }
    parent.dirs.push(node)
    index.set(dirPath, node)
    return node
  }

  const seen = new Set<string>()
  for (const entry of entries) {
    const path = normalizePath(entry.path)
    if (!path || seen.has(path)) continue
    seen.add(path)
    const cut = path.lastIndexOf('/')
    const dir = ensureDir(cut === -1 ? '' : path.slice(0, cut))
    const charter = isCharter(path)
    const title = entry.title.trim()
    const stem = stemOf(path)
    // 绑定概念的 title 是目录的显示名（目录名只是 slug）；title 等于 stem 的是解析器
    // 缺省出来的，不算命名
    const namesDir = charter && !!title && title !== stem
    if (namesDir) dir.title = title
    dir.files.push({
      entry: { ...entry, path },
      charter,
      label: namesDir ? stem : title || stem
    })
  }

  const sortDir = (node: KnowledgeTreeDir, depth: number): void => {
    node.files.sort((a, b) =>
      a.charter !== b.charter
        ? a.charter
          ? -1
          : 1
        : compareLabel(a.label, b.label) || compareLabel(a.entry.path, b.entry.path)
    )
    node.dirs.sort((a, b) => {
      if (depth === 0) {
        const ia = TOP_ORDER.indexOf(a.name)
        const ib = TOP_ORDER.indexOf(b.name)
        if (ia !== ib) {
          if (ia === -1) return 1
          if (ib === -1) return -1
          return ia - ib
        }
      }
      return compareLabel(dirDisplayName(a), dirDisplayName(b)) || compareLabel(a.name, b.name)
    })
    for (const d of node.dirs) sortDir(d, depth + 1)
  }
  sortDir(root, 0)
  return root
}
