/**
 * 共享文件工具套件 —— read / write / edit / move / delete 的整条执行流程（宿主无关）。
 *
 * 把桌面 tools/{read,write,edit}.ts 的 shell 逻辑收敛成一份:路径解析 → 符号链接不跟(路径本身是链接
 * 就只说出它指向哪里) → 路径询问(securityCheck) → 内核(readTextContent/readDirContent/applyWrite/
 * applyEdit) + read 的分派(url/图片/富文档/.doc/二进制/目录/纯文本)。平台差异全部经注入:
 * FileSystemPort / FileGuards / resolvePath / SecurityContext(安全模块 PEP 门面) /
 * ReadDecoders(内容解码器,可选能力函数)。
 *
 * move / delete 是不写内容的那两种改动：同一道路径门（'write'，move 的源与目标各问一次）、同一个变更回调
 * （onFileChange），所以宿主的变更管线（知识库的 git 提交、扫描缓存、files.changed）看得见改名与删除 ——
 * 不必绕去 shell。两者都要 port 的可选能力（rename / remove），没有的宿主上工具直接报不支持。
 */
import { Type } from 'typebox'
import type { ToolResult } from './toolResult'
import type {
  ReadToolDetails,
  EditToolDetails,
  WriteToolDetails
} from '@shuvix/chat-protocol/types/chatMessage'
import { BaseTool } from './baseTool'
import { callOwnerOf, type ToolCallScope } from './toolCall'
import type { FileSystemPort, FileGuards, FileStat, WriteAskHook } from '../fileTools/port'
import { readTextContent, readDirContent } from '../fileTools/read'
import { DEFAULT_MAX_LINES } from '../fileTools/truncate'
import { applyWrite } from '../fileTools/write'
import { applyEdit } from '../fileTools/edit'
import { reviewShuvixMdWrite } from '../shuvixMdWrite'
import type { AccessMode, SecurityContext } from '../security/types'
import { urlObjectOf } from '../security/urlObject'

type ReadResult = ToolResult<ReadToolDetails>

// ─── 参数 schema（两端一致；导出供工具定义枚举复用，无需实例化） ──────────────
export const ReadParamsSchema = Type.Object({
  path: Type.String({ description: 'The file path, directory path, or URL (http/https) to read' }),
  offset: Type.Optional(
    Type.Number({
      description: 'Starting line number (1-based) for paginated reading of large files'
    })
  ),
  limit: Type.Optional(
    Type.Number({ description: 'Maximum number of lines to read, used together with offset' })
  )
})
export const WriteParamsSchema = Type.Object({
  path: Type.String({ description: 'The file path to write to (relative or absolute)' }),
  content: Type.String({ description: 'The content to write to the file' })
})
export const EditParamsSchema = Type.Object({
  path: Type.String({ description: 'The file path to modify' }),
  oldText: Type.String({
    description: 'Exact text to find and replace (must match exactly, including whitespace)'
  }),
  newText: Type.String({ description: 'New text to replace with' })
})
export const MoveParamsSchema = Type.Object({
  from: Type.String({ description: 'The file or directory to move (relative or absolute)' }),
  to: Type.String({
    description: 'Its new path, name included (relative or absolute); must not exist yet'
  })
})
export const DeleteParamsSchema = Type.Object({
  path: Type.String({ description: 'The file or empty directory to delete' })
})

/** move 的缺省描述（宿主可经 deps.descriptions.move 换掉） */
export const MOVE_DESCRIPTION =
  'Move or rename a file or directory. The destination must not exist yet — move never replaces anything. Missing parent directories of the destination are created.'
/** delete 的缺省描述（宿主可经 deps.descriptions.delete 换掉） */
export const DELETE_DESCRIPTION =
  'Delete a file, or an empty directory. A directory that still has entries is refused — delete or move its contents first.'

/**
 * 文件工具改动磁盘之后的回调事件（onFileChange）。kind 与 AppEvent 'files.changed' 是同一套：write / edit
 * 写了内容，delete 删掉了一条路径。move 报成一对 —— 源路径一条 delete、紧接着目标路径一条 write ——
 * 消费方因此不必认第四种 kind：跨出 / 跨进某个范围（知识库 bundle）的挪动，两头各自按自己的位置判。
 */
export interface FileChangeEvent {
  /** 该端 port 路径 */
  portPath: string
  kind: 'write' | 'edit' | 'delete'
  /** 改动的是一整个目录（move / delete 一个目录）；缺省 = 文件 */
  isDirectory?: boolean
}

