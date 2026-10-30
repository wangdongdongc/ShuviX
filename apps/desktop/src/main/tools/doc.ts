/**
 * 协作编辑工具 —— doc_read / doc_edit / doc_insert（基座 `notebook` 的文档面）。
 *
 * 与 read / edit / write 的区别不在参数，在**落点**：有编辑器显示着这条笔记本会话的文档时，它们不碰磁盘，
 * 而是经 liveDocumentBridge 交给那个编辑器，在它的当前缓冲上当场执行 —— 用户刚打的、还没存盘的字也在
 * 里面；修改按原文定位、一次落下、不进用户的撤销栈，用户正在那一段打字就等他停手（规则在渲染端
 * components/notebook/coEdit/）。写盘由编辑器的自动保存统一做，所以没有「agent 写盘 → 编辑器重载」那一步，
 * 也就没有互相覆盖。
 *
 * 没有编辑器显示它（主窗口切到了别的会话、网页客户端、后台在跑）时是**磁盘回落**：同一套定位规则
 * （chat-protocol planDocChange）直接改文件，写入走 write 工具同一条流程（读后被改守卫、写前询问、
 * 契约 md 回执、知识库盖章与提交、files.changed）—— 之后谁打开它，编辑器读到的就是新内容；开着的
 * 网页编辑器经三方合并把它并进来。
 *
 * 三个工具而不是一个带 action 的：每个都有自己必填的参数，模型不必在一张大 schema 里挑；
 * 渲染端也按工具名就知道正在生成的这次调用要画什么虚影。
 *
 * 目标文档恒取 ToolContext.sessionId 那条笔记本会话的文档 —— 刻意不收路径参数：这组工具只改「这一份」。
 * 操作失败（原文对不上、匹配多处）以抛错结束：pi 只把抛出的调用记为失败，步骤行才会是红的。
 */
import { Type, type Static } from 'typebox'
import { basename } from 'path'
import type { ToolCallScope, ToolResult } from '@shuvix/agent-runtime'
import {
  BaseTool,
  callOwnerOf,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  reviewShuvixMdWrite,
  stripBom,
  validateShuvixMdText,
  writeFileContent
} from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import {
  DOC_EDIT_TOOL,
  DOC_INSERT_TOOL,
  DOC_READ_TOOL,
  describeDocChange,
  planDocChange,
  type LiveDocOp,
  type LiveDocResult,
  type LiveDocUserContext
} from '@shuvix/chat-protocol/liveDocument'
import { detectShuvixMarker } from '@shuvix/chat-protocol/shuvixMdContract'
import { isParsedShuvixFileKind, type ShuvixFileKind } from '@shuvix/chat-protocol/shuvixFileNotes'
import { registerBuiltinTool } from '../services/toolRegistry'
import {
  getDesktopSecurityContext,
  resolveSessionDocument,
  sessionDocumentKind,
  TOOL_ABORTED,
  type ToolContext
} from '../services/toolContext'
import { requestLiveDocument } from '../services/liveDocumentBridge'
import { agentActorOf, withCallAgent } from '../services/toolAgent'
import { nodeFileSystemPort } from '../utils/toolUtils/nodeFileSystemPort'
import { recordRead } from '../utils/toolUtils/fileTime'
import { bundleRelOf, makeDesktopFileToolDeps } from './fileToolDeps'
import { t } from '../i18n'

/** 一次读回来的正文上限（字符）—— md 文档很少到这个量级，到了就截断并说明 */
const MAX_READ_CHARS = 200_000

const MARKDOWN_RE = /\.(md|markdown|mdx)$/i

// ─── 描述与参数 ──────────────────────────────────────────

