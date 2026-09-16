/**
 * 知识库分组的树形派生 —— `KnowledgeEntry[]`（bundle 相对路径清单）→ 目录树。
 *
 * 纯函数、无 React，判定都在这里：顶层的项目容器 `projects/` 用固定文案（UI 按 `scopeDir`
 * 取 i18n），每个项目库（`projects/<projectId>`）用宿主给的显示名（项目当前的名字）当目录名
 * —— 目录名本身是 id，不给人看；查不到名字（项目已删）才回落目录名。
 * 画哪些目录由清单说了算：有条目的目录自然长出来，**空目录靠宿主随清单下发的 `dirs`** 物化 ——
 * 手动新建的知识库与文件夹第一时间就是空的，不物化就什么都看不到。
 *
 * 层级是 组 → 容器 → 项目库 → 条目。缩进由 UI 侧给：**最外层容器不缩进**、每层 12px，
 * 所以条目落在 24px（改动前是 34px —— 那时每行还带 10px 基准）。
 *
 * 内置库（`builtin/<库名>/…`，随应用发布、只读）与用户库一样提到根上，但**置顶**、整棵子树标 `readonly`
 * —— 目录行据此不给新建菜单，UI 另给它一个身份图标。
 *
 * 路径归一与 agent-runtime 的 normalizeBundlePath 同规则（反斜杠 → `/`、压缩重复分隔符、去
 * 前导 `./` 与 `/`、去尾随 `/`）；同一路径出现两次只取第一条（行 key 是路径）。
 */
import {
  KNOWLEDGE_BUILTIN_DIR,
  KNOWLEDGE_PROJECTS_DIR,
  KNOWLEDGE_USER_ROOT_DIR,
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
  /** 固定文案的目录；null = 按 title（宿主给的显示名）/ name 显示 */
  scopeDir: KnowledgeScopeDir | null
  /** 宿主给的显示名（项目库：项目当前的名字）；无则 null，按目录名显示 */
  title: string | null
  /** 只读（随应用发布的内置库及其每一层）：没有新建菜单，排在最后 */
  readonly: boolean
  dirs: KnowledgeTreeDir[]
  files: KnowledgeTreeFile[]
}

const TOP_ORDER: readonly string[] = [KNOWLEDGE_PROJECTS_DIR]

/** 目录的固定文案键：目前只有顶层的项目容器 */
function scopeDirOf(dirPath: string): KnowledgeScopeDir | null {
  return dirPath === KNOWLEDGE_PROJECTS_DIR ? 'projects' : null
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

/** 宿主给的显示名：只认自有键（原型上的 `constructor` 之类不算），裁掉首尾空白，全空白等于没给 */
function hostName(names: Readonly<Record<string, string>>, dirPath: string): string | null {
  return Object.hasOwn(names, dirPath) ? names[dirPath].trim() || null : null
}

/**
 * `names`：bundle id → 显示名（宿主随清单下发；项目库的目录名是 id，靠它显示项目名）。
 * `dirs`：库与库内目录的 id —— 空目录只能从这里知道。
 */
export function buildKnowledgeTree(
  entries: readonly KnowledgeEntry[],
  names: Readonly<Record<string, string>> = {},
  dirs: readonly string[] = []
): KnowledgeTreeDir {
  const root: KnowledgeTreeDir = {
    path: '',
    name: '',
    scopeDir: null,
    title: null,
    readonly: false,
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
      title: hostName(names, dirPath),
      // 内置容器下的每一层都只读 —— 按 id 首段判，与宿主 isBuiltinKnowledgeId 同口径
      readonly:
        dirPath === KNOWLEDGE_BUILTIN_DIR || dirPath.startsWith(`${KNOWLEDGE_BUILTIN_DIR}/`),
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
    dir.files.push({ entry: { ...entry, path }, label: title || stemOf(path) })
  }

  // 空目录（新建出来的库 / 文件夹）在这里物化：它们没有任何条目，只在 dirs 里
  for (const dir of dirs) {
    const path = normalizePath(dir)
    if (path) ensureDir(path)
  }

  const sortDir = (node: KnowledgeTreeDir, depth: number): void => {
    node.files.sort(
      (a, b) => compareLabel(a.label, b.label) || compareLabel(a.entry.path, b.entry.path)
    )
    node.dirs.sort((a, b) => {
      if (depth === 0) {
        // 内置库置顶：ShuviX 自己的说明书是「不知道就先来这里查」的那一份，排在项目容器与用户库之前
        if (a.readonly !== b.readonly) return a.readonly ? -1 : 1
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
  // 内置库（`builtin/<库名>/…`）同样不包一层：一个内置库就是根上的一行（只读、排最后）
  for (const container of [KNOWLEDGE_USER_ROOT_DIR, KNOWLEDGE_BUILTIN_DIR]) {
    const idx = root.dirs.findIndex((d) => d.path === container)
    if (idx === -1) continue
    const [node] = root.dirs.splice(idx, 1)
    root.dirs.push(...node.dirs)
  }
  sortDir(root, 0)
  return root
}
