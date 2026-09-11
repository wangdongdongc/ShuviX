/**
 * OKF 一致性校验（规范 §7 的三条规则 + 本仓关心的软告警）。
 *
 * error：bundle 不合规 —— 非保留 `.md` 没有可解析的 frontmatter、`type` 缺失/非空字符串、
 *        非根 index.md 带 frontmatter。
 * warning：合规但值得修 —— 缺 title / description、非法 status、`stale_after` 不是日期、
 *          `generated` / `verified` / `sources` 形状不对、指向 bundle 内却解析不到的链接。
 *
 * 校验是回执不是准入（同 shuvixMdWrite 的哲学）：写钩子把这里的诊断带回给 agent，
 * 文件仍然写进去了；扫描侧遇到 error 的文件只是不当概念对待。
 */
import { OKF_INDEX_FILE, OKF_LOG_FILE } from '@shuvix/chat-protocol/knowledge'
import { splitFrontmatter } from '../markdownFrontmatter'
import { parseConceptText, type KnowledgeConcept } from './conceptFile'
import { extractConceptLinks, parseOkfText } from './okfCodec'
import { normalizeBundlePath } from './bundlePaths'

export interface KnowledgeDiagnostic {
  path: string
  level: 'error' | 'warning'
  message: string
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/

function baseOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

export function isReservedFile(path: string): boolean {
  const base = baseOf(normalizeBundlePath(path))
  return base === OKF_INDEX_FILE || base === OKF_LOG_FILE
}

/** 单份概念文本的诊断（写钩子 / 工具回执用） */
export function validateConceptText(text: string, path: string): KnowledgeDiagnostic[] {
  const rel = normalizeBundlePath(path)
  const out: KnowledgeDiagnostic[] = []
  const push = (level: KnowledgeDiagnostic['level'], message: string): void => {
    out.push({ path: rel, level, message })
  }

  if (isReservedFile(rel)) {
    const isRoot = rel === OKF_INDEX_FILE
    if (baseOf(rel) === OKF_INDEX_FILE && !isRoot && splitFrontmatter(text)) {
      push('error', 'index.md below the bundle root must not carry frontmatter')
    }
    return out
  }

  if (!splitFrontmatter(text)) {
    push('error', 'no YAML frontmatter block (an OKF concept starts with `---`)')
    return out
  }
  const split = parseOkfText(text)
  if (!split) {
    push('error', 'frontmatter is not parseable YAML, or is not a key/value mapping')
    return out
  }
  const type = split.fields.type
  if (typeof type !== 'string' || !type.trim()) {
    push('error', "'type' is required and must be a non-empty string")
    return out
  }

  const concept = parseConceptText(text, rel, (msg) => push('warning', msg))
  if (!concept) return out
  if (!concept.title.trim() || concept.title === baseOf(rel).replace(/\.md$/i, '')) {
    if (typeof split.fields.title !== 'string') push('warning', "'title' is recommended")
  }
  if (!concept.description)
    push('warning', "'description' (one line) is recommended — it is what indexes show")
  if (concept.staleAfter && !ISO_DATE_RE.test(concept.staleAfter)) {
    push('warning', "'stale_after' should be an ISO 8601 date (YYYY-MM-DD)")
  }
  if (concept.generated && Number.isNaN(Date.parse(concept.generated.at))) {
    push('warning', "'generated.at' should be an ISO 8601 timestamp")
  }
  return out
}

export interface BundleFile {
  /** bundle 相对路径 */
  path: string
  text: string
}

export interface BundleValidation {
  diagnostics: KnowledgeDiagnostic[]
  /** 解析成功的概念（有 error 的文件不在其中） */
  concepts: KnowledgeConcept[]
}

/** 解析一条概念链接到 bundle 相对路径；越界或非 .md 返回 null */
export function resolveLinkTarget(fromPath: string, link: string): string | null {
  const target = link.split('#')[0]
  if (!target) return null
  let rel: string
  if (target.startsWith('/')) {
    rel = target.slice(1)
  } else {
    const dir = normalizeBundlePath(fromPath).split('/').slice(0, -1)
    const segs = [...dir]
    for (const seg of target.replace(/\\/g, '/').split('/')) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') {
        if (segs.length === 0) return null
        segs.pop()
        continue
      }
      segs.push(seg)
    }
    rel = segs.join('/')
  }
  return normalizeBundlePath(rel) || null
}

/** 整个 bundle：逐文件规则 + 链接可解析 */
export function validateBundleFiles(files: readonly BundleFile[]): BundleValidation {
  const diagnostics: KnowledgeDiagnostic[] = []
  const concepts: KnowledgeConcept[] = []
  const known = new Set(files.map((f) => normalizeBundlePath(f.path)))

  for (const file of files) {
    const rel = normalizeBundlePath(file.path)
    const own = validateConceptText(file.text, rel)
    diagnostics.push(...own)
    if (isReservedFile(rel) || own.some((d) => d.level === 'error')) continue
    const concept = parseConceptText(file.text, rel)
    if (!concept) continue
    concepts.push(concept)
    for (const link of extractConceptLinks(concept.body)) {
      const target = resolveLinkTarget(rel, link.path)
      if (!target || !known.has(target)) {
        diagnostics.push({
          path: rel,
          level: 'warning',
          message: `link to '${link.path}' does not resolve inside the bundle`
        })
      }
    }
  }
  return { diagnostics, concepts }
}
