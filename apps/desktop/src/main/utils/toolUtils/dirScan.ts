/**
 * 按目录浅扫描 —— 文件树懒加载的磁盘侧实现（对标 VSCode Explorer 的 diskFileSystemProvider：
 * 每次展开只 resolve 一层；单子目录链的合并在渲染层由 pierre flattenEmptyDirectories 处理，
 * 数据层不预取）。
 *
 * scanDirShallow(root, dir) 返回 dir（相对 root，空串 = 根）的：
 *  - files：该目录的直接子文件（相对 root、forward-slash、排序保证确定性）；
 *  - dirs：该目录的直接子目录（尾斜杠形式、排序）。
 *
 * 纯 readdir 一层遍历（withFileTypes 一次拿类型，files/dirs 从同一次遍历得出）：
 * 浏览场景所见即磁盘所有 —— 不做任何 .gitignore 过滤（gitignore 语义只留在搜索场景的
 * files.scan 全量接口里，对标 VSCode 的 search.exclude / useIgnoreFiles）。
 *
 * 保留的唯二过滤/保护：
 *  - `.git` 目录永不列出（worktree/子模块里的 `.git` 指针文件照常按文件列出）；
 *  - 符号链接指向目录时 stat 一次目标判定类型（对标 VSCode）；stat 失败按文件处理。
 *
 * 纯磁盘操作、不碰会话/DB，便于单测；会话解析在上层 filesWatcherService。
 */

import { readdir, stat } from 'fs/promises'
import { join } from 'path'

export interface DirScanResult {
  /** 相对 root 的完整相对路径（forward-slash），已排序 */
  files: string[]
  /** 直接子目录（尾斜杠形式，forward-slash），已排序 */
  dirs: string[]
}

/** 校验并归一 dir 参数：必须是 root 内的相对路径；返回 forward-slash 相对路径（'' = 根） */
export function normalizeScanDir(dir: string): string | null {
  const rel = dir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (rel === '' || rel === '.') return ''
  if (rel.startsWith('/') || /^[a-zA-Z]:\//.test(rel)) return null
  if (rel.split('/').some((seg) => seg === '..')) return null
  return rel
}

/** 浅扫描 root 下的 dir 目录（只扫一层）。目录不存在 / 不可读 / dir 越界时返回空列表。 */
export async function scanDirShallow(root: string, dir: string): Promise<DirScanResult> {
  const rel = normalizeScanDir(dir)
  if (rel === null) return { files: [], dirs: [] }

  let dirents
  try {
    dirents = await readdir(join(root, rel), { withFileTypes: true })
  } catch {
    return { files: [], dirs: [] }
  }

  const files: string[] = []
  const dirs: string[] = []
  for (const d of dirents) {
    const childRel = rel ? `${rel}/${d.name}` : d.name
    let isDir = d.isDirectory()
    if (!isDir && d.isSymbolicLink()) {
      // 符号链接：stat 跟随到目标判定类型；失败（悬空链接）按文件处理
      try {
        isDir = (await stat(join(root, childRel))).isDirectory()
      } catch {
        /* 按文件处理 */
      }
    }
    if (isDir) {
      if (d.name === '.git') continue // 永不列出
      dirs.push(`${childRel}/`)
    } else {
      files.push(childRel)
    }
  }

  files.sort()
  dirs.sort()
  return { files, dirs }
}