/** 取小写扩展名（含点）；无扩展名返回 '' */
function extOf(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i).toLowerCase()
}

const defaultIsUrl = (p: string): boolean => /^https?:\/\//i.test(p)

/** 取文件名（诊断文案里的 who，同解析器的 defaultName） */
function fileNameOf(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path
  return name.replace(/\.(md|markdown|mdx)$/i, '')
}

/** 把写后处理的回执并进工具结果的文本块（模型面）；结果的 details 不受影响 */
function withNote<T>(res: ToolResult<T>, note: string | null): ToolResult<T> {
  if (!note) return res
  const content = [...res.content]
  const i = content.findIndex((c) => c.type === 'text')
  if (i < 0) return { ...res, content: [...content, { type: 'text', text: note }] }
  const hit = content[i] as { type: 'text'; text: string }
  content[i] = { ...hit, text: `${hit.text}\n\n${note}` }
  return { ...res, content }
}

/**
 * 宿主文本嗅探结果。text 携带一次性读取所需的解码行流工厂与元数据；
 * 共享内核仍负责行号、分页和截断，宿主不得复制那套逻辑。
 */
export type ReadTextDetection =
  | { kind: 'binary' }
  | {
      kind: 'text'
      encoding: string
      readLines: () => AsyncIterable<string>
      escapedControlChars?: boolean
      headerNote?: string
    }

/**
 * 内容解码器(可选能力函数)—— read 的非纯文本分支由各端注入实现。
 * 桌面:markitdown(rich) / nativeImage(image) / word-extractor(.doc) / markitdown(url)。
 * 扩展:turndown(url) / Canvas(image);rich/.doc 缺省(不支持)。
 */
export interface ReadDecoders {
  isUrl?(path: string): boolean
  readUrl?(url: string, signal?: AbortSignal): Promise<ReadResult>
  /** ext → mime 映射;ext 命中即走 readImage 分支 */
  imageMimeByExt?: Record<string, string>
  readImage?(
    portPath: string,
    displayPath: string,
    ext: string,
    fileSize: number
  ): Promise<ReadResult>
  richExtensions?: Set<string>
  readRich?(
    portPath: string,
    displayPath: string,
    fileSize: number,
    signal?: AbortSignal
  ): Promise<ReadResult>
  readLegacyDoc?(
    portPath: string,
    displayPath: string,
    fileSize: number,
    signal?: AbortSignal
  ): Promise<ReadResult>
  /** 已知二进制扩展名(直接拒绝) */
  knownBinaryExtensions?: Set<string>
  /** 有限采样后给出解码读取计划；实现此能力时取代 isBinary + 默认 UTF-8 路径 */
  detectText?(portPath: string, fileSize: number): Promise<ReadTextDetection>
  /** 旧式内容嗅探是否二进制；未实现 detectText 的宿主继续使用 */
  isBinary?(portPath: string, fileSize: number): Promise<boolean> | boolean
  /** 文件不存在时的相似路径建议(桌面 fuzzy 匹配;扩展缺省) */
  suggestSimilar?(portPath: string): string[]
}

