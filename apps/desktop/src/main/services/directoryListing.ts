/**
 * 服务端目录列表（server mode phase D，docs/server/phase-d-web-fallbacks.md §D3）—— 浏览器里的 web 客户端没有
 * 原生的「选择文件夹」框（那个框弹在运行 ShuviX 的这台电脑上），选项目文件夹 / 外部技能目录改用一个页面里的
 * 目录浏览器，它一层一层地问这里（`fs:listDirectories`）：
 *
 *  - 给的路径：空 / 不给 → 用户主目录；`~` / `~/…` 按主目录展开；相对路径按主目录解析；
 *  - 只列**目录**（指向目录的符号链接也算），隐藏目录（`.` 开头）只在 `showHidden` 时列出；
 *  - 按名字排序（不分大小写、数字按数值）；条数有上限（超过 → `truncated`）；
 *  - 读不了（不存在 / 不是目录 / 没权限）→ 不抛，`error` 带 Node 的错误码，`entries` 为空 —— 页面照样能往上走。
 *
 * 不限路径（用户裁决：网络访问本来就没有认证）。
 */
import { readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { dirname, isAbsolute, join, resolve } from 'path'
import type { DirectoryListing, ListDirectoriesParams } from '../../shared/serverFs'

export type { DirectoryListing, ListDirectoriesParams }

/** 一次最多列多少个子目录 */
export const MAX_DIRECTORY_ENTRIES = 2000

/** 请求里的路径 → 要列的绝对路径 */
export function resolveListingPath(raw: unknown, home: string): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '' || text === '~') return resolve(home)
  if (text.startsWith('~/') || text.startsWith('~\\')) return resolve(home, text.slice(2))
  return isAbsolute(text) ? resolve(text) : resolve(home, text)
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'EIO'
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** 列一个目录下的子目录（从不拒绝） */
export async function listDirectories(
  params: ListDirectoriesParams | undefined,
  home: string = homedir()
): Promise<DirectoryListing> {
  const path = resolveListingPath(params?.path, home)
  const parentPath = dirname(path)
  const base = { path, parent: parentPath === path ? null : parentPath, home }
  try {
    const info = await stat(path)
    if (!info.isDirectory()) return { ...base, entries: [], error: 'ENOTDIR' }
  } catch (error) {
    return { ...base, entries: [], error: errorCodeOf(error) }
  }
  let dirents
  try {
    dirents = await readdir(path, { withFileTypes: true })
  } catch (error) {
    return { ...base, entries: [], error: errorCodeOf(error) }
  }
  const showHidden = params?.showHidden === true
  const names: string[] = []
  for (const dirent of dirents) {
    if (!showHidden && dirent.name.startsWith('.')) continue
    if (dirent.isDirectory()) {
      names.push(dirent.name)
    } else if (dirent.isSymbolicLink()) {
      try {
        if ((await stat(join(path, dirent.name))).isDirectory()) names.push(dirent.name)
      } catch {
        /* 断掉的链接：不列 */
      }
    }
  }
  names.sort((a, b) => collator.compare(a, b))
  const truncated = names.length > MAX_DIRECTORY_ENTRIES
  const entries = names
    .slice(0, MAX_DIRECTORY_ENTRIES)
    .map((name) => ({ name, path: join(path, name) }))
  return truncated ? { ...base, entries, truncated: true } : { ...base, entries }
}
