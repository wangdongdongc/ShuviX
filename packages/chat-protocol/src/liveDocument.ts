/**
 * 协作编辑（live document）—— 笔记本会话的 agent 与用户同时编辑同一份 md 的请求 / 结果契约。
 *
 * 场景：每一条笔记本会话（主窗口 / 固定窗口里打开的笔记、从系统或应用里打开的 md 窗口）。只要有窗口
 * 正显示着这条会话的编辑器，**编辑器里的那份内容才是事实源**（磁盘只是它的存档，由编辑器的自动保存写）。
 * agent 不经文件工具改盘，而是用 `doc_*` 工具：主进程把请求转给那个窗口的渲染进程，在编辑器的当前
 * 缓冲上当场执行 —— 按原文定位、一次落下、不进用户的撤销栈；用户正在那一段打字就等他停手。于是没有
 * 「写盘 → 重载」，也就没有互相覆盖。没有窗口显示它（切到了别的会话、网页客户端、后台在跑）时，同一组
 * 工具按同样的定位规则直接改磁盘上的文件（主进程的磁盘回落）。
 *
 * 类型、常量与纯函数，两个进程共用；执行在渲染进程（desktop renderer components/notebook/coEdit/），转发与
 * 磁盘回落在主进程（desktop services/liveDocumentBridge.ts、tools/doc.ts）。
 */

/** 三个协作编辑工具的名字（工具名也是渲染端识别流式参数、画虚影的依据） */
export const DOC_READ_TOOL = 'doc_read'
export const DOC_EDIT_TOOL = 'doc_edit'
export const DOC_INSERT_TOOL = 'doc_insert'

export type LiveDocOp =
  | { kind: 'read' }
  | {
      kind: 'edit'
      /** 这次工具调用的 id —— 渲染端据此收掉生成期间画的那个虚影 */
      toolCallId: string
      find: string
      replace: string
    }
  | {
      kind: 'insert'
      toolCallId: string
      text: string
      /** 插在这段原文之后（与 before 互斥；都不给 = 文末） */
      after?: string
      /** 插在这段原文之前 */
      before?: string
    }

/** 主进程 → 渲染进程 */
export interface LiveDocRequest {
  requestId: string
  sessionId: string
  /**
   * 收这次请求的那一个编辑器（它挂接时自己取的随机 id）。同一窗口里可能先后挂着同一条会话的两个编辑器
   * （重挂载的交接），只有这一个执行。
   */
  attachId: string
  op: LiveDocOp
}

/** 用户此刻在哪、在干什么（doc_read 附带给 agent） */
export interface LiveDocUserContext {
  /** 光标所在行（1 起） */
  cursorLine: number
  /** 光标所在的最近一级标题（原样，如 `## 安装`）；文首之前没有标题时缺省 */
  section?: string
  /** 选中的文字（截断过）；没有选区时缺省 */
  selection?: string
  /** 屏幕上可见的行（1 起，闭区间） */
  visibleFromLine: number
  visibleToLine: number
  /** 距离用户上一次改动文字过了多少毫秒；打开以来没改过为 null */
  lastEditAgoMs: number | null
}

export type LiveDocResult =
  | {
      ok: true
      kind: 'read'
      /** 编辑器里此刻的全文（含尚未存盘的输入）；磁盘回落时是文件内容（行尾统一为 LF） */
      text: string
      /** 用户在哪、在干什么；磁盘回落（没有编辑器开着）时缺省 */
      user?: LiveDocUserContext
      /**
       * 自 agent 上次 doc_read 以来用户做的改动（统一 diff，已截断）；首次读取或没有改动时缺省。
       * agent 自己的修改不算在内。
       */
      userChanges?: string
    }
  | {
      ok: true
      kind: 'edit' | 'insert'
      /** 改动落下后所在的行（1 起） */
      line: number
      /** 落点附近的当前文本（几行），让 agent 不必为确认再读一遍全文 */
      context: string
      /** 为等用户停手而延后的毫秒数（没等为 0） */
      waitedMs: number
      /** 改动落下后的全文 —— 主进程拿它做契约 md 的校验回执（编辑器里的改动不经写盘钩子） */
      text: string
    }
  | { ok: false; error: string }