const DOC_READ_DESCRIPTION = `Read this notebook's document exactly as it is right now — when the user has it open in an editor, that includes what they typed a moment ago and have not saved. Lines are numbered for reference only (the prefix is not part of the text).

When it is open in an editor, also reports where the user is: the line and section their cursor is in, their selection, the lines on their screen, how long since they last typed, and the edits made since your previous doc_read — by the user, or by another program that changed the file (your own edits are not listed).

When the document is a ShuviX agent, bot, policy or hook file, also says whether ShuviX can parse it right now, and why not.

Call it before your first edit and whenever you need text you have not seen since. Never use \`read\` on this document: the file on disk can lag behind the editor.`

const DOC_EDIT_DESCRIPTION = `Replace one passage of the shared document.

- \`find\`: text that occurs exactly once in the current document, copied verbatim from doc_read (without the line-number prefix). If a short phrase repeats, include some of its surrounding text.
- \`replace\`: the new text for that passage.

When the document is open in an editor, the user sees a preview at that spot while you write this call, and the change lands in one step when it runs; if they are typing in that passage right then, the edit waits until they pause (up to about ten seconds). Keep each call to one passage; several focused edits read better than one sweeping rewrite.

If \`find\` no longer matches — usually because the user just changed that text — the call fails and tells you so: doc_read again and work from what is there now.`

const DOC_INSERT_DESCRIPTION = `Insert new text into the shared document without replacing anything.

- \`text\`: inserted verbatim, so include the line breaks that separate it from its neighbours (for example start with "\\n\\n" to add a paragraph after one).
- \`after\` or \`before\` (optional, not both): text that occurs exactly once in the current document; the new text goes right after or right before it. With neither, the text is appended at the end of the document.

Like doc_edit, an open editor shows a preview while you write the call and the insertion lands in one step; it waits for the user to pause if they are typing right at that spot.`

const DocReadParamsSchema = Type.Object({})

const DocEditParamsSchema = Type.Object({
  find: Type.String({
    description:
      'Text to replace. Must occur exactly once in the current document; copy it verbatim from doc_read.'
  }),
  replace: Type.String({ description: 'The new text for that passage.' })
})

// 锚点排在 text 之前：模型大多按 schema 顺序写参数，锚点先到，虚影一开始就落在对的位置
const DocInsertParamsSchema = Type.Object({
  after: Type.Optional(
    Type.String({
      description: 'Insert right after this text (must occur exactly once). Omit to append.'
    })
  ),
  before: Type.Optional(
    Type.String({
      description: 'Insert right before this text (must occur exactly once). Omit to append.'
    })
  ),
  text: Type.String({
    description: 'Text to insert, verbatim (include separating line breaks).'
  })
})

// ─── 结果文本 ────────────────────────────────────────────

function numbered(text: string, firstLine = 1): string {
  const lines = text.split('\n')
  const width = String(firstLine + lines.length - 1).length
  return lines.map((line, i) => `${String(firstLine + i).padStart(width, ' ')}│${line}`).join('\n')
}

function describeUser(user: LiveDocUserContext): string {
  const parts = [
    `cursor on line ${user.cursorLine}${user.section ? ` (in section "${user.section}")` : ''}`
  ]
  if (user.selection) parts.push(`selected text: ${JSON.stringify(user.selection)}`)
  parts.push(`on screen: lines ${user.visibleFromLine}–${user.visibleToLine}`)
  if (user.lastEditAgoMs === null) parts.push('has not typed since the document opened')
  else parts.push(`last typed ${formatAgo(user.lastEditAgoMs)} ago`)
  return `The user: ${parts.join('; ')}.`
}