export interface FileToolDeps {
  port: FileSystemPort
  guards: FileGuards
  /** displayPath(params.path) → port 路径。桌面:read=resolveReadPath/write=resolveToCwd(绝对) */
  resolvePath(displayPath: string, mode: AccessMode): string
  /** 安全模块 PEP 门面（统一评估 + 询问挂起；宿主经 SecurityHostProvider 注入平台细节） */
  security: SecurityContext
  decoders?: ReadDecoders
  /** 取消错误文案（缺省 'Aborted'） */
  abortError?: string
  /** move / delete 缺省 'Move' / 'Delete'（只有登记了这两个工具的宿主才需要给） */
  labels: { read: string; write: string; edit: string; move?: string; delete?: string }
  /** move / delete 缺省 MOVE_DESCRIPTION / DELETE_DESCRIPTION */
  descriptions: { read: string; write: string; edit: string; move?: string; delete?: string }
  /**
   * write / edit / move / delete 成功后回调 —— 端用于发布文件变更事件（AppEvent 'files.changed'）。
   * portPath 为该端 port 路径；端闭包负责归一到 UI 路径空间并 publish。见 docs/internal-events.md。
   * move 回调两次（源 delete、目标 write），见 FileChangeEvent。
   * `call` 是这次调用的 scope（单测直接调钩子时为 undefined）—— 会话级装配的工具被同一会话的每个
   * agent 共用，宿主要认出「谁写的」（知识库提交的 actor）只能靠它。
   */
  onFileChange?(e: FileChangeEvent, call: ToolCallScope | undefined): void
  /**
   * 写入方（根）会话 id —— 只用于契约 md 的溯源字段（`shuvix-memory-session`）。
   * 不注入则该字段不写，写后校验与其余盖章照常。
   */
  sessionId?: string
  /**
   * OKF 知识库（写钩子的知识库分支）：绝对路径 → 它所属 bundle 内的相对路径（不在任何
   * bundle 内返回 null，宿主答），加写入者 actor（惰性 —— 模型可能中途切换）。
   *
   * 给的是 **bundle 相对**而不是某个根相对：诊断规则按 bundle 判（`index.md` 是不是根 index），
   * 容器相对的路径会让每个 bundle 的根 index 都被误判成子目录 index。不注入（扩展端）则
   * 知识库目录下的 md 与普通 md 无异。
   *
   * `actor(call)` 收这次调用的 scope（`call.conversationId` 认得出发起调用的 agent）：会话级装配的
   * 工具被同一会话的每个 agent 共用，章要盖成**发起这次写入的** agent。
   */
  knowledge?: {
    locate: (portPath: string) => string | null
    actor: (call: ToolCallScope | undefined) => string
  }
  /**
   * write / edit / move / delete 不许碰的路径（宿主答）：返回拒绝的原因（模型面英文），可写返回 null。今天是
   * 笔记本会话自己那份文档 —— 它只经 doc_* 改，才有虚影、等用户停手与三方合并。在询问之前判：不为一次
   * 不会发生的写入弹卡。move 的源与目标各问一次。
   */
  refuseWrite?: (portPath: string) => string | null
  /**
   * 写完一份文件后宿主想附进回执的一句话（模型面英文），没话说回 null。桌面：带 `network` 主体规则的策略文件 →
   * 「用 `shuvix policy check` 核对」—— 廉价模型写完策略不会自己想到去验，回执是它当场一定会读的地方。
   */
  writtenNote?: (portPath: string, text: string) => string | null
}

/**
 * 写后处理（write/edit 共用）—— 契约 md 落盘之后：校验不通过就把原因带回给模型，
 * 通过则补上缺省字段并回写。**工具本身仍算成功**，文件已经写进去了。
 *
 * 回写与读取都在文件锁内做（与并发 write/edit 互斥），写完补一次 recordRead ——
 * 否则宿主自己盖的这一章会让 agent 的下一次 edit 撞上「读后被改」。
 * 整段 try/catch：这一步出任何问题都不该把一次成功的写入变成失败。
 */
async function reviewWrittenMd(
  deps: FileToolDeps,
  portPath: string,
  call?: ToolCallScope
): Promise<string | null> {
  if (!/\.(md|markdown|mdx)$/i.test(portPath)) return null
  const { port, guards } = deps
  try {
    return await guards.withFileLock(portPath, async () => {
      const text = await port.readFile(portPath)
      const now = new Date()
      const knowledge = deps.knowledge
      const rel = knowledge?.locate(portPath) ?? null
      const outcome = reviewShuvixMdWrite(text, fileNameOf(portPath), {
        sessionId: deps.sessionId,
        today: now.toISOString().slice(0, 10),
        knowledge:
          knowledge && rel !== null
            ? { rel, actor: knowledge.actor(call), now: now.toISOString() }
            : undefined
      })
      let extra: string | null = null
      try {
        extra = deps.writtenNote?.(portPath, text) ?? null
      } catch {
        extra = null
      }
      if (outcome?.content != null) {
        await port.writeFile(portPath, outcome.content)
        guards.recordRead(portPath)
      }
      const notes = [outcome?.note ?? null, extra].filter((n): n is string => !!n)
      return notes.length > 0 ? notes.join('\n\n') : null
    })
  } catch {
    return null
  }
}

/**
 * 写入前询问钩子 —— 交给 applyWrite/applyEdit 在锁内调用。
 *
 * 走的仍是统一评估链，所以内置/用户策略、会话权限表这几层
 * 一个不少，只是多带了一份 diff 预览；不通过时它自己 throw，写入不会发生。
 */
function makeWriteAsk(
  deps: FileToolDeps,
  toolName: string,
  toolCallId: string,
  portPath: string,
  signal?: AbortSignal,
  call?: ToolCallScope
): WriteAskHook {
  return async ({ path, diff, isNewFile }) => {
    await deps.security.enforcePath('write', portPath, {
      toolCallId,
      ...callOwnerOf(call),
      toolName,
      displayPath: path,
      abortError: deps.abortError ?? 'Aborted',
      preview: { kind: 'diff', path, diff, isNewFile },
      // 询问点的审查随工具调用一起中止
      signal
    })
  }
}