// ─── 定位（纯函数：编辑器与磁盘回落共用一套规则） ─────────

/** needle 在 doc 里出现的所有起点（允许重叠 —— 「aa」在「aaa」里算两处，定位必须唯一） */
export function occurrences(doc: string, needle: string, limit = 10): number[] {
  const found: number[] = []
  if (!needle) return found
  let from = 0
  while (found.length < limit) {
    const at = doc.indexOf(needle, from)
    if (at < 0) break
    found.push(at)
    from = at + 1
  }
  return found
}

export type DocChangePlan =
  | { ok: true; from: number; to: number; insert: string }
  | { ok: false; error: string }

function locate(
  doc: string,
  needle: string,
  what: string
): { ok: true; at: number } | { ok: false; error: string } {
  const hits = occurrences(doc, needle, 2)
  if (hits.length === 0) {
    return {
      ok: false,
      error:
        `${what} does not match the current document. The user may have just changed that passage — ` +
        'call doc_read and use the text as it is now.'
    }
  }
  if (hits.length > 1) {
    const count = occurrences(doc, needle).length
    return {
      ok: false,
      error: `${what} matches ${count >= 10 ? '10 or more' : count} places in the current document; include more of the surrounding text so it matches exactly one.`
    }
  }
  return { ok: true, at: hits[0] }
}

/** 一次 doc_edit / doc_insert 在当前文本上落在哪、换成什么 */
export function planDocChange(
  doc: string,
  op: Exclude<LiveDocOp, { kind: 'read' }>
): DocChangePlan {
  if (op.kind === 'edit') {
    if (!op.find) return { ok: false, error: '`find` is empty.' }
    const hit = locate(doc, op.find, '`find`')
    if (!hit.ok) return hit
    return { ok: true, from: hit.at, to: hit.at + op.find.length, insert: op.replace }
  }
  if (op.after !== undefined && op.before !== undefined) {
    return { ok: false, error: 'Give `after` or `before`, not both.' }
  }
  if (op.after !== undefined) {
    const hit = locate(doc, op.after, '`after`')
    if (!hit.ok) return hit
    const at = hit.at + op.after.length
    return { ok: true, from: at, to: at, insert: op.text }
  }
  if (op.before !== undefined) {
    const hit = locate(doc, op.before, '`before`')
    if (!hit.ok) return hit
    return { ok: true, from: hit.at, to: hit.at, insert: op.text }
  }
  return { ok: true, from: doc.length, to: doc.length, insert: op.text }
}

/** 落点附近最多给几行上下文 */
const CHANGE_CONTEXT_MAX_LINES = 25

/**
 * 改动落下之后，告诉 agent 新内容从哪一行开始、那里现在是什么样（带行号的几行），免得它为确认再读全文。
 * `after` 是改动之后的全文，`plan` 是落下的那一处（位置在改动之前的文本里，起点两边一致）。
 */
export function describeDocChange(
  after: string,
  plan: { from: number; insert: string }
): { line: number; context: string } {
  const lines = after.split('\n')
  const lineAt = (pos: number): number => {
    let n = 1
    const end = Math.min(pos, after.length)
    for (let i = 0; i < end; i++) if (after.charCodeAt(i) === 10) n++
    return n
  }
  // 报「新内容从哪一行开始」：插入常以换行开头（接在锚点之后），跳过那几个换行
  const leading = /^\n*/.exec(plan.insert)?.[0].length ?? 0
  const line = lineAt(plan.from + leading)
  const lastLine = lineAt(plan.from + plan.insert.length)
  const fromLine = Math.max(1, lineAt(plan.from) - 1)
  const toLine = Math.min(
    lines.length,
    Math.max(lastLine + 1, fromLine),
    fromLine + CHANGE_CONTEXT_MAX_LINES - 1
  )
  const width = String(toLine).length
  const context: string[] = []
  for (let n = fromLine; n <= toLine; n++) {
    context.push(`${String(n).padStart(width, ' ')}│${lines[n - 1]}`)
  }
  return { line, context: context.join('\n') }
}