function formatAgo(ms: number): string {
  if (ms < 1000) return 'under a second'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`
  const h = Math.round(m / 60)
  return `${h} hour${h === 1 ? '' : 's'}`
}

/** 磁盘回落时 doc_read 的那句话（没有编辑器，也就没有光标、选区与最近的输入可报） */
const NOT_OPEN_NOTE =
  'The document is not open in an editor right now: this is the saved file, and your changes are written to it directly.'

export function formatReadResult(
  result: Extract<LiveDocResult, { kind: 'read' }>,
  /** 契约 md 此刻的解析判定（parseVerdictOf）；不是契约 md 就没有 */
  verdict?: string | null
): string {
  let text = result.text
  let note = ''
  if (text.length > MAX_READ_CHARS) {
    text = text.slice(0, MAX_READ_CHARS)
    note = `\n(Truncated after ${MAX_READ_CHARS} characters.)`
  }
  const lineCount = text.split('\n').length
  const blocks = [
    `<document lines="${lineCount}">\n${numbered(text)}${note}\n</document>`,
    result.user ? describeUser(result.user) : NOT_OPEN_NOTE
  ]
  if (result.userChanges) {
    blocks.push(
      `<user_edits_since_your_last_read>\n${result.userChanges}\n</user_edits_since_your_last_read>`
    )
  }
  if (verdict) blocks.push(verdict)
  return blocks.join('\n\n')
}

/** 按某一种契约解析全文：判定那段话，以及它是不是「没事」（合法且没有警告） */
function judgeDocument(
  kind: ShuvixFileKind,
  doc: string,
  text: string
): { text: string; clean: boolean } {
  const validation = validateShuvixMdText(kind, text, basename(doc).replace(MARKDOWN_RE, ''))
  const reasons = (messages: string[]): string =>
    (messages.length ? messages : ['(the parser gave no reason)']).map((m) => `- ${m}`).join('\n')
  if (validation.status === 'invalid') {
    const file = `${kind === 'agent' ? 'an' : 'a'} ${kind} file`
    return {
      clean: false,
      text: `Parse check: ShuviX cannot parse this document as ${file}, so it is ignored until it is fixed:\n${reasons(validation.messages)}`
    }
  }
  if (validation.messages.length > 0) {
    return {
      clean: false,
      text: `Parse check: ShuviX parses this document as a valid ${kind} file, with warnings:\n${reasons(validation.messages)}`
    }
  }
  return { clean: true, text: `Parse check: ShuviX parses this document as a valid ${kind} file.` }
}

/**
 * doc_read 附带的那句判定：文档是宿主据以运行的契约 md 时，说 ShuviX 此刻能不能解析它（以及解析器的警告）。
 * 编辑之后的回执早就有（liveDiagnostics / 写后处理），缺的是**动手之前** —— 用户问「我这条策略怎么没生效」，
 * agent 一读就该知道文件根本解析不过、原因是哪句，而不是先改一刀才看到。
 *
 * 种类先看承载项目（策略目录里的文件就按策略判 —— 标记在读时可选，没写标记照样生效；写到一半标记
 * 也可能暂时没了），不是 ShuviX 文件的载体再看文件自己的 `shuvix:` 标记。校验的是全文（读回的正文可能被截断）。
 */
export function parseVerdictOf(sessionId: string, doc: string, text: string): string | null {
  if (!MARKDOWN_RE.test(doc)) return null
  const kind = sessionDocumentKind(sessionId) ?? detectShuvixMarker(text)?.type ?? null
  if (!isParsedShuvixFileKind(kind)) return null
  return judgeDocument(kind, doc, text).text
}

/**
 * 编辑回执按承载项目校正：写后处理（reviewShuvixMdWrite）只认文件自己的标记，而策略 / hook / agent / bot
 * 目录里的文件没写标记照样生效 —— 标记缺了或是别家的契约时，回执会按错的身份判（或什么都不说），笔记本
 * 提示词却告诉 agent「每次改动都会说它还能不能解析」。这时换成按承载项目那一种判，照回执的老规矩
 * 没事不吭声；标记与承载项目一致就原样交回写后处理的那段话。判定出错时也原样交回 —— 回执只是附言。
 */
function receiptForCarrier(
  sessionId: string,
  doc: string,
  text: string,
  note: string | null
): string | null {
  try {
    const kind = sessionDocumentKind(sessionId)
    if (!isParsedShuvixFileKind(kind) || !MARKDOWN_RE.test(doc)) return note
    if (detectShuvixMarker(text)?.type === kind) return note
    const verdict = judgeDocument(kind, doc, text)
    return verdict.clean ? null : verdict.text
  } catch {
    return note
  }
}

function formatWriteResult(
  result: Extract<LiveDocResult, { kind: 'edit' | 'insert' }>,
  note: string | null
): string {
  const verb = result.kind === 'edit' ? 'Replaced' : 'Inserted'
  const waited =
    result.waitedMs > 0
      ? ` (waited ${formatAgo(result.waitedMs)} for the user to pause typing there)`
      : ''
  const text = `${verb} at line ${result.line}${waited}. The text there now:\n${result.context}`
  return note ? `${text}\n\n${note}` : text
}

/** 这条会话的文档；不是笔记本会话就抛（doc_* 只认这一份） */
function sessionDocument(ctx: ToolContext): string {
  const doc = resolveSessionDocument(ctx.sessionId)
  if (!doc) throw new Error('This session has no document to read or change.')
  return doc
}

/**
 * 编辑器里落下的改动不经写盘钩子，契约 md（agent / bot / 知识库条目 …）写坏了没人告诉 agent ——
 * 这里拿改动后的全文做一遍同样的校验，只要诊断的话（不补字段、不盖章：落盘归编辑器的自动保存）。
 */
function liveDiagnostics(
  ctx: ToolContext,
  text: string,
  call: ToolCallScope | undefined
): string | null {
  const doc = resolveSessionDocument(ctx.sessionId)
  if (!doc || !MARKDOWN_RE.test(doc)) return null
  try {
    const rel = bundleRelOf(doc)
    const now = new Date()
    return (
      reviewShuvixMdWrite(text, basename(doc).replace(MARKDOWN_RE, ''), {
        sessionId: ctx.sessionId,
        today: now.toISOString().slice(0, 10),
        knowledge:
          rel !== null
            ? { rel, actor: agentActorOf(withCallAgent(ctx, call)), now: now.toISOString() }
            : undefined,
        diagnoseOnly: true
      })?.note ?? null
    )
  } catch {
    return null
  }
}

/** 磁盘上的文档：去掉 BOM、行尾统一成 LF（编辑器里也是 LF —— 模型照抄的原文才对得上） */
async function readDocumentFile(
  ctx: ToolContext,
  doc: string
): Promise<{ text: string; bom: string; eol: '\r\n' | '\n' }> {
  let raw: string
  try {
    raw = await nodeFileSystemPort.readFile(doc)
  } catch (err) {
    throw new Error(
      `Could not read the document file ${doc}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  // 记下读取时间：随后的写入经 write 的读后被改守卫 —— 这之间文件被别人改了就不覆盖
  recordRead(ctx.sessionId, doc)
  const { bom, text } = stripBom(raw)
  return { text: normalizeToLF(text), bom, eol: detectLineEnding(text) }
}