/** writeFileContent 的参数：路径已由宿主解析好 */
export interface WriteFileContentArgs {
  toolCallId: string
  /** 询问卡片上写的工具名 */
  toolName: string
  /** 展示用路径 */
  path: string
  /** port 路径 */
  portPath: string
  content: string
  signal?: AbortSignal
  call?: ToolCallScope
}

/**
 * 把一份完整内容写进文件，走 write 工具同一条流程：锁内的读后被改守卫 + 带 diff 预览的写前询问 → 写入 →
 * 契约 md 写后处理（校验回执、知识库盖章）→ 广播变更。宿主自己的写入型工具（doc_* 的磁盘回落）用它，
 * 免得另抄一份。不做 write 工具 securityCheck 那两道（符号链接、refuseWrite）—— 那是 write 工具对
 * 模型给的路径的把关，调用方写的是它自己认定的文件。
 *
 * 写后处理的回执（`note`）单独交回：write 工具把它并进结果文字，别的调用方按自己的结果排版放。
 */
export async function writeFileContent(
  deps: FileToolDeps,
  args: WriteFileContentArgs
): Promise<{ result: ToolResult<WriteToolDetails>; note: string | null }> {
  const res = await applyWrite(
    deps.port,
    deps.guards,
    args.portPath,
    { path: args.path, content: args.content },
    makeWriteAsk(deps, args.toolName, args.toolCallId, args.portPath, args.signal, args.call),
    { refuseUnreadOverwrite: (deps.knowledge?.locate(args.portPath) ?? null) !== null }
  )
  // 先审阅（可能回写盖章），再广播变更 —— 让面板刷新读到的是最终内容
  const note = await reviewWrittenMd(deps, args.portPath, args.call)
  deps.onFileChange?.({ portPath: args.portPath, kind: 'write' }, args.call)
  return { result: res, note }
}

const UNSUPPORTED_SUFFIX = '. Supported: text files, PDF, DOC, DOCX, XLSX, PPTX, HTML, IPYNB.'

/** 各工具在符号链接说明里的开头与动词（read 没有开头） */
const SYMLINK_WORDS: Record<string, { lead: string; verb: string }> = {
  write: { lead: 'Not written: ', verb: 'write to' },
  edit: { lead: 'Not edited: ', verb: 'edit' },
  move: { lead: 'Not moved: ', verb: 'move' },
  delete: { lead: 'Not deleted: ', verb: 'delete' }
}

/**
 * 路径本身是符号链接：不跟过去，抛一句说明 —— 它指向哪里、真要操作就直接用那一条，工具就此结束。
 * 那条链接是谁放的、为什么指向那里都说不准，替 agent 跟过去不如让它看见了自己决定；它真去读写
 * 那头时，那一次照常过路径门。只看最后一段：中间段是链接的（链接目录、macOS 的 /var）照常走，
 * 路径门按真实位置判。放在询问之前 —— 不为一次不会发生的访问弹卡。
 */
async function refuseSymlink(
  deps: FileToolDeps,
  toolName: string,
  displayPath: string,
  portPath: string
): Promise<void> {
  const link = await deps.port.readLink?.(portPath)
  if (!link) return
  // 相对的链接原文说不出落在哪，但说得出它是怎么写的（`../../.ssh/id_rsa`）；绝对的原文与
  // resolved 往往只差系统级链接（macOS 的 /var → /private/var），再抄一遍只是噪音
  const relative = !/^([\\/]|[A-Za-z]:[\\/])/.test(link.target)
  const said = relative ? ` (the link says "${link.target}")` : ''
  const { lead, verb } = SYMLINK_WORDS[toolName] ?? { lead: '', verb: 'read' }
  throw new Error(
    `${lead}${displayPath} is a symbolic link to ${link.resolved}${said}. ` +
      `Symbolic links are not followed — ${verb} ${link.resolved} directly if that is the file you mean.`
  )
}

/** 路径比较用：分隔符归一、去掉结尾分隔符 */
const normSep = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** child 是否落在 parent 之下（不含相等） */
const isInside = (child: string, parent: string): boolean =>
  normSep(child).startsWith(`${normSep(parent)}/`)

/** errno 风格的错误码（port 抛的 Node 错误带它；别的宿主没有就是 undefined） */
const codeOf = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

