/**
 * 共享 ls 内核 —— 从文件列表构建树形目录结构并渲染为缩进文本（纯函数）。
 * 从桌面 ls.ts 的 buildTree 逐字搬出。文件枚举（桌面 ripgrep / 扩展 FSA 遍历）由各端注入。
 */

export function buildTree(files: string[]): string {
  // 统一分隔符为 /
  const normalized = files.map((f) => f.split('\\').join('/'))

  // 构建目录→文件映射
  const dirs = new Set<string>()
  const filesByDir = new Map<string, string[]>()

  const dirnameOf = (p: string): string => {
    const i = p.lastIndexOf('/')
    return i <= 0 ? '.' : p.slice(0, i)
  }
  const basenameOf = (p: string): string => {
    const i = p.lastIndexOf('/')
    return i < 0 ? p : p.slice(i + 1)
  }

  for (const file of normalized) {
    const dir = dirnameOf(file)
    const parts = dir === '.' ? [] : dir.split('/')

    // 注册所有父目录
    for (let i = 0; i <= parts.length; i++) {
      const dirPath = i === 0 ? '.' : parts.slice(0, i).join('/')
      dirs.add(dirPath)
    }

    // 文件归入所属目录
    if (!filesByDir.has(dir)) filesByDir.set(dir, [])
    filesByDir.get(dir)!.push(basenameOf(file))
  }

  function renderDir(dirPath: string, depth: number): string {
    const indent = '  '.repeat(depth)
    let output = ''

    if (depth > 0) {
      output += `${indent}${basenameOf(dirPath)}/\n`
    }

    const childIndent = '  '.repeat(depth + 1)

    // 子目录（排序）
    const children = Array.from(dirs)
      .filter((d) => dirnameOf(d) === dirPath && d !== dirPath)
      .sort()

    for (const child of children) {
      output += renderDir(child, depth + 1)
    }

    // 文件（排序）
    const dirFiles = filesByDir.get(dirPath) || []
    for (const file of dirFiles.sort()) {
      output += `${childIndent}${file}\n`
    }

    return output
  }

  return renderDir('.', 0)
}
