/**
 * 笔记里相对路径的解析（纯函数，渲染进程没有 node:path）。
 *
 * 主窗口的笔记本拿到的 documentId 是相对工作目录的 notebookPath，Markdown 窗口拿到的是绝对路径，
 * 两种都要能解：图片交给 mediaUrl seam（相对路径由主进程按会话工作目录解），文件链接要绝对路径。
 */
import { joinHostPath } from '@shuvix/chat-protocol/utils/fileMap'

/** 宿主绝对路径判定：posix `/`、win 盘符 `C:\` / `C:/`、UNC `\\server\share` */
export const isAbsHostPath = (p: string): boolean =>
  p.startsWith('/') || p.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(p)

/** 带 scheme 的 URL（http(s):/data:/blob:/shuvix-preview:/file: 等） */
export const hasUrlScheme = (s: string): boolean => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)

/** `%20` 这类转义还原成文件名里的字符；不是合法转义的部分（文件名里本来就有 `%`）保持原样 */
function decodePath(p: string): string {
  return p.replace(/(?:%[0-9a-fA-F]{2})+/g, (escapes) => {
    try {
      return decodeURIComponent(escapes)
    } catch {
      return escapes
    }
  })
}

/**
 * 把 md 里的相对路径按文档（docPath）所在目录解析：`.` 略过，`..` 回退一层，查询串和锚点丢弃。
 *
 * docPath 是绝对路径 → 结果是绝对路径，`..` 不越过根。
 * docPath 是相对路径 → 结果相对同一个基准（会话工作目录），越出基准的 `..` 留在开头，
 * 交主进程解：同一篇笔记在主窗口和 Markdown 窗口里要解到同一个文件。
 */
export function resolveAgainstDocDir(docPath: string, rel: string): string | null {
  const clean = decodePath(rel.split('#')[0].split('?')[0].trim())
  if (!clean) return null
  const absolute = isAbsHostPath(docPath)
  const win = docPath.includes('\\') && !docPath.includes('/')
  const sep = win ? '\\' : '/'
  const parts = docPath.split(/[/\\]/).filter((seg) => seg !== '.')
  parts.pop() // 去掉文件名 → 所在目录
  // 根占几段：posix [''] 与 win 盘符 ['C:'] 一段，UNC ['', '', 'srv', 'share'] 四段
  const rootSegments = docPath.startsWith('\\\\') ? 4 : 1
  for (const seg of clean.split(/[/\\]/)) {
    if (!seg || seg === '.') continue
    if (seg !== '..') {
      parts.push(seg)
    } else if (absolute) {
      if (parts.length <= rootSegments) return null
      parts.pop()
    } else if (parts.length > 0 && parts[parts.length - 1] !== '..') {
      parts.pop()
    } else {
      parts.push('..')
    }
  }
  const joined = parts.join(sep)
  if (absolute) return isAbsHostPath(joined) ? joined : null
  if (!joined) return null
  // 主进程解相对路径时会把开头的 `~` 展开成家目录、去掉开头的 `@`：这里它们只是文件名
  return /^[~@]/.test(joined) ? `.${sep}${joined}` : joined
}

/** 这条链接是不是指向文档旁边的文件（不是网址、不是绝对路径、不是文内锚点） */
export function isRelativeFileLink(url: string): boolean {
  const s = url.trim()
  return !!s && !s.startsWith('#') && !hasUrlScheme(s) && !isAbsHostPath(s)
}

/**
 * 相对文件链接 → 绝对路径（打开文件的信号要绝对路径）。
 * root 是会话工作目录：documentId 是相对路径时靠它补全，没有 root 就解不出来。
 */
export function resolveRelativeFileLink(
  url: string,
  documentId: string,
  root: string | null
): string | null {
  if (!isRelativeFileLink(url)) return null
  const docAbs = isAbsHostPath(documentId)
    ? documentId
    : root
      ? joinHostPath(root, documentId)
      : null
  return docAbs ? resolveAgainstDocDir(docAbs, url) : null
}
