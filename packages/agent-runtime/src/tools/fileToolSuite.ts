/**
 * 共享文件工具套件 —— read / write / edit 的整条执行流程（宿主无关）。
 *
 * 把桌面 tools/{read,write,edit}.ts 的 shell 逻辑收敛成一份:路径解析 → 符号链接不跟(路径本身是链接
 * 就只说出它指向哪里) → 路径询问(securityCheck) → 内核(readTextContent/readDirContent/applyWrite/
 * applyEdit) + read 的分派(url/图片/富文档/.doc/二进制/目录/纯文本)。平台差异全部经注入:
 * FileSystemPort / FileGuards / resolvePath / SecurityContext(安全模块 PEP 门面) /
 * ReadDecoders(内容解码器,可选能力函数) / ensureAccess。
 */
import { Type } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  ReadToolDetails,
  EditToolDetails,
  WriteToolDetails
} from '@shuvix/chat-protocol/types/chatMessage'
import { BaseTool } from './baseTool'
import type { FileSystemPort, FileGuards, WriteAskHook } from '../fileTools/port'
import { readTextContent, readDirContent } from '../fileTools/read'
import { applyWrite } from '../fileTools/write'
import { applyEdit } from '../fileTools/edit'
import { reviewShuvixMdWrite } from '../shuvixMdWrite'
import type { AccessMode, SecurityContext } from '../security/types'

type ReadResult = AgentToolResult<ReadToolDetails>

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
function withNote<T>(res: AgentToolResult<T>, note: string | null): AgentToolResult<T> {
  if (!note) return res
  const content = [...res.content]
  const i = content.findIndex((c) => c.type === 'text')
  if (i < 0) return { ...res, content: [...content, { type: 'text', text: note }] }
  const hit = content[i] as { type: 'text'; text: string }
  content[i] = { ...hit, text: `${hit.text}\n\n${note}` }
  return { ...res, content }
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
  /** 内容嗅探是否二进制 */
  isBinary?(portPath: string, fileSize: number): Promise<boolean> | boolean
  /** 文件不存在时的相似路径建议(桌面 fuzzy 匹配;扩展缺省) */
  suggestSimilar?(portPath: string): string[]
}

export interface FileToolDeps {
  port: FileSystemPort
  guards: FileGuards
  /** displayPath(params.path) → port 路径。桌面:read=resolveReadPath/write=resolveToCwd(绝对);扩展:identity */
  resolvePath(displayPath: string, mode: AccessMode): string
  /** 安全模块 PEP 门面（统一评估 + 询问挂起；宿主经 SecurityHostProvider 注入平台细节） */
  security: SecurityContext
  decoders?: ReadDecoders
  /** 执行前的平台访问校验(扩展 FSA 权限);默认 no-op */
  ensureAccess?(): Promise<void>
  /** 取消错误文案(桌面 'Aborted' / 扩展 'TOOL_ABORTED') */
  abortError?: string
  labels: { read: string; write: string; edit: string }
  descriptions: { read: string; write: string; edit: string }
  /**
   * write/edit 成功后回调 —— 端用于发布文件变更事件（AppEvent 'files.changed'）。
   * portPath 为该端 port 路径；端闭包负责归一到 UI 路径空间并 publish。见 docs/internal-events.md。
   */
  onFileChange?(e: { portPath: string; kind: 'write' | 'edit' }): void
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
   */
  knowledge?: { locate: (portPath: string) => string | null; actor: () => string }
}

const UNSUPPORTED_SUFFIX = '. Supported: text files, PDF, DOC, DOCX, XLSX, PPTX, HTML, IPYNB.'

