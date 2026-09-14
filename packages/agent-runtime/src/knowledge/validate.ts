/**
 * 知识库校验 —— **读宽写严**：只有 ShuviX 自己建出来的条目（带 `shuvix: okf` 自述行）才按 OKF 严格
 * 检查；用户的普通笔记（没有 frontmatter、没有 `type`）一律不查合规。
 *
 * 严格那一档（validateConceptText，规范 §11 的两条规则 + 本仓关心的软告警）：
 * error：没有可解析的 frontmatter、`type` 缺失 / 不是非空字符串。
 * warning：缺 title / description、非法 status、`stale_after` 不是日期、`generated` / `verified` /
 *          `sources` 形状不对、指向 bundle 内却解析不到的链接。
 *
 * 分档（validateKnowledgeText）：
 *   - ShuviX 早先生成的 index.md / log.md（不再维护，留在原地）：不查；
 *   - 带自述行的条目：严格；
 *   - 外来的 OKF 条目（有 `type`、没有自述行）：同样的检查 —— frontmatter 与 type 都在，只可能出警告；
 *   - 其余笔记：只在 frontmatter 的 YAML 写坏时提醒（属性卡会因此显示语法错误）。
 *
 * index.md / log.md 是 OKF 的保留名：内容是 ShuviX 早先生成的形状（isProjectionText）才当旧产物跳过，
 * 用户自己写的同名文件（首页、日记）是普通笔记。
 *
 * 校验是回执不是准入（同 shuvixMdWrite 的哲学）：写钩子把这里的诊断带回给 agent，文件仍然写进去了。
 */
import {
  KNOWLEDGE_MARKER_TYPE,
  OKF_INDEX_FILE,
  OKF_LOG_FILE
} from '@shuvix/chat-protocol/knowledge'
import { readShuvixMarker } from '@shuvix/chat-protocol/shuvixMdContract'
import { splitFrontmatter } from '../markdownFrontmatter'
import { isOkfConceptText, parseConceptText, type KnowledgeConcept } from './conceptFile'
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

/** 保留**名**（index.md / log.md）。内容是不是 ShuviX 早先生成的形状另看 isProjectionText */
export function isReservedFile(path: string): boolean {
  const base = baseOf(normalizeBundlePath(path))
  return base === OKF_INDEX_FILE || base === OKF_LOG_FILE
}

/**
 * 宿主渲染的 index.md 只有这几种行：`## 节`、`* [标题](路径)`（可带 ` - 描述`）与空行。路径是原样写出的，
 * 可能带一层括号（`x (1).md`）
 */
const INDEX_SECTION_LINE = /^##\s+\S/
const INDEX_ENTRY_LINE = /^\*\s+\[(?:\\.|[^\]])*\]\((?:[^()]|\([^()]*\))*\)(?:\s+-\s+.*)?$/
/** 根 index 的 frontmatter 里宿主会写的键 */
const INDEX_FRONTMATTER_KEYS = new Set(['okf_version', 'profile'])
/** 宿主渲染的 log.md 只有 `## YYYY-MM-DD`、`- **Op** /路径 …`（每一版投影都是这个形状）与空行 */
const LOG_DATE_LINE = /^##\s+\d{4}-\d{2}-\d{2}\s*$/
const LOG_ITEM_LINE = /^-\s+\*\*[A-Za-z]+\*\*\s+\//

/** 每个非空行都合某种形状；`nonEmpty` 时还得至少有一行 */
function onlyLines(text: string, allowed: readonly RegExp[], nonEmpty = false): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (nonEmpty && lines.length === 0) return false
  return lines.every((line) => allowed.some((re) => re.test(line)))
}

/**
 * 保留名文件的内容是不是 ShuviX 早先生成的 index / log 的形状 —— 现在不再维护它们，但留在原地的旧文件
 * 不该冒充笔记出现在侧栏与检索里。判定尽量保守：认错成「用户的」，代价只是多出一行；认错成「生成的」，
 * 用户的笔记就看不见了。所以空文件不算（宿主从没写出过空的 index / log —— 空库的根 index 也有
 * frontmatter），log 的条目行要合宿主一贯的 `- **Op** /路径` 形状。index 的节标题历代都变过，只能按行
 * 形状认：用 `* [标题](路径)` 手写的目录会被当成生成的，这是已知的代价。非保留名恒为 false。
 */
