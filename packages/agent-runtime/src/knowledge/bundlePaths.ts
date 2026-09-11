/**
 * bundle 内的路径算术（docs/okf-knowledge-design.md §3）。纯函数：不查会话、不查项目、
 * 不碰磁盘 —— 「这条绝对路径属于哪个 bundle」由宿主回答（桌面 services/knowledge/bundles.ts），
 * 这里只处理**一个 bundle 之内**的相对路径。
 *
 * 一个 bundle = 一份 `index.md` 管得着的范围，边界之外的引用不用 bundle 绝对路径而用
 * `shuvix://` URI（见 chat-protocol/knowledge.ts）。
 */

/** 归一 bundle 相对路径：反斜杠 → `/`，去前导 `/` 与 `./`，压缩重复分隔符，去尾随 `/` */
export function normalizeBundlePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

/** 路径是否越出 bundle（含 `..` 段） */
export function escapesBundle(path: string): boolean {
  return normalizeBundlePath(path)
    .split('/')
    .some((seg) => seg === '..')
}

const SLUG_MAX = 60

/**
 * 标题 → 文件名 / 目录名 slug。保留任何语言的字母数字（中文项目名直接当目录名），其余归为 `-`；
 * ASCII 小写；超长截断到 60 字符。空结果回落 fallback（缺省 'entry'）。
 */
export function slugify(title: string, fallback = 'entry'): string {
  const slug = title
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '')
  return slug || fallback
}

/** 目录里不重名的文件名：`a.md` 已存在 → `a-2.md`、`a-3.md` … */
export function dedupeFileName(base: string, exists: (name: string) => boolean): string {
  if (!exists(base)) return base
  const stem = base.replace(/\.md$/i, '')
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}.md`
    if (!exists(candidate)) return candidate
  }
  return `${stem}-${Date.now()}.md`
}
