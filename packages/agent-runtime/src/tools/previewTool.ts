/**
 * 共享 preview 工具内核 —— 校验路径 → 分类判定 → （图表）渲染验证 → 广播 file_preview。
 *
 * 结果反馈分两层（真源各一处，两端零漂移）：
 *   1. 分类结果（同步）：调用与预览面板同一个 previewFile 内核（deps.readPreview），
 *      binary / too-large / not-allowed / error 这些「用户只会看到占位符」的结局直接
 *      以 isError 返回给 LLM —— 不发事件、不打开面板；hex 视图放行但附注说明。
 *   2. 渲染结果（异步，仅图表契约文件）：mermaid 成败只有渲染管线知道（主进程无 DOM），
 *      经 deps.validateChart 注入 —— 桌面 = AppEvent 请渲染端跑同款 renderMermaid + IPC
 *      回执（broker 超时诚实降级为 verified:false）；扩展 = 工具就在浏览器里直接渲染。
 *      验证失败同样不打开面板，返回 mermaid 错误原文供 agent 当轮修正后重试。
 *
 * **刻意不设路径准入门**：预览把文件呈现给**用户**，正文不进模型上下文 —— 与桌面
 * previewSessionFile（用户点击 Files 面板）同一哲学：用户对本机文件本来就有完全访问权，
 * 读取询问的存在理由（内容进上下文可能被外带）在此不适用。已知且接受的小信息面：
 * tool result 会把存在性/分类元数据（not found / binary / size）与图表验证的 mermaid
 * 错误碎片回给模型。想按工具设门：L1 全工具门 + 用户策略 `tool.name == 'preview'`。
 *
 * 平台差异全部经注入：
 *   - resolvePath：输入路径 → { statPath(交给 port/内核), absPath(事件/展示用 UI 路径空间) }；
 *     非法（'..' 逃逸出根等）时 throw LLM 可读错误（桌面=工作目录绝对路径；扩展=root.name/rel）。
 *   - port.stat：存在性与常规文件校验（桌面 Node fs；扩展 FSA）。
 *   - readPreview：预览分类内核（桌面 Node port / 扩展 FSA port 包 previewFile）。
 *   - validateChart：图表渲染验证（可选；缺省跳过，按未验证成功处理）。
 *   - emitFilePreview：宿主绑定 sessionId 广播事件（桌面 ctx.emitChatEvent；扩展 eventBus）。
 */
import { Type } from 'typebox'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { FileReadResult } from '@shuvix/chat-protocol/types/filePreview'
import { isChartFile, extractChartMermaid } from '@shuvix/chat-protocol/chartFileContract'
import { BaseTool } from './baseTool'
import type { FileSystemPort } from '../fileTools/port'

export const PreviewParamsSchema = Type.Object({
  path: Type.String({
    description:
      'Absolute path of the file to preview (a relative path is resolved against the session working directory). Must be an existing file.'
  })
})

export const PREVIEW_DESCRIPTION =
  'Open a file preview in the session Files panel — the same preview the user sees when clicking that file in the panel. The file must already exist. The tool verifies the outcome before returning: unsupported formats (binary / too large / unreadable) and failed chart rendering (invalid mermaid in a shuvix:chart file) return an error WITHOUT opening the panel — fix the file and call preview again. Use this to present a finished artifact (e.g. a Markdown chart) to the user right after writing it.'

/** 图表渲染验证结果（verified=false 表示无渲染端应答，按成功放行但注明未验证） */
export interface ChartValidation {
  ok: boolean
  /** mermaid 解析/渲染错误文本（ok=false 时） */
  error?: string
  verified: boolean
}

export interface PreviewToolDeps {
  /** 只需 stat —— 存在性与常规文件校验 */
  port: Pick<FileSystemPort, 'stat'>
  /**
   * 解析输入路径。返回 statPath（port/内核用）与 absPath（事件/文案用）；
   * 非法（如 '..' 逃逸出根）时 throw —— 错误文本直接回给 LLM。
   * 纯解析，不做准入（无门的理由见文件头）。
   */
  resolvePath: (
    path: string
  ) => Promise<{ statPath: string; absPath: string }> | { statPath: string; absPath: string }
  /** 预览分类 —— 与 FilesPanel/FilePreview 同一个 previewFile 内核，注入各端 port */
  readPreview: (statPath: string, absPath: string) => Promise<FileReadResult>
  /** 图表渲染验证（可选注入）；仅对命中 shuvix:chart 契约的文件调用 */
  validateChart?: (params: { absPath: string; mermaid: string }) => Promise<ChartValidation>
  /** 广播 file_preview（宿主绑定 sessionId）；不可用时 throw */
  emitFilePreview: (absPath: string) => void
  label: string
  abortError: string
}