export function isProjectionText(path: string, text: string): boolean {
  const base = baseOf(normalizeBundlePath(path))
  const clean = text.replace(/^\uFEFF/, '')
  if (base === OKF_INDEX_FILE) {
    const split = splitFrontmatter(clean)
    if (!split) return onlyLines(clean, [INDEX_SECTION_LINE, INDEX_ENTRY_LINE], true)
    const fields = parseOkfText(clean)?.fields
    if (!fields || Object.keys(fields).some((key) => !INDEX_FRONTMATTER_KEYS.has(key))) return false
    // 空库的根 index 只有 frontmatter
    return onlyLines(split.body, [INDEX_SECTION_LINE, INDEX_ENTRY_LINE])
  }
  if (base === OKF_LOG_FILE) return onlyLines(clean, [LOG_DATE_LINE, LOG_ITEM_LINE], true)
  return false
}

/** ShuviX 早先生成的保留文件：保留名 + 生成的形状（用户自己的同名笔记不算） */
export function isProjectionFile(path: string, text: string): boolean {
  return isReservedFile(path) && isProjectionText(path, text)
}

/** 单份文本的**严格** OKF 诊断（ShuviX 建出来的条目、`create` 的回执用） */
export function validateConceptText(text: string, path: string): KnowledgeDiagnostic[] {
  const rel = normalizeBundlePath(path)
  const out: KnowledgeDiagnostic[] = []
  const push = (level: KnowledgeDiagnostic['level'], message: string): void => {
    out.push({ path: rel, level, message })
  }

  // 保留名不是条目，没有什么可查
  if (isReservedFile(rel)) return out

  if (!splitFrontmatter(text)) {
    push(
      'error',
      unclosedFrontmatter(text) === null
        ? 'no YAML frontmatter block (an OKF concept starts with `---`)'
        : 'the frontmatter block is never closed — end it with a `---` line'
    )
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
    push('warning', "'description' (one line) is recommended — it is what list and search show")
  if (concept.staleAfter && !ISO_DATE_RE.test(concept.staleAfter)) {
    push('warning', "'stale_after' should be an ISO 8601 date (YYYY-MM-DD)")
  }
  if (concept.generated && Number.isNaN(Date.parse(concept.generated.at))) {
    push('warning', "'generated.at' should be an ISO 8601 timestamp")
  }
  return out
}

/** 开了 `---` 却没有闭合的 frontmatter：开栏线之后的全文；没开栏（或已闭合）返回 null */
function unclosedFrontmatter(text: string): string | null {
  if (splitFrontmatter(text)) return null
  const clean = text.replace(/^\uFEFF/, '').replace(/^\s+/, '')
  const open = /^---[ \t]*\r?\n/.exec(clean)
  return open ? clean.slice(open[0].length) : null
}

/**
 * 带 ShuviX 的 `shuvix: okf` 自述行（按原文行读 —— YAML 写坏了、甚至闭合的 `---` 被删掉了，也认得出这是
 * ShuviX 的条目，写坏的那一下当场回 error，而不是悄悄降成普通笔记）
 */
function carriesKnowledgeMarker(text: string): boolean {
  const head = splitFrontmatter(text)?.yaml ?? unclosedFrontmatter(text)
  return head !== null && readShuvixMarker(head)?.type === KNOWLEDGE_MARKER_TYPE
}

/** 普通笔记只查一件事：有 frontmatter 却不是可解析的 YAML 映射 */
function frontmatterSyntax(text: string, rel: string): KnowledgeDiagnostic[] {
  if (!splitFrontmatter(text) || parseOkfText(text)) return []
  return [
    {
      path: rel,
      level: 'warning',
      message:
        'frontmatter is not parseable YAML, or is not a key/value mapping — ShuviX shows a syntax error instead of its fields until it is fixed'
    }
  ]
}

/** 一份笔记的诊断（写钩子 / 工具 validate 用），分档见文件头 */
export function validateKnowledgeText(text: string, path: string): KnowledgeDiagnostic[] {
  const rel = normalizeBundlePath(path)
  if (isReservedFile(rel)) return isProjectionText(rel, text) ? [] : frontmatterSyntax(text, rel)
  if (carriesKnowledgeMarker(text) || isOkfConceptText(text)) return validateConceptText(text, rel)
  return frontmatterSyntax(text, rel)
}

export interface BundleFile {
  /** bundle 相对路径 */
  path: string
  text: string
}

export interface BundleValidation {
  diagnostics: KnowledgeDiagnostic[]
  /** 解析成功的 OKF 条目（普通笔记、保留名文件与有 error 的文件不在其中） */
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

/** 整个 bundle：逐文件分档诊断 + OKF 条目的链接可解析（普通笔记的链接不查） */
export function validateBundleFiles(files: readonly BundleFile[]): BundleValidation {
  const diagnostics: KnowledgeDiagnostic[] = []
  const concepts: KnowledgeConcept[] = []
  const known = new Set(files.map((f) => normalizeBundlePath(f.path)))

  for (const file of files) {
    const rel = normalizeBundlePath(file.path)
    const own = validateKnowledgeText(file.text, rel)
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