abstract class DocTool<
  T extends typeof DocReadParamsSchema | typeof DocEditParamsSchema | typeof DocInsertParamsSchema
> extends BaseTool<T> {
  constructor(protected readonly ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    /*
     * no-op —— 门按这次走哪条路分开过（见 run）：交给编辑器之前按会话权限表判这次读 / 写；磁盘回落的
     * 读在 onDisk 里判，写在 writeFileContent 里照常过带 diff 预览的写前询问
     */
  }

  /**
   * 这份文档的读 / 写过会话权限表（经安全策略）：笔记本会话的文档是权限表里一行（来源 document，缺省可写，
   * 用户可改成只读），在表里就不问；改成只读或被用户策略拦下就问 / 拒。
   */
  protected gate(
    mode: 'read' | 'write',
    toolCallId: string,
    signal: AbortSignal | undefined,
    call: ToolCallScope | undefined
  ): Promise<void> {
    const doc = sessionDocument(this.ctx)
    return getDesktopSecurityContext(this.ctx).enforcePath(mode, doc, {
      toolCallId,
      ...callOwnerOf(call),
      toolName: this.name,
      displayPath: doc,
      abortError: TOOL_ABORTED,
      signal
    })
  }

  /**
   * 交给编辑器执行，没有编辑器就走磁盘；操作失败翻译成抛错（步骤行红、模型看到原因）。
   * 写入类的结果另带一段回执：编辑器里的改动是契约 md 的诊断，磁盘上的是写后处理的那段话。
   */
  protected async run(
    op: LiveDocOp,
    toolCallId: string,
    signal: AbortSignal | undefined,
    call: ToolCallScope | undefined
  ): Promise<{ result: LiveDocResult & { ok: true }; note: string | null }> {
    let diskNote: string | null | undefined
    const result = await requestLiveDocument(
      this.ctx.sessionId,
      op,
      signal,
      async () => {
        const r = await this.onDisk(op, toolCallId, signal, call)
        diskNote = r.note
        return r.result
      },
      () => this.gate(op.kind === 'read' ? 'read' : 'write', toolCallId, signal, call)
    )
    if (!result.ok) throw new Error(result.error)
    if (result.kind === 'read') return { result, note: null }
    const note = diskNote !== undefined ? diskNote : liveDiagnostics(this.ctx, result.text, call)
    const doc = resolveSessionDocument(this.ctx.sessionId)
    return {
      result,
      note: doc ? receiptForCarrier(this.ctx.sessionId, doc, result.text, note) : note
    }
  }

  /** 磁盘回落：同一套定位规则，写入走 write 工具同一条流程 */
  private async onDisk(
    op: LiveDocOp,
    toolCallId: string,
    signal: AbortSignal | undefined,
    call: ToolCallScope | undefined
  ): Promise<{ result: LiveDocResult; note: string | null }> {
    const doc = sessionDocument(this.ctx)
    // 读盘也是读：过会话权限表（写入的门在 writeFileContent 里，带 diff 预览）
    await this.gate('read', toolCallId, signal, call)
    const file = await readDocumentFile(this.ctx, doc)
    if (op.kind === 'read')
      return { result: { ok: true, kind: 'read', text: file.text }, note: null }
    const plan = planDocChange(file.text, op)
    if (!plan.ok) return { result: plan, note: null }
    // 读盘期间被中止：不写（没有询问可等时，写入流程里没有别的地方会看 signal）
    if (signal?.aborted) throw new Error('Aborted.')
    const after = file.text.slice(0, plan.from) + plan.insert + file.text.slice(plan.to)
    const { note } = await writeFileContent(makeDesktopFileToolDeps(this.ctx), {
      toolCallId,
      toolName: this.name,
      path: doc,
      portPath: doc,
      content: file.bom + restoreLineEndings(after, file.eol),
      signal,
      call
    })
    const where = describeDocChange(after, plan)
    return {
      result: { ok: true, kind: op.kind, ...where, waitedMs: 0, text: after },
      note
    }
  }
}

