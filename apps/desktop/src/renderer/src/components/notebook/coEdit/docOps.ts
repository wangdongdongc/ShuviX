/**
 * 协作编辑的纯函数部分 —— 不碰 CM6 视图，只拿字符串算（doc_edit / doc_insert 落在哪由 chat-protocol
 * liveDocument.ts 的 planDocChange 定：主进程的磁盘回落用同一套规则）：
 *  - 生成期间的参数 JSON 还没写完时，能先取出哪些字段（画虚影用）；
 *  - 自 agent 上次读以来用户改了什么（给它的统一 diff）；
 *  - 别的程序写了盘时，怎么把那次改动并进正在编辑的缓冲（三方合并）。
 */
import { diffChars, diffWordsWithSpace, structuredPatch } from 'diff'
import { ChangeSet } from '@codemirror/state'

// ─── 流式参数 ────────────────────────────────────────────

/**
 * 从还没写完的参数 JSON 里取一个字符串字段：`{"find": "abc`  → `{ value: 'abc', complete: false }`。
 * 只认顶层的 `"key": "…"`；转义按 JSON 规则解（半截的 \uXXXX 先丢掉，等下一次增量补齐）。
 * 没出现过这个键返回 undefined。
 */
export function partialJsonString(
  json: string,
  key: string
): { value: string; complete: boolean } | undefined {
  const keyPattern = new RegExp(`"${key}"\\s*:\\s*"`, 'g')
  let match: RegExpExecArray | null
  let start = -1
  while ((match = keyPattern.exec(json))) {
    if (isTopLevelKey(json, match.index)) {
      start = match.index + match[0].length
      break
    }
  }
  if (start < 0) return undefined
  let value = ''
  for (let i = start; i < json.length; i++) {
    const ch = json[i]
    if (ch === '"') return { value, complete: true }
    if (ch !== '\\') {
      value += ch
      continue
    }
    const next = json[i + 1]
    if (next === undefined) break
    if (next === 'u') {
      const hex = json.slice(i + 2, i + 6)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break
      value += String.fromCharCode(parseInt(hex, 16))
      i += 5
      continue
    }
    const simple: Record<string, string> = {
      n: '\n',
      t: '\t',
      r: '\r',
      b: '\b',
      f: '\f',
      '"': '"',
      '\\': '\\',
      '/': '/'
    }
    value += simple[next] ?? next
    i += 1
  }
  return { value, complete: false }
}

/** `"key"` 出现的位置是不是顶层对象的键（不在某个字符串值里、也不在嵌套对象里） */
function isTopLevelKey(json: string, keyQuoteIndex: number): boolean {
  let depth = 0
  let inString = false
  for (let i = 0; i < keyQuoteIndex; i++) {
    const ch = json[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
  }
  return !inString && depth === 1
}

// ─── 给 agent 的「用户改了什么」 ─────────────────────────

/** 用户修改的 diff 上限（字符）—— 改得太多就截断，并提示它读全文 */
const MAX_USER_CHANGES_CHARS = 6000

/**
 * 自 agent 上次读到的 `before` 到现在的 `after`，用户改了什么：统一 diff 的 hunk（不含文件头）。
 * 没有改动返回 undefined。
 */
export function userChangesPatch(before: string, after: string): string | undefined {
  if (before === after) return undefined
  const patch = structuredPatch('document', 'document', before, after, '', '', { context: 2 })
  const lines: string[] = []
  for (const hunk of patch.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue // "\ No newline at end of file"
      lines.push(line)
    }
  }
  if (lines.length === 0) return undefined
  const text = lines.join('\n')
  if (text.length <= MAX_USER_CHANGES_CHARS) return text
  return `${text.slice(0, MAX_USER_CHANGES_CHARS)}\n… (more changes; the document above is current)`
}

// ─── 外部写盘的三方合并 ──────────────────────────────────

/** 一处改动（位置都在「改动前」的文本里） */
export interface TextChange {
  from: number
  to: number
  insert: string
}

/**
 * from → to 的改动，写成 CM6 能直接收的 {from, to, insert} 列表（位置都在 from 里）。
 * `words` 按词（含空白）切分 —— 合并时用它，免得一处删除从一个词中间穿过去。
 */
export function diffToChanges(
  from: string,
  to: string,
  granularity: 'chars' | 'words' = 'chars'
): TextChange[] {
  const changes: TextChange[] = []
  let pos = 0
  let pending: TextChange | null = null
  const flush = (): void => {
    if (pending) changes.push(pending)
    pending = null
  }
  const parts = granularity === 'words' ? diffWordsWithSpace(from, to) : diffChars(from, to)
  for (const part of parts) {
    if (part.added) {
      pending = pending ?? { from: pos, to: pos, insert: '' }
      pending.insert += part.value
    } else if (part.removed) {
      pending = pending ?? { from: pos, to: pos, insert: '' }
      pos += part.value.length
      pending.to = pos
    } else {
      flush()
      pos += part.value.length
    }
  }
  flush()
  return changes
}

/**
 * 三方合并：别的程序把磁盘从 `base` 改成了 `disk`，而编辑器缓冲此刻是 `ours`（base 之上还有用户
 * 没存盘的输入）。返回能直接派发到 `ours` 上的改动。
 *
 * 规则只有一条：**撞上用户正在改的地方，用户的版本赢**。磁盘那边与用户的某处改动重叠（含紧挨着）
 * 的改动整段丢掉，其余的映射过用户的改动后落下 —— 于是不会把同一处改动做两遍（两边改成一样时
 * 什么也不发生），也不会让一处删除从用户刚打的字中间穿过去。丢掉的那部分随后被自动保存用编辑器
 * 的版本写回，磁盘与编辑器重新一致。按词切分，改动的边界落在词边上。
 */
export function mergeExternalChange(base: string, ours: string, disk: string): ChangeSet {
  if (disk === ours) return ChangeSet.empty(ours.length)
  const theirs = diffToChanges(base, disk, 'words')
  if (ours === base) return ChangeSet.of(theirs, base.length)
  const mine = ChangeSet.of(diffToChanges(base, ours, 'words'), base.length)
  const mineRanges: Array<[number, number]> = []
  mine.iterChangedRanges((fromA, toA) => mineRanges.push([fromA, toA]))
  const kept = theirs.filter(
    (change) => !mineRanges.some(([from, to]) => change.from <= to && change.to >= from)
  )
  return ChangeSet.of(kept, base.length).map(mine)
}
