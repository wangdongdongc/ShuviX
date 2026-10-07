/**
 * 其他应用的沙盒容器 —— `~/Library/Containers/` 与 `~/Library/Group Containers/`。
 *
 * macOS 对「读别的应用容器里的数据」弹系统授权框（“ShuviX” would like to access data from other
 * apps；Sonoma 起管 Containers，Sequoia 起连 Group Containers 一起管）。弹框期间那次读一直挂着 ——
 * 同步读就是整个主进程挂着。后台的枚举 / 扫描（ssh 配置的别名枚举、文件面板的列表、ripgrep 类工具
 * 从家目录往下扫）都不是用户在那一刻要读别的应用的数据，所以它们**不进**这两个目录。
 *
 * 判定按路径段比（`Library/ContainersBackup` 不算），在大小写不敏感的文件系统（macOS / Windows
 * 缺省）上按折叠后的形式比。家目录取 `os.homedir()`，外加它的真实路径（被比较的一侧可能是 realpath
 * 的结果）。只有元数据操作（realpath）会碰到一条尚未排除的路径；读内容（open / readdir）之前一定先排除。
 */
import { homedir } from 'os'
import { realpath } from 'fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'path'

const CONTAINER_DIRS: ReadonlyArray<readonly string[]> = [
  ['Library', 'Containers'],
  ['Library', 'Group Containers']
]

const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32'

const norm = (p: string): string => {
  const r = resolve(p)
  return FOLD_CASE ? r.toLowerCase() : r
}

/** `p` 是否在 `root` 之内（含 root 本身）—— 按路径段，不是字符串前缀 */
function isWithin(p: string, root: string): boolean {
  const rel = relative(norm(root), norm(p))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** 家目录下的两个容器根（字面路径，不碰磁盘） */
export function appContainerRoots(home: string = homedir()): string[] {
  return CONTAINER_DIRS.map((segs) => join(home, ...segs))
}

/** 容器根：字面家目录一份；家目录的真实路径与之不同时再一份 */
export async function resolvedAppContainerRoots(home: string = homedir()): Promise<string[]> {
  const roots = appContainerRoots(home)
  try {
    const real = await realpath(home)
    if (norm(real) !== norm(home)) roots.push(...appContainerRoots(real))
  } catch {
    /* 家目录读不到真实路径：字面那一份照用 */
  }
  return roots
}

/** `p` 是否落在任一容器根之内（含根本身） */
export function isInAppContainer(p: string, roots: readonly string[]): boolean {
  return roots.some((root) => isWithin(p, root))
}

/** glob 元字符逐个包进字符类，让路径段按字面匹配（家目录名里可能带 `[` 之类） */
const escapeGlob = (segment: string): string => segment.replace(/[*?[\]{}]/g, '[$&]')

/**
 * 给在 `cwd` 下递归列举 / 搜索的 ripgrep 用的排除 glob。
 *
 * 容器根落在 `cwd` 之内（`cwd` 是家目录、家目录的祖先，或 `~/Library` 本身）时各出一条
 * `!/<相对路径>`：开头的 `/` 把它锚在搜索根上，于是项目里恰好叫 `Library/Containers` 的目录不受牵连。
 * `cwd` 本身就在容器里 = 用户明确指向了那里，不拦。调用方要把这些 glob 排在自己的 glob **之后**
 * （rg 的 glob 后者优先，放在前面会被 `*.md` 这类白名单捞回来）。
 */
export async function appContainerExcludeGlobs(
  cwd: string,
  home: string = homedir()
): Promise<string[]> {
  let base = resolve(cwd)
  try {
    base = await realpath(cwd)
  } catch {
    /* cwd 不存在：rg 自己会报，这里按字面算 */
  }
  const baseDepth = base.split(sep).filter(Boolean).length
  const globs = new Set<string>()
  for (const root of await resolvedAppContainerRoots(home)) {
    if (!isWithin(root, base) || isWithin(base, root)) continue
    // 段数在大小写折叠下不变：按段截，glob 里留的是容器根自己的拼写（即磁盘上的拼写）
    const rel = root.split(sep).filter(Boolean).slice(baseDepth)
    globs.add(`!/${rel.map(escapeGlob).join('/')}`)
  }
  return [...globs]
}