export class DocReadTool extends DocTool<typeof DocReadParamsSchema> {
  readonly name = DOC_READ_TOOL
  readonly label = t(BUILTIN_TOOL_PRESENTATIONS[DOC_READ_TOOL].labelKey)
  readonly description = DOC_READ_DESCRIPTION
  readonly parameters = DocReadParamsSchema

  protected async executeInternal(
    toolCallId: string,
    _params: Static<typeof DocReadParamsSchema>,
    signal?: AbortSignal,
    call?: ToolCallScope
  ): Promise<ToolResult<undefined>> {
    const { result } = await this.run({ kind: 'read' }, toolCallId, signal, call)
    if (result.kind !== 'read') throw new Error('Unexpected answer from the document editor.')
    let verdict: string | null = null
    try {
      verdict = parseVerdictOf(this.ctx.sessionId, sessionDocument(this.ctx), result.text)
    } catch {
      /* 判定只是附言：解析器抛错不该让一次读失败 */
    }
    return {
      content: [{ type: 'text', text: formatReadResult(result, verdict) }],
      details: undefined
    }
  }
}

export class DocEditTool extends DocTool<typeof DocEditParamsSchema> {
  readonly name = DOC_EDIT_TOOL
  readonly label = t(BUILTIN_TOOL_PRESENTATIONS[DOC_EDIT_TOOL].labelKey)
  readonly description = DOC_EDIT_DESCRIPTION
  readonly parameters = DocEditParamsSchema

