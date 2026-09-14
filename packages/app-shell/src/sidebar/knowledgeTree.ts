/**
 * 知识库分组的树形派生 —— `KnowledgeEntry[]`（bundle 相对路径清单）→ 目录树。
 *
 * 纯函数、无 React，判定都在这里：顶层的项目容器 `projects/` 用固定文案（UI 按 `scopeDir`
 * 取 i18n），每个项目 bundle（`projects/<projectId>`）用绑定概念 `project.md` 的 title 当目录名
 * —— 目录名本身是 id，不给人看。
 * 只画存在的目录 —— 空作用域不占行（与 WikiGroup 同口径：清单来自文件，空文件夹只是噪声）。
 *
 * **绑定概念本身不占行**：它的 title 已经是上面那个目录行的名字，在目录正下方再画一行
 * `project` 毫无信息量，还白吃一级缩进。它仍然在磁盘上、仍然可经「打开文件夹」触达，只是
 * 不进侧栏清单。
 *
 * 层级是 组 → 容器 → 项目库 → 条目。缩进由 UI 侧给：**最外层容器不缩进**、每层 12px，
 * 所以条目落在 24px（改动前是 34px —— 那时还多一行绑定概念、且每行带 10px 基准）。
 *
 * 路径归一与 agent-runtime 的 normalizeBundlePath 同规则（反斜杠 → `/`、压缩重复分隔符、去
 * 前导 `./` 与 `/`、去尾随 `/`）；同一路径出现两次只取第一条（行 key 是路径）。
 */
import {
  KNOWLEDGE_PROJECTS_DIR,
  KNOWLEDGE_USER_ROOT_DIR,
  PROJECT_CONCEPT_FILE,
  type KnowledgeEntry
} from '@shuvix/chat-protocol/knowledge'

/** 固定文案的目录（本期只有一个：项目 bundle 的容器） */
export type KnowledgeScopeDir = 'projects'

export interface KnowledgeTreeFile {
  entry: KnowledgeEntry
  /** 行显示名：title，缺省回落文件名 stem */
  label: string
}

export interface KnowledgeTreeDir {
  /** bundle 相对目录路径（根为 ''） */
  path: string
  /** 末段目录名 */
  name: string
  /** 固定文案的目录；null = 按 title（绑定概念）/ name 显示 */
  scopeDir: KnowledgeScopeDir | null
  /** 绑定概念的 title（`projects/<id>/project.md`）；无则 null */
  title: string | null
  dirs: KnowledgeTreeDir[]
  files: KnowledgeTreeFile[]
}

const TOP_ORDER: readonly string[] = [KNOWLEDGE_PROJECTS_DIR]

/** 目录的固定文案键：目前只有顶层的项目容器 */
function scopeDirOf(dirPath: string): KnowledgeScopeDir | null {
  return dirPath === KNOWLEDGE_PROJECTS_DIR ? 'projects' : null
}

/** 绑定概念：`projects/<id>/project.md` —— 它给所在 bundle 命名，自己不占行 */
function isCharter(path: string): boolean {
  const segs = path.split('/')
  return segs.length === 3 && segs[0] === KNOWLEDGE_PROJECTS_DIR && segs[2] === PROJECT_CONCEPT_FILE
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
    const title = entry.title.trim()
    // 绑定概念只给目录命名，自己不进清单
    if (isCharter(path)) {
      if (title) dir.title = title
      continue
    }
    dir.files.push({ entry: { ...entry, path }, label: title || stemOf(path) })
  }

  const sortDir = (node: KnowledgeTreeDir, depth: number): void => {
    node.files.sort(
      (a, b) => compareLabel(a.label, b.label) || compareLabel(a.entry.path, b.entry.path)
    )
    node.dirs.sort((a, b) => {
      if (depth === 0) {
        const ia = TOP_ORDER.indexOf(a.path)
        const ib = TOP_ORDER.indexOf(b.path)
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
  // 用户库（条目 id `knowledge/<库名>/…`）**不包一层**：它们与 Projects 容器平级。树按条目 id 建，
  // 于是先长出一个 `knowledge` 节点 —— 把它的子目录提到根上、自己拿掉。置顶判据用 path 而不是
  // name：一个恰好叫 `projects` 的用户库（path `knowledge/projects`）不该被当成项目容器
  const userIdx = root.dirs.findIndex((d) => d.path === KNOWLEDGE_USER_ROOT_DIR)
  if (userIdx !== -1) {
    const [container] = root.dirs.splice(userIdx, 1)
    root.dirs.push(...container.dirs)
  }
  sortDir(root, 0)
  return root
}
