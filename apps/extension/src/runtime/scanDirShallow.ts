/**
 * 扩展端按目录浅扫描 —— 文件树懒加载的 FSA/OPFS 侧实现（纯函数，不碰 storage，便于单测）。
 *
 * 与桌面 dirScan 同契约：dir 相对工作目录根句柄（'' = 根），返回
 *  - files：该目录的直接子文件（相对根的完整相对路径，forward-slash，已排序）；
 *  - dirs：该目录的直接子目录（尾斜杠形式，已排序）。
 * 只列一层（对标 VSCode Explorer 每次展开 resolve 一层）；浏览场景所见即磁盘所有 ——
 * 唯一例外是 `.git` 目录不列出。目录不存在时返回空列表而非抛错。
 */

/** 最小目录句柄结构 —— FileSystemDirectoryHandle 的子集，测试可用内存 mock */
export interface ScanDirHandle {
  entries(): AsyncIterableIterator<[string, { kind: 'file' | 'directory' }]>
  getDirectoryHandle(name: string): Promise<ScanDirHandle>
}

export interface ScanDirShallowResult {
  files: string[]
  dirs: string[]
}

export async function scanDirHandleShallow(
  root: ScanDirHandle,
  dir: string
): Promise<ScanDirShallowResult> {
  // 归一 dir（'' = 根）；越界（绝对路径 / ..）按不存在处理
  const rel = dir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  const segments = rel && rel !== '.' ? rel.split('/') : []
  if (segments.some((s) => s === '..')) return { files: [], dirs: [] }

  // 逐段解析到目标目录句柄；任一段缺失即目录不存在
  let target = root
  try {
    for (const seg of segments) {
      target = await target.getDirectoryHandle(seg)
    }
  } catch {
    return { files: [], dirs: [] }
  }

  const files: string[] = []
  const dirs: string[] = []
  const prefix = segments.join('/')

  for await (const [name, handle] of target.entries()) {
    const childRel = prefix ? `${prefix}/${name}` : name
    if (handle.kind === 'directory') {
      if (name === '.git') continue
      dirs.push(`${childRel}/`)
    } else {
      files.push(childRel)
    }
  }

  files.sort()
  dirs.sort()
  return { files, dirs }
}
