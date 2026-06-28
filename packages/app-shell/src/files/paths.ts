/**
 * 宿主无关的轻量路径工具（不依赖 node:path，兼容 POSIX `/` 与 Windows `\` 分隔符）。
 * 供 Files 面板、笔记本会话（中间区 NotebookView）、横幅创建笔记本等共享，
 * 避免在渲染端引入 node:path，并统一相对路径以 forward-slash 存储的约定。
 */

/** 取扩展名（含点，小写）；无扩展返回 '' */
export function extOf(path: string): string {
  const idx = path.lastIndexOf('.')
  return idx >= 0 ? path.slice(idx).toLowerCase() : ''
}

/** 取路径最后一段 */
export function basename(p: string): string {
  const s = p.replace(/[/\\]+$/, '')
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return idx >= 0 ? s.slice(idx + 1) : s
}

/** 用宿主机分隔符（POSIX `/`，win `\`）把 base 与相对路径拼接，去重边界分隔符 */
export function joinPath(base: string, rel: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  const left = base.replace(/[/\\]+$/, '')
  const right = rel.replace(/^[/\\]+/, '')
  return `${left}${sep}${right}`
}

/**
 * 求 abs 相对 base 的路径（forward-slash 归一）。abs 不在 base 下则返回 null。
 * 分隔符与大小写：路径比较按原样（不做大小写折叠），与 joinPath 往返一致即可。
 */
export function relativize(base: string, abs: string): string | null {
  const normBase = base.replace(/\\/g, '/').replace(/\/+$/, '')
  const normAbs = abs.replace(/\\/g, '/')
  if (normAbs === normBase) return ''
  const prefix = normBase + '/'
  if (!normAbs.startsWith(prefix)) return null
  return normAbs.slice(prefix.length)
}
