/**
 * v3 JSONL 会话树的只读读取器 —— 不依赖 pi。
 *
 * 用途：存储类型为 `harness-v3-jsonl` 的旧会话永不迁移，换到新存储之后它们只能被**查看**；
 * 本文件把一份 `.jsonl` 文本读成「当前分支上、经压缩过滤的条目」，交给投影渲染。
 * 语义逐条对齐 pi 0.80.10 的 `JsonlSessionStorage.open` + `Session.buildContextEntries()`：
 *
 *  - 当前位置（leaf）：逐条读入，每读一条就更新 —— `leaf` 条目取它的 `targetId`，其余条目取自身 id。
 *    harness 的回退就是追加一条 `leaf`，所以「最后一条 leaf 指向哪里」决定显示哪条分支；
 *    把文件最后一条当分支末端会让回退掉的内容重新冒出来（pi 1.0 之前那份 v3→v4 迁移就是这么错的）。
 *  - 分支：从 leaf 沿 `parentId` 走到根，再按根 → 叶排列。
 *  - 压缩过滤：取分支上**最后一条** compaction；结果 = 该 compaction + 它之前从 `firstKeptEntryId`
 *    开始（含）的条目 + 它之后的全部条目。
 *
 * 与 pi 的唯一差别是**宽容**：pi 遇到任何一行坏数据就整个拒开，而这里是给人看旧记录的，
 * 能看多少看多少。会话头坏了才拒绝（那说明根本不是这种文件）；条目行坏了跳过并记一条 issue；
 * 空 cwd 照收；父条目缺失时分支就停在那里；leaf 指向一个不存在的条目时退回最后一条普通条目。
 * 对一份合法文件，结果与 pi 逐条相同 —— 这是测试守住的不变量。
 */
import type { HarnessV3CompactionEntry, HarnessV3Entry, HarnessV3Header } from './types'

/** 读取过程中跳过或兜底的一处问题（只读查看不因它失败，但要能说清楚少了什么） */
export interface HarnessV3Issue {
  /** 物理行号（1 起）；与具体行无关的问题为 0 */
  line: number
  reason: string
}

export interface ParsedHarnessV3Session {
  header: HarnessV3Header
  /** 全部条目，文件顺序（含 leaf 条目） */
  entries: HarnessV3Entry[]
  /** 当前位置：null = 根之前（没有条目，或回退到了第一条之前） */
  leafId: string | null
  issues: HarnessV3Issue[]
}

/** 会话头不可读：这份文本根本不是 v3 会话树 */
export class HarnessV3FormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HarnessV3FormatError'
  }
}

function parseHeader(line: string | undefined): HarnessV3Header {
  if (line === undefined) throw new HarnessV3FormatError('missing session header')
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new HarnessV3FormatError('first line is not a valid session header')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new HarnessV3FormatError('first line is not a valid session header')
  }
  const h = parsed as Partial<HarnessV3Header> & Record<string, unknown>
  if (h.type !== 'session')
    throw new HarnessV3FormatError('first line is not a valid session header')
  if (h.version !== 3) throw new HarnessV3FormatError('unsupported session version')
  if (typeof h.id !== 'string' || !h.id)
    throw new HarnessV3FormatError('session header is missing id')
  const metadata =
    typeof h.metadata === 'object' && h.metadata !== null && !Array.isArray(h.metadata)
      ? (h.metadata as Record<string, unknown>)
      : undefined
  return {
    type: 'session',
    version: 3,
    id: h.id,
    timestamp: typeof h.timestamp === 'string' ? h.timestamp : '',
    cwd: typeof h.cwd === 'string' ? h.cwd : '',
    ...(typeof h.parentSession === 'string' ? { parentSession: h.parentSession } : {}),
    ...(metadata ? { metadata } : {})
  }
}

/** 一行条目的结构校验，与 pi 的 parseEntryLine 同一套必填项；不合格返回原因 */
function entryProblem(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return 'is not a valid session entry'
  const e = parsed as Record<string, unknown>
  if (typeof e.type !== 'string') return 'is missing entry type'
  if (typeof e.id !== 'string' || !e.id) return 'is missing entry id'
  if (e.parentId !== null && typeof e.parentId !== 'string') return 'has invalid parentId'
  if (typeof e.timestamp !== 'string' || !e.timestamp) return 'is missing timestamp'
  if (e.type === 'leaf' && e.targetId !== null && typeof e.targetId !== 'string') {
    return 'has invalid targetId'
  }
  return null
}