abstract class FileToolBase<
  S extends
    | typeof ReadParamsSchema
    | typeof WriteParamsSchema
    | typeof EditParamsSchema
    | typeof DeleteParamsSchema
> extends BaseTool<S> {
  constructor(
    protected deps: FileToolDeps,
    protected mode: AccessMode
  ) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected get abortError(): string {
    return this.deps.abortError ?? 'Aborted'
  }

  protected isUrl(path: string): boolean {
    return (this.deps.decoders?.isUrl ?? defaultIsUrl)(path)
  }

  /**
   * 写类工具（write/edit）把路径询问推迟到 apply 层 —— 那里才算得出 diff，
   * 询问卡片才能带预览。留在这里的话同一次写入会先弹一个光秃秃的路径询问、
   * 再弹一次预览询问。read 不受影响（没有"即将发生的改动"可言）。
   */
  protected get deferAskToApply(): boolean {
    return false
  }

  /**
   * 询问之前、拒写判定之后的最后一道（缺省没有）：delete 在这里判「不存在 / 目录非空」——
   * 不为一次不会发生的删除弹卡。
   */
  protected async beforeAsk(_displayPath: string, _portPath: string): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(
    toolCallId: string,
    params: { path: string },
    signal?: AbortSignal,
    call?: ToolCallScope
  ): Promise<void> {
    if (signal?.aborted) throw new Error(this.abortError)
    // read 的 URL 分支不走文件系统询问，走地址判定：它可能在隐藏页面里运行这个页面的脚本。缺省没有策略，直接放行
    if (this.mode === 'read' && this.isUrl(params.path)) {
      await this.deps.security.enforceUrl(urlObjectOf(params.path), {
        toolCallId,
        ...callOwnerOf(call),
        toolName: this.name,
        abortError: this.abortError,
        signal
      })
      return
    }
    const portPath = this.deps.resolvePath(params.path, this.mode)
    await refuseSymlink(this.deps, this.name, params.path, portPath)
    if (this.mode === 'write') {
      const refused = this.deps.refuseWrite?.(portPath)
      if (refused) throw new Error(refused)
    }
    await this.beforeAsk(params.path, portPath)
    if (this.deferAskToApply) return
    await this.deps.security.enforcePath(this.mode, portPath, {
      toolCallId,
      ...callOwnerOf(call),
      toolName: this.name,
      displayPath: params.path,
      abortError: this.abortError,
      signal
    })
  }
}

class ReadFileTool extends FileToolBase<typeof ReadParamsSchema> {
  readonly name = 'read'
  readonly label: string
  readonly description: string
  readonly parameters = ReadParamsSchema
  // 只读：中断后恢复时重读一遍无害（读到的是那一刻的文件，正是模型要的）
  readonly replay = 'safe' as const
  // 保留开头：超限的 read 结果里模型该拿到文件的**前**一段，接着用 offset 往下读
  readonly outputStrategy = 'keep-start' as const
  readonly outputMaxBytes = 80 * 1024
  // readTextContent 已经自己把正文截到 DEFAULT_MAX_LINES 行，再包上最多 5 行外壳（文件头、
  // 空行、末尾那句 `Use offset=N to continue.`）。宿主的行数上限若还是 DEFAULT_MAX_LINES，
  // keep-start 正好砍掉的就是那句提示 —— 而「接着用 offset 往下读」正是 keep-start 的理由。
  // 给外壳留出位置：≥2000 行的文件照常一次读满 2000 行并拿到续读的 offset。
  readonly outputMaxLines = DEFAULT_MAX_LINES + 5

  constructor(deps: FileToolDeps) {
    super(deps, 'read')
    this.label = deps.labels.read
    this.description = deps.descriptions.read
  }