  protected async executeInternal(
    toolCallId: string,
    params: Static<typeof DocEditParamsSchema>,
    signal?: AbortSignal,
    call?: ToolCallScope
  ): Promise<ToolResult<undefined>> {
    if (!params.find)
      throw new Error('`find` is empty. To add text without replacing any, use doc_insert.')
    const { result, note } = await this.run(
      { kind: 'edit', toolCallId, find: params.find, replace: params.replace },
      toolCallId,
      signal,
      call
    )
    if (result.kind === 'read') throw new Error('Unexpected answer from the document editor.')
    return {
      content: [{ type: 'text', text: formatWriteResult(result, note) }],
      details: undefined
    }
  }
}

export class DocInsertTool extends DocTool<typeof DocInsertParamsSchema> {
  readonly name = DOC_INSERT_TOOL
  readonly label = t(BUILTIN_TOOL_PRESENTATIONS[DOC_INSERT_TOOL].labelKey)
  readonly description = DOC_INSERT_DESCRIPTION
  readonly parameters = DocInsertParamsSchema

  protected async executeInternal(
    toolCallId: string,
    params: Static<typeof DocInsertParamsSchema>,
    signal?: AbortSignal,
    call?: ToolCallScope
  ): Promise<ToolResult<undefined>> {
    // 空串锚点当作没给（模型常把「不要锚点」写成 ""）
    const after = params.after || undefined
    const before = params.before || undefined
    if (after !== undefined && before !== undefined) {
      throw new Error('Give `after` or `before`, not both.')
    }
    if (!params.text) throw new Error('`text` is empty.')
    const { result, note } = await this.run(
      {
        kind: 'insert',
        toolCallId,
        text: params.text,
        ...(after !== undefined ? { after } : {}),
        ...(before !== undefined ? { before } : {})
      },
      toolCallId,
      signal,
      call
    )
    if (result.kind === 'read') throw new Error('Unexpected answer from the document editor.')
    return {
      content: [{ type: 'text', text: formatWriteResult(result, note) }],
      details: undefined
    }
  }
}

registerBuiltinTool({
  name: DOC_READ_TOOL,
  group: 'general',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS[DOC_READ_TOOL].labelKey),
  getHint: () => t('tool.docReadHint'),
  factory: (ctx: ToolContext) => new DocReadTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS[DOC_READ_TOOL].presentation,
  describe: () => ({ description: DOC_READ_DESCRIPTION, parameters: DocReadParamsSchema })
})

registerBuiltinTool({
  name: DOC_EDIT_TOOL,
  group: 'general',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS[DOC_EDIT_TOOL].labelKey),
  getHint: () => t('tool.docEditHint'),
  factory: (ctx: ToolContext) => new DocEditTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS[DOC_EDIT_TOOL].presentation,
  describe: () => ({ description: DOC_EDIT_DESCRIPTION, parameters: DocEditParamsSchema })
})

registerBuiltinTool({
  name: DOC_INSERT_TOOL,
  group: 'general',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS[DOC_INSERT_TOOL].labelKey),
  getHint: () => t('tool.docInsertHint'),
  factory: (ctx: ToolContext) => new DocInsertTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS[DOC_INSERT_TOOL].presentation,
  describe: () => ({ description: DOC_INSERT_DESCRIPTION, parameters: DocInsertParamsSchema })
})