/** 把一份 `.jsonl` 文本读成头 + 条目 + 当前位置。会话头不可读时抛 {@link HarnessV3FormatError}。 */
export function parseHarnessV3Session(text: string): ParsedHarnessV3Session {
  const physical = text.split('\n')
  // 与 pi 一致：空白行不算行（文件末尾的换行、手工编辑留下的空行）
  const lines: Array<{ no: number; text: string }> = []
  physical.forEach((t, i) => {
    if (t.trim()) lines.push({ no: i + 1, text: t })
  })
  const header = parseHeader(lines[0]?.text)

  const entries: HarnessV3Entry[] = []
  const issues: HarnessV3Issue[] = []
  let leafId: string | null = null
  for (const { no, text: line } of lines.slice(1)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      issues.push({ line: no, reason: 'is not valid JSON' })
      continue
    }
    const problem = entryProblem(parsed)
    if (problem) {
      issues.push({ line: no, reason: problem })
      continue
    }
    const entry = parsed as HarnessV3Entry
    entries.push(entry)
    leafId = entry.type === 'leaf' ? entry.targetId : entry.id
  }
  return { header, entries, leafId, issues }
}

/**
 * 当前分支：从 leaf 走到根，按根 → 叶返回（与 pi 的 `getPathToRoot` 同序）。
 *
 * 宽容兜底（pi 在这些情况下直接抛错、整个会话打不开）：
 *  - leaf 指向不存在的条目 → 退回最后一条非 leaf 条目，记 issue；
 *  - 某个父条目缺失 → 分支停在那里（只显示缺口之后的部分），记 issue；
 *  - 父链成环（坏文件）→ 在重复处停下，记 issue。
 */
export function branchOf(session: ParsedHarnessV3Session): HarnessV3Entry[] {
  const byId = new Map(session.entries.map((e) => [e.id, e]))
  let startId = session.leafId
  if (startId === null) return []
  if (!byId.has(startId)) {
    session.issues.push({ line: 0, reason: `leaf points at missing entry ${startId}` })
    const fallback = [...session.entries].reverse().find((e) => e.type !== 'leaf')
    if (!fallback) return []
    startId = fallback.id
  }
  const path: HarnessV3Entry[] = []
  const seen = new Set<string>()
  let current = byId.get(startId)
  while (current) {
    if (seen.has(current.id)) {
      session.issues.push({ line: 0, reason: `parent chain loops at ${current.id}` })
      break
    }
    seen.add(current.id)
    path.push(current)
    if (!current.parentId) break
    const parent = byId.get(current.parentId)
    if (!parent) {
      session.issues.push({ line: 0, reason: `entry ${current.parentId} not found` })
      break
    }
    current = parent
  }
  return path.reverse()
}

/**
 * 压缩过滤 —— pi 0.80.10 `defaultContextEntryTransform` 的逐行副本。
 *
 * 只认分支上最后一条 compaction：之前的 compaction 已经被它的摘要吸收了。
 * `firstKeptEntryId` 不在它之前的分支上时，pi 的行为是「之前一条都不保留」，这里照做。
 */
export function contextEntriesOf(path: readonly HarnessV3Entry[]): HarnessV3Entry[] {
  let compaction: HarnessV3CompactionEntry | null = null
  for (const entry of path) {
    if (entry.type === 'compaction') compaction = entry
  }
  if (!compaction) return [...path]
  const keptBefore = compaction
  const entries: HarnessV3Entry[] = [keptBefore]
  const compactionIdx = path.findIndex((e) => e.type === 'compaction' && e.id === keptBefore.id)
  let foundFirstKept = false
  for (let i = 0; i < compactionIdx; i++) {
    const entry = path[i]
    if (entry.id === keptBefore.firstKeptEntryId) foundFirstKept = true
    if (foundFirstKept) entries.push(entry)
  }
  for (let i = compactionIdx + 1; i < path.length; i++) entries.push(path[i])
  return entries
}

/** 分支上最后一次的运行配置（与桌面 `readSessionRunConfig` 同口径：只看显式的切换条目） */
export interface HarnessV3RunConfig {
  provider: string | null
  model: string | null
  thinkingLevel: string | null
}

export function runConfigOf(path: readonly HarnessV3Entry[]): HarnessV3RunConfig {
  const config: HarnessV3RunConfig = { provider: null, model: null, thinkingLevel: null }
  for (const entry of path) {
    if (entry.type === 'model_change') {
      config.provider = entry.provider
      config.model = entry.modelId
    } else if (entry.type === 'thinking_level_change') {
      config.thinkingLevel = entry.thinkingLevel
    }
  }
  return config
}

/** 一条旧会话「打开来看」所需的全部：头、当前上下文条目、运行配置、读取问题 */
export interface HarnessV3Transcript {
  header: HarnessV3Header
  contextEntries: HarnessV3Entry[]
  runConfig: HarnessV3RunConfig
  issues: HarnessV3Issue[]
}

export function readHarnessV3Transcript(text: string): HarnessV3Transcript {
  const session = parseHarnessV3Session(text)
  const path = branchOf(session)
  return {
    header: session.header,
    contextEntries: contextEntriesOf(path),
    runConfig: runConfigOf(path),
    issues: session.issues
  }
}