  protected async executeInternal(
    _toolCallId: string,
    params: { path: string; offset?: number; limit?: number },
    signal?: AbortSignal
  ): Promise<ReadResult> {
    if (signal?.aborted) throw new Error(this.abortError)
    const { port, guards } = this.deps
    const dec = this.deps.decoders

    // URL：抓取网页转 Markdown
    if (this.isUrl(params.path)) {
      if (!dec?.readUrl) throw new Error(`URL reading is not supported: ${params.path}`)
      try {
        return await dec.readUrl(params.path, signal)
      } catch (err) {
        if (err instanceof Error && err.message === this.abortError) throw err
        throw new Error(`Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const portPath = this.deps.resolvePath(params.path, 'read')

    // 不存在 → 报错 + 相似路径建议
    const st = await port.stat(portPath)
    if (!st) {
      const suggestions = dec?.suggestSimilar?.(portPath) ?? []
      throw new Error(
        suggestions.length > 0
          ? `File not found: ${params.path}\n\nDid you mean one of these?\n${suggestions.join('\n')}`
          : `File not found: ${params.path}`
      )
    }

    try {
      // 目录：列出条目
      if (st.isDirectory) return await readDirContent(port, portPath, params)
      if (!st.isFile) throw new Error(`Not a file: ${params.path}`)
      if (signal?.aborted) throw new Error(this.abortError)

      const ext = extOf(params.path)
      // 富文本 → Markdown
      if (dec?.richExtensions?.has(ext) && dec.readRich) {
        return await dec.readRich(portPath, params.path, st.size, signal)
      }
      // 图片 → base64 多模态
      if (dec?.imageMimeByExt && ext in dec.imageMimeByExt && dec.readImage) {
        return await dec.readImage(portPath, params.path, ext, st.size)
      }
      // 旧版 .doc
      if (ext === '.doc' && dec?.readLegacyDoc) {
        return await dec.readLegacyDoc(portPath, params.path, st.size, signal)
      }
      // 已知二进制 → 拒绝
      if (dec?.knownBinaryExtensions?.has(ext)) {
        throw new Error(`Unsupported format (${ext}): ${params.path}${UNSUPPORTED_SUFFIX}`)
      }
      // 新能力：宿主给出编码与解码行流；旧宿主保持 isBinary + UTF-8 行为
      if (dec?.detectText) {
        const detected = await dec.detectText(portPath, st.size)
        if (detected.kind === 'binary') {
          throw new Error(
            `Unsupported format (${ext || 'binary'}): ${params.path}${UNSUPPORTED_SUFFIX}`
          )
        }
        const result = await readTextContent(port, portPath, params, st.size, {
          lines: detected.readLines(),
          encoding: detected.encoding,
          escapedControlChars: detected.escapedControlChars,
          headerNote: detected.headerNote
        })
        guards.recordRead(portPath)
        return result
      }
      // 内容嗅探二进制 → 拒绝
      if (dec?.isBinary && (await dec.isBinary(portPath, st.size))) {
        throw new Error(
          `Unsupported format (${ext || 'binary'}): ${params.path}${UNSUPPORTED_SUFFIX}`
        )
      }
      // 纯文本：共享内核流式逐行读取，记录读取时间
      const result = await readTextContent(port, portPath, params, st.size)
      guards.recordRead(portPath)
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === this.abortError) throw err
      throw new Error(`Failed: ${msg}`)
    }
  }
}

class WriteFileTool extends FileToolBase<typeof WriteParamsSchema> {
  readonly name = 'write'
  readonly label: string
  readonly description: string
  readonly parameters = WriteParamsSchema

  constructor(deps: FileToolDeps) {
    super(deps, 'write')
    this.label = deps.labels.write
    this.description = deps.descriptions.write
  }

  protected get deferAskToApply(): boolean {
    return true
  }

  protected async executeInternal(
    toolCallId: string,
    params: { path: string; content: string },
    signal?: AbortSignal,
    call?: ToolCallScope
  ): Promise<ToolResult<WriteToolDetails>> {
    if (signal?.aborted) throw new Error(this.abortError)
    const { result, note } = await writeFileContent(this.deps, {
      toolCallId,
      toolName: this.name,
      path: params.path,
      portPath: this.deps.resolvePath(params.path, 'write'),
      content: params.content,
      signal,
      call
    })
    return withNote(result, note)
  }
}

class EditFileTool extends FileToolBase<typeof EditParamsSchema> {
  readonly name = 'edit'
  readonly label: string
  readonly description: string
  readonly parameters = EditParamsSchema

  constructor(deps: FileToolDeps) {
    super(deps, 'write')
    this.label = deps.labels.edit
    this.description = deps.descriptions.edit
  }

  protected get deferAskToApply(): boolean {
    return true
  }

  protected async executeInternal(
    toolCallId: string,
    params: { path: string; oldText: string; newText: string },
    signal?: AbortSignal,
    call?: ToolCallScope
  ): Promise<ToolResult<EditToolDetails>> {
    if (signal?.aborted) throw new Error(this.abortError)
    const portPath = this.deps.resolvePath(params.path, 'write')
    const res = await applyEdit(
      this.deps.port,
      this.deps.guards,
      portPath,
      params,
      makeWriteAsk(this.deps, this.name, toolCallId, portPath, signal, call)
    )
    const note = await reviewWrittenMd(this.deps, portPath, call)
    this.deps.onFileChange?.({ portPath, kind: 'edit' }, call)
    return withNote(res, note)
  }
}

/** 读取时间还作数吗：读过之后没被改过（守卫不抛） */
async function stillAsRead(guards: FileGuards, portPath: string): Promise<boolean> {
  try {
    await guards.assertNotModifiedSinceRead(portPath)
    return true
  } catch {
    return false
  }
}

/** 两把文件锁按固定次序拿（A→B 与 B→A 两次并发的 move 不互等） */
function withTwoLocks<T>(
  guards: FileGuards,
  a: string,
  b: string,
  fn: () => Promise<T>
): Promise<T> {
  const [first, second] = a < b ? [a, b] : [b, a]
  return guards.withFileLock(first, () => guards.withFileLock(second, fn))
}

/**
 * move 能不能做（询问之前判一次，拿到锁之后再判一次 —— 询问期间盘上可能变了）。交回源的 stat。
 * 目标「已存在」有一种例外：只差大小写（大小写不敏感的盘上目标查得到，正是源自己）—— 交给 port 判，
 * 它认得出是不是同一个文件，不是就抛 EEXIST。
 */
async function checkMove(
  port: FileSystemPort,
  params: { from: string; to: string },
  from: string,
  to: string
): Promise<FileStat> {
  if (normSep(from) === normSep(to)) {
    throw new Error(`Not moved: ${params.from} and ${params.to} are the same path.`)
  }
  const source = await port.stat(from)
  if (!source) throw new Error(`Not moved: ${params.from} does not exist.`)
  const caseOnly = normSep(from).toLowerCase() === normSep(to).toLowerCase()
  if (!caseOnly && (await port.stat(to))) {
    throw new Error(
      `Not moved: ${params.to} already exists. move never replaces anything — pick another destination, or delete ${params.to} first.`
    )
  }
  if (source.isDirectory && isInside(to, from)) {
    throw new Error(
      `Not moved: ${params.to} is inside ${params.from} — a directory cannot be moved into itself.`
    )
  }
  return source
}

class MoveFileTool extends BaseTool<typeof MoveParamsSchema> {
  readonly name = 'move'
  readonly label: string
  readonly description: string
  readonly parameters = MoveParamsSchema

  constructor(private deps: FileToolDeps) {
    super()
    this.label = deps.labels.move ?? 'Move'
    this.description = deps.descriptions.move ?? MOVE_DESCRIPTION
  }

  private get abortError(): string {
    return this.deps.abortError ?? 'Aborted'
  }

  async preExecute(): Promise<void> {
    if (!this.deps.port.rename) {
      throw new Error('move is not available here: this host cannot move or rename files.')
    }
  }

  /**
   * 两头都是写：源（它从那里消失）与目标（它在这里出现）各过一次路径门，都在动盘之前。
   * 次序同 write：符号链接 → 宿主拒写 → 做不做得成（不为一次不会发生的挪动弹卡）→ 询问。
   */
  protected async securityCheck(
    toolCallId: string,
    params: { from: string; to: string },
    signal?: AbortSignal,
    call?: ToolCallScope
  ): Promise<void> {
    if (signal?.aborted) throw new Error(this.abortError)
    const from = this.deps.resolvePath(params.from, 'write')
    const to = this.deps.resolvePath(params.to, 'write')
    const ends: Array<[string, string]> = [
      [params.from, from],
      [params.to, to]
    ]
    for (const [displayPath, portPath] of ends) {
      await refuseSymlink(this.deps, this.name, displayPath, portPath)
      const refused = this.deps.refuseWrite?.(portPath)
      if (refused) throw new Error(refused)
    }
    await checkMove(this.deps.port, params, from, to)
    for (const [displayPath, portPath] of ends) {
      await this.deps.security.enforcePath('write', portPath, {
        toolCallId,
        ...callOwnerOf(call),
        toolName: this.name,
        displayPath,
        abortError: this.abortError,
        signal
      })
    }
  }

  protected async executeInternal(
    _toolCallId: string,
    params: { from: string; to: string },
    signal?: AbortSignal,
    call?: ToolCallScope
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error(this.abortError)
    const { port, guards } = this.deps
    const from = this.deps.resolvePath(params.from, 'write')
    const to = this.deps.resolvePath(params.to, 'write')
    const isDirectory = await withTwoLocks(guards, from, to, async () => {
      const source = await checkMove(port, params, from, to)
      // 读过、且读后没被改过的文件，挪过去仍算读过 —— 紧接着在新位置 edit 不该撞「先读一遍」
      const carryRead =
        !source.isDirectory && guards.hasReadTime(from) && (await stillAsRead(guards, from))
      try {
        await port.rename!(from, to)
      } catch (err) {
        if (codeOf(err) === 'EEXIST') {
          throw new Error(
            `Not moved: ${params.to} already exists. move never replaces anything — pick another destination, or delete ${params.to} first.`
          )
        }
        throw new Error(`Not moved: ${messageOf(err)}`)
      }
      if (carryRead) guards.recordRead(to)
      return source.isDirectory
    })
    const dir = isDirectory ? { isDirectory: true } : {}
    this.deps.onFileChange?.({ portPath: from, kind: 'delete', ...dir }, call)
    this.deps.onFileChange?.({ portPath: to, kind: 'write', ...dir }, call)
    return {
      content: [{ type: 'text', text: `Moved ${params.from} → ${params.to}` }],
      details: undefined
    }
  }
}

/**
 * delete 能不能做（询问之前判一次，拿到锁之后再判一次）。交回它的 stat。
 * 读过的文件读后被改过 → 守卫抛「先重读」：删掉的会是 agent 没见过的内容。
 */
async function checkDelete(
  deps: FileToolDeps,
  displayPath: string,
  portPath: string
): Promise<FileStat> {
  const st = await deps.port.stat(portPath)
  if (!st) throw new Error(`Not deleted: ${displayPath} does not exist.`)
  if (st.isDirectory) {
    const count = (await deps.port.readdir(portPath)).length
    if (count > 0) {
      throw new Error(
        `Not deleted: ${displayPath} is a directory with ${count} ${count === 1 ? 'entry' : 'entries'} in it. delete removes only files and empty directories — delete or move what is inside first.`
      )
    }
  } else if (deps.guards.hasReadTime(portPath)) {
    await deps.guards.assertNotModifiedSinceRead(portPath)
  }
  return st
}

class DeleteFileTool extends FileToolBase<typeof DeleteParamsSchema> {
  readonly name = 'delete'
  readonly label: string
  readonly description: string
  readonly parameters = DeleteParamsSchema

  constructor(deps: FileToolDeps) {
    super(deps, 'write')
    this.label = deps.labels.delete ?? 'Delete'
    this.description = deps.descriptions.delete ?? DELETE_DESCRIPTION
  }

  async preExecute(): Promise<void> {
    if (!this.deps.port.remove) {
      throw new Error('delete is not available here: this host cannot delete files.')
    }
  }

  protected async beforeAsk(displayPath: string, portPath: string): Promise<void> {
    await checkDelete(this.deps, displayPath, portPath)
  }

  protected async executeInternal(
    _toolCallId: string,
    params: { path: string },
    signal?: AbortSignal,
    call?: ToolCallScope
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error(this.abortError)
    const portPath = this.deps.resolvePath(params.path, 'write')
    const isDirectory = await this.deps.guards.withFileLock(portPath, async () => {
      const st = await checkDelete(this.deps, params.path, portPath)
      try {
        await this.deps.port.remove!(portPath)
      } catch (err) {
        if (codeOf(err) === 'ENOTEMPTY' || codeOf(err) === 'EEXIST') {
          throw new Error(
            `Not deleted: ${params.path} is a directory that is not empty. delete removes only files and empty directories — delete or move what is inside first.`
          )
        }
        throw new Error(`Not deleted: ${messageOf(err)}`)
      }
      return st.isDirectory
    })
    this.deps.onFileChange?.(
      { portPath, kind: 'delete', ...(isDirectory ? { isDirectory: true } : {}) },
      call
    )
    return {
      content: [
        {
          type: 'text',
          text: isDirectory
            ? `Deleted the empty directory ${params.path}`
            : `Deleted ${params.path}`
        }
      ],
      details: undefined
    }
  }
}

export interface FileToolSuite {
  read: ReadFileTool
  write: WriteFileTool
  edit: EditFileTool
  move: MoveFileTool
  delete: DeleteFileTool
}

/** 构建一套 read/write/edit/move/delete 工具（BaseTool 子类，即 durable 的 ToolRegistration） */
export function createFileToolSuite(deps: FileToolDeps): FileToolSuite {
  return {
    read: new ReadFileTool(deps),
    write: new WriteFileTool(deps),
    edit: new EditFileTool(deps),
    move: new MoveFileTool(deps),
    delete: new DeleteFileTool(deps)
  }
}