/** 人类可读的字节数（工具结果文案用，粗粒度即可） */
function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

export class PreviewTool extends BaseTool<typeof PreviewParamsSchema> {
  readonly name = 'preview'
  readonly label: string
  readonly description = PREVIEW_DESCRIPTION
  readonly parameters = PreviewParamsSchema

  constructor(private deps: PreviewToolDeps) {
    super()
    this.label = deps.label
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(
    _toolCallId: string,
    params: { path: string },
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw new Error(this.deps.abortError)
    // 仅路径合法性校验（非法即 throw）；无准入门 —— 理由见文件头
    await this.deps.resolvePath(params.path)
  }

  protected async executeInternal(
    _toolCallId: string,
    params: { path: string },
    signal?: AbortSignal
  ): Promise<AgentToolResult<undefined>> {
    if (signal?.aborted) throw new Error(this.deps.abortError)

    const { statPath, absPath } = await this.deps.resolvePath(params.path)
    const stat = await this.deps.port.stat(statPath)
    if (!stat) throw new Error(`File not found: ${absPath}`)
    if (!stat.isFile) throw new Error(`Not a regular file: ${absPath}`)

    // ── 第一层：分类判定（与预览面板同一内核）——「用户看不到有效内容」的结局直接报错 ──
    const preview = await this.deps.readPreview(statPath, absPath)
    switch (preview.kind) {
      case 'error':
        throw new Error(
          `Preview failed — the user cannot see this file: ${preview.message} (${absPath})`
        )
      case 'not-allowed':
        throw new Error(
          `Preview not allowed — the user cannot see any content: ${preview.reason} (${absPath})`
        )
      case 'binary':
        throw new Error(
          `Preview not supported: ${absPath} is a binary format (${preview.ext || 'unknown'}); the panel would only show a placeholder, the user cannot see any useful content. Do not use preview for this file.`
        )
      case 'too-large':
        throw new Error(
          `Preview not supported: ${absPath} is too large (${formatBytes(preview.size)}, preview limit ${formatBytes(preview.cap)}); the panel would only show a placeholder.`
        )
    }

    let note = ''
    if (preview.kind === 'hex') {
      note =
        ' Note: this file opens as a raw hex byte view (binary content), not a rendered document.'
    }

    // ── 第二层：图表契约文件的渲染验证（失败不打开面板，返回错误供 agent 修正重试） ──
    if (preview.kind === 'text' && isChartFile(preview.content)) {
      const mermaid = extractChartMermaid(preview.content)
      if (!mermaid) {
        throw new Error(
          `${absPath} carries the shuvix:chart marker but violates the contract (expected exactly ONE \`\`\`mermaid code block); the preview would fall back to plain markdown. Fix the file, then call preview again. The preview panel was NOT opened.`
        )
      }
      if (this.deps.validateChart) {
        const v = await this.deps.validateChart({ absPath, mermaid })
        if (!v.ok) {
          throw new Error(
            `Mermaid failed to render: ${v.error ?? 'unknown error'}\nThe preview panel was NOT opened. Fix the diagram source in ${absPath}, then call preview again.`
          )
        }
        note = v.verified
          ? ' Chart rendered successfully.'
          : ' (Chart rendering could not be verified — no renderer responded.)'
      }
    }

    this.deps.emitFilePreview(absPath)

    return {
      content: [{ type: 'text', text: `Preview opened in the Files panel: ${absPath}.${note}` }],
      details: undefined
    }
  }
}

/** 创建 preview 工具（注入端适配） */
export function createPreviewTool(deps: PreviewToolDeps): PreviewTool {
  return new PreviewTool(deps)
}
