/**
 * 作用域 = 目录（docs/okf-knowledge-design.md §3）。本模块是纯路径算术：
 * 不查会话、不查项目 —— 「这个会话有哪些作用域」由宿主回答（桌面 services/knowledge/scopes.ts），
 * 这里只回答「某个作用域在 bundle 里住哪」「某条路径属于哪个作用域」。
 */
import { KNOWLEDGE_DIRS, type KnowledgeScopeKind } from '@shuvix/chat-protocol/knowledge'

export type KnowledgeScope =
  | { kind: 'global' }
  | { kind: 'project'; projectSlug: string }
  /** 有项目：`projects/<slug>/sessions/`；无项目：顶层 `sessions/` */
  | { kind: 'session'; projectSlug?: string }
  | { kind: 'bot'; botName: string }
  | { kind: 'wiki'; topic?: string }
  | { kind: 'raw' }

/** 作用域目录（bundle 相对，无前导/尾随 `/`） */
export function scopeDir(scope: KnowledgeScope): string {
  switch (scope.kind) {
    case 'global':
      return KNOWLEDGE_DIRS.global
    case 'project':
      return `${KNOWLEDGE_DIRS.projects}/${scope.projectSlug}`
    case 'session':
      return scope.projectSlug
        ? `${KNOWLEDGE_DIRS.projects}/${scope.projectSlug}/${KNOWLEDGE_DIRS.sessions}`
        : KNOWLEDGE_DIRS.sessions
    case 'bot':
      return `${KNOWLEDGE_DIRS.bots}/${scope.botName}`
    case 'wiki':
      return scope.topic ? `${KNOWLEDGE_DIRS.wiki}/${scope.topic}` : KNOWLEDGE_DIRS.wiki
    case 'raw':
      return KNOWLEDGE_DIRS.raw
  }
}

/** 归一 bundle 相对路径：反斜杠 → `/`，去前导 `/` 与 `./`，压缩重复分隔符 */
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

/** 某条 bundle 路径所属的作用域；不在任何作用域目录下（根文件等）返回 null */
export function scopeOfPath(path: string): KnowledgeScope | null {
  const segs = normalizeBundlePath(path).split('/')
  if (segs.length < 2) return null
  const [top, second, third] = segs
  switch (top) {
    case KNOWLEDGE_DIRS.global:
      return { kind: 'global' }
    case KNOWLEDGE_DIRS.projects:
      if (segs.length < 3) return null
      if (third === KNOWLEDGE_DIRS.sessions && segs.length >= 4) {
        return { kind: 'session', projectSlug: second }
      }
      return { kind: 'project', projectSlug: second }
    case KNOWLEDGE_DIRS.sessions:
      return { kind: 'session' }
    case KNOWLEDGE_DIRS.bots:
      return segs.length >= 3 ? { kind: 'bot', botName: second } : null
    case KNOWLEDGE_DIRS.wiki:
      return segs.length >= 3 ? { kind: 'wiki', topic: second } : { kind: 'wiki' }
    case KNOWLEDGE_DIRS.raw:
      return { kind: 'raw' }
    default:
      return null
  }
}

export function scopeKindOfPath(path: string): KnowledgeScopeKind | null {
  return scopeOfPath(path)?.kind ?? null
}

/** 是否会话摘要目录下的路径（策略：这些写入免询问，由工作流滚动维护） */
export function isSessionScopePath(path: string): boolean {
  return scopeKindOfPath(path) === 'session'
}

const SLUG_MAX = 60

/**
 * 标题 → 文件名 slug。保留任何语言的字母数字（中文项目名直接当目录名），其余归为 `-`；
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

/** 会话摘要文件名：`<yyyy-mm-dd>-<slug>.md` */
export function sessionSummaryFileName(date: string, title: string): string {
  return `${date}-${slugify(title, 'session')}.md`
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

/** 作用域的人读标签（围栏 / 工具回执用；UI 有自己的 i18n） */
export function scopeLabel(scope: KnowledgeScope): string {
  switch (scope.kind) {
    case 'global':
      return 'global'
    case 'project':
      return `project ${scope.projectSlug}`
    case 'session':
      return scope.projectSlug ? `sessions of project ${scope.projectSlug}` : 'sessions'
    case 'bot':
      return `bot ${scope.botName}`
    case 'wiki':
      return scope.topic ? `wiki topic ${scope.topic}` : 'wiki'
    case 'raw':
      return 'raw sources'
  }
}
