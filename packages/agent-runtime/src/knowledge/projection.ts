/**
 * 保留文件的确定性投影 —— index.md / log.md 由宿主生成，agent 不维护（原则 P3）。
 *
 * 作用域是**一个 bundle**：入参是该 bundle 内的概念（bundle 相对路径），出参是该 bundle 内
 * 每个目录的 index.md。跨 bundle 的事这里一概不知道 —— 那正是 bundle 边界的意思。
 *
 * index：同一份概念清单永远渲染出同一批字节 —— 按 NFC 归一后的码点序排序、不写时间戳、
 * 不写计数。bundle 根 index 带 `okf_version` frontmatter，先列自己的条目再列子目录；
 * 子目录 index 同样的两节、不带 frontmatter。每个含概念或子目录的目录都得到一份 index.md；
 * 宿主比对内容后只写有变化的文件，免得 git 历史被无意义的重写刷满。
 *
 * log：按日期倒序分组，新事件插在同日最前；渲染与解析都走 core-okf（保留文件的格式约定
 * 归社区包）。
 */
import {
  OKF_INDEX_FILE,
  PROJECT_CONCEPT_FILE,
  type OkfStatus
} from '@shuvix/chat-protocol/knowledge'
import {
  buildIndexMd,
  buildLogMd,
  buildRootIndexMd,
  parseLogMd,
  type OkfIndexSection
} from './okfCodec'
import { normalizeBundlePath } from './bundlePaths'

/** 投影只需要概念的这几项（与 KnowledgeConcept 结构兼容） */
export interface ProjectionConcept {
  path: string
  title: string
  description: string
  status: OkfStatus
}

/** NFC 归一后的码点序（与进程 locale 无关） */
export function comparePaths(a: string, b: string): number {
  const x = a.normalize('NFC')
  const y = b.normalize('NFC')
  return x < y ? -1 : x > y ? 1 : 0
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

function baseOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

export interface RenderIndexesInput {
  concepts: readonly ProjectionConcept[]
  /** 没有概念也要有 index 的目录（如刚建出来、还没有条目的 bundle 根） */
  extraDirs?: readonly string[]
  okfVersion: string
}

/**
 * 单个 bundle 的 index 投影：目录（'' = bundle 根）→ index.md 内容。
 * 目录标题取绑定概念（project.md）的 title，否则用目录名。
 */
export function renderAllIndexes(input: RenderIndexesInput): Map<string, string> {
  const concepts = [...input.concepts]
    .map((c) => ({ ...c, path: normalizeBundlePath(c.path) }))
    .sort((a, b) => comparePaths(a.path, b.path))

  // 目录集合：每个概念的全部祖先 + 显式给出的目录（及其祖先）
  const dirs = new Set<string>([''])
  const addAncestors = (dir: string): void => {
    let cur = normalizeBundlePath(dir)
    while (cur) {
      dirs.add(cur)
      cur = dirOf(cur)
    }
  }
  for (const c of concepts) addAncestors(dirOf(c.path))
  for (const d of input.extraDirs ?? []) addAncestors(d)

  const byDir = new Map<string, ProjectionConcept[]>()
  for (const c of concepts) {
    const list = byDir.get(dirOf(c.path)) ?? []
    list.push(c)
    byDir.set(dirOf(c.path), list)
  }
  const childDirs = (dir: string): string[] =>
    [...dirs].filter((d) => d !== '' && dirOf(d) === dir).sort(comparePaths)

  const dirTitle = (dir: string): string => {
    const binding = (byDir.get(dir) ?? []).find((c) => baseOf(c.path) === PROJECT_CONCEPT_FILE)
    return binding?.title || baseOf(dir)
  }
  const entryOf = (c: ProjectionConcept, from: string): OkfIndexSection['entries'][number] => ({
    path: from ? c.path.slice(from.length + 1) : c.path,
    title: c.status === 'deprecated' ? `${c.title} (deprecated)` : c.title,
    ...(c.description ? { description: c.description } : {})
  })
  const subdirEntry = (sub: string, from: string): OkfIndexSection['entries'][number] => ({
    path: `${from ? sub.slice(from.length + 1) : sub}/${OKF_INDEX_FILE}`,
    title: dirTitle(sub)
  })

  const out = new Map<string, string>()
  for (const dir of [...dirs].sort(comparePaths)) {
    const own = byDir.get(dir) ?? []
    const subs = childDirs(dir)
    const sections: OkfIndexSection[] = []
    if (own.length > 0)
      sections.push({ heading: 'Entries', entries: own.map((c) => entryOf(c, dir)) })
    if (subs.length > 0) {
      sections.push({ heading: 'Sections', entries: subs.map((s) => subdirEntry(s, dir)) })
    }
    // bundle 根只比子目录多一份 `okf_version` frontmatter —— 它是「这是一个 OKF bundle」的声明
    out.set(dir, dir === '' ? buildRootIndexMd(input.okfVersion, sections) : buildIndexMd(sections))
  }
  return out
}

export type KnowledgeLogOp =
  | 'Creation'
  | 'Update'
  | 'Verification'
  | 'Deprecation'
  | 'Deletion'
  | 'Move'
  | 'External'

export interface KnowledgeLogEvent {
  /** YYYY-MM-DD */
  date: string
  op: KnowledgeLogOp
  /** bundle 相对路径 */
  path: string
  title?: string
  actor?: string
}

/** 一条日志的正文：`**Op** /path — title · by actor` */
export function formatLogText(event: KnowledgeLogEvent): string {
  const parts = [`**${event.op}** /${normalizeBundlePath(event.path)}`]
  if (event.title) parts.push(`— ${event.title}`)
  if (event.actor) parts.push(`· by ${event.actor}`)
  return parts.join(' ')
}

/**
 * 在既有 log.md 上追加一条（不存在给 null）：新事件排到同日最前，日期倒序。
 * 既有内容经 core-okf 解析再整体重渲染 —— 日志是投影，不保留手写格式。
 */
export function appendLogEntry(existing: string | null, event: KnowledgeLogEvent): string {
  const entries = existing ? parseLogMd(existing) : []
  const merged = [{ date: event.date, text: formatLogText(event) }, ...entries]
  // 稳定排序：日期倒序，同日保持插入顺序（新事件在前）
  const sorted = merged
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.date === b.e.date ? a.i - b.i : a.e.date < b.e.date ? 1 : -1))
    .map(({ e }) => e)
  return buildLogMd(sorted)
}
