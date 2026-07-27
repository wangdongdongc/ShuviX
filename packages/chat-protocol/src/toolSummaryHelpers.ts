/**
 * 工具摘要函数的公共助手（叶子模块，无内部依赖）
 *
 * builtinToolPresentations.ts（共享内置工具的 buildSummary）与 toolSummaries.ts
 * （注册表 + 各端补充条目）都从此处取用；两者之间已有值依赖
 * （toolSummaries 收集 builtin defs），助手独立成叶子避免循环初始化。
 */
import type { ToolSummaryBuilder } from './toolSummaries'

/** 取字符串/数字参数为摘要文本；空串或其他类型返回 undefined */
export const asStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : undefined

/** 单字段摘要：直接取 args 中某个字段的值作为摘要文本 */
export const field =
  (name: string): ToolSummaryBuilder =>
  (args) =>
    asStr(args[name])

/** 文件路径摘要：绝对路径只取末段文件名（相对路径原样保留，更短且含上下文） */
export const fileNameOf = (v: unknown): string | undefined => {
  const p = asStr(v)
  if (!p) return undefined
  const isAbsolute = p.startsWith('/') || p.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(p)
  if (!isAbsolute) return p
  const segments = p.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? p
}

/** 单字段文件路径摘要：fileNameOf 的字段版（read/write/edit/ls 等文件工具用） */
export const fileField =
  (name: string): ToolSummaryBuilder =>
  (args) =>
    fileNameOf(args[name])