abstract class FileToolBase<
  S extends typeof ReadParamsSchema | typeof WriteParamsSchema | typeof EditParamsSchema
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
   * 路径本身是符号链接：不跟过去，抛一句说明 —— 它指向哪里、真要操作就直接用那一条，工具就此结束。
   * 那条链接是谁放的、为什么指向那里都说不准，替 agent 跟过去不如让它看见了自己决定；它真去读写
   * 那头时，那一次照常过路径门。只看最后一段：中间段是链接的（链接目录、macOS 的 /var）照常走，
   * 路径门按真实位置判。放在询问之前 —— 不为一次不会发生的访问弹卡。
   */
  private async refuseSymlink(displayPath: string, portPath: string): Promise<void> {
    const link = await this.deps.port.readLink?.(portPath)
    if (!link) return
    // 相对的链接原文说不出落在哪，但说得出它是怎么写的（`../../.ssh/id_rsa`）；绝对的原文与
    // resolved 往往只差系统级链接（macOS 的 /var → /private/var），再抄一遍只是噪音
    const relative = !/^([\\/]|[A-Za-z]:[\\/])/.test(link.target)
    const said = relative ? ` (the link says "${link.target}")` : ''
    const lead =
      this.name === 'write' ? 'Not written: ' : this.name === 'edit' ? 'Not edited: ' : ''
    const verb = this.name === 'write' ? 'write to' : this.name === 'edit' ? 'edit' : 'read'
    throw new Error(
      `${lead}${displayPath} is a symbolic link to ${link.resolved}${said}. ` +
        `Symbolic links are not followed — ${verb} ${link.resolved} directly if that is the file you mean.`
    )
  }

  protected async securityCheck(
    toolCallId: string,
    params: { path: string },
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error(this.abortError)
    // read 的 URL 分支不走文件系统询问
    if (this.mode === 'read' && this.isUrl(params.path)) return
    await this.deps.ensureAccess?.()
    const portPath = this.deps.resolvePath(params.path, this.mode)
    await this.refuseSymlink(params.path, portPath)
    if (this.deferAskToApply) return
    await this.deps.security.enforcePath(this.mode, portPath, {
      toolCallId,
      toolName: this.name,
      displayPath: params.path,
      abortError: this.abortError
    })
  }

  /**
   * 写入前询问钩子 —— 交给 applyWrite/applyEdit 在锁内调用。
   *
   * 走的仍是统一评估链，所以内置/用户策略、会话免询问、allowList 这几层
   * 一个不少，只是多带了一份 diff 预览；不通过时它自己 throw，写入不会发生。
   */
  /**
   * 写后处理（write/edit 共用）—— 契约 md 落盘之后：校验不通过就把原因带回给模型，
   * 通过则补上缺省字段并回写。**工具本身仍算成功**，文件已经写进去了。
   *
   * 回写与读取都在文件锁内做（与并发 write/edit 互斥），写完补一次 recordRead ——
   * 否则宿主自己盖的这一章会让 agent 的下一次 edit 撞上「读后被改」。
   * 整段 try/catch：这一步出任何问题都不该把一次成功的写入变成失败。
   */
  protected async reviewWrittenMd(portPath: string): Promise<string | null> {
    if (!/\.(md|markdown|mdx)$/i.test(portPath)) return null
    const { port, guards } = this.deps
    try {
      return await guards.withFileLock(portPath, async () => {
        const text = await port.readFile(portPath)
        const now = new Date()
        const knowledge = this.deps.knowledge
        const rel = knowledge?.locate(portPath) ?? null
        const outcome = reviewShuvixMdWrite(text, fileNameOf(portPath), {
          sessionId: this.deps.sessionId,
          today: now.toISOString().slice(0, 10),
          knowledge:
            knowledge && rel !== null
              ? { rel, actor: knowledge.actor(), now: now.toISOString() }
              : undefined
        })
        if (!outcome) return null
        if (outcome.content !== null) {
          await port.writeFile(portPath, outcome.content)
          guards.recordRead(portPath)
        }
        return outcome.note
      })
    } catch {
      return null
    }
  }

  protected makeAsk(toolCallId: string, portPath: string): WriteAskHook {
    return async ({ path, diff, isNewFile }) => {
      await this.deps.security.enforcePath('write', portPath, {
        toolCallId,
        toolName: this.name,
        displayPath: path,
        abortError: this.abortError,
        preview: { kind: 'diff', path, diff, isNewFile }
      })
    }
  }
}

class ReadFileTool extends FileToolBase<typeof ReadParamsSchema> {
  readonly name = 'read'
  readonly label: string
  readonly description: string
  readonly parameters = ReadParamsSchema
  readonly outputStrategy = 'head' as const
  readonly outputMaxBytes = 80 * 1024

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
    signal?: AbortSignal
  ): Promise<AgentToolResult<WriteToolDetails>> {
    if (signal?.aborted) throw new Error(this.abortError)
    const portPath = this.deps.resolvePath(params.path, 'write')
    const res = await applyWrite(
      this.deps.port,
      this.deps.guards,
      portPath,
      params,
      this.makeAsk(toolCallId, portPath)
    )
    // 先审阅（可能回写盖章），再广播变更 —— 让面板刷新读到的是最终内容
    const note = await this.reviewWrittenMd(portPath)
    this.deps.onFileChange?.({ portPath, kind: 'write' })
    return withNote(res, note)
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
    signal?: AbortSignal
  ): Promise<AgentToolResult<EditToolDetails>> {
    if (signal?.aborted) throw new Error(this.abortError)
    const portPath = this.deps.resolvePath(params.path, 'write')
    const res = await applyEdit(
      this.deps.port,
      this.deps.guards,
      portPath,
      params,
      this.makeAsk(toolCallId, portPath)
    )
    const note = await this.reviewWrittenMd(portPath)
    this.deps.onFileChange?.({ portPath, kind: 'edit' })
    return withNote(res, note)
  }
}

export interface FileToolSuite {
  read: ReadFileTool
  write: WriteFileTool
  edit: EditFileTool
}

/** 构建一套 read/write/edit 工具（BaseTool 子类，可直接作为 AgentTool 使用） */
export function createFileToolSuite(deps: FileToolDeps): FileToolSuite {
  return {
    read: new ReadFileTool(deps),
    write: new WriteFileTool(deps),
    edit: new EditFileTool(deps)
  }
}
