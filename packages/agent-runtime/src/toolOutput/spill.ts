/**
 * 共享工具输出后处理 —— 截断 + 落盘（宿主无关，落盘经注入的 SpillSink）。
 *
 * 从桌面 utils/toolUtils/processToolOutput.ts 逐字搬出：未超限原样返回；超限则尝试经 sink
 * 落盘完整内容、回 preview + locator；落盘失败/无 sink → 降级为内存截断。
 * 落盘介质由各宿主注入（桌面 fs 写 tool_results；扩展 OPFS/FSA 写 .shuvix/tool_results）。
 *
 * **说明写在哪**有两种口径（`locatorInText`）：
 *  - 缺省（true，旧口径）：表头 `[Output truncated: …]`、落盘位置与「用 Read 取全文」写进正文开头；
 *  - false（pi-durable 的工具包装器用）：正文**只**留预览 / 截断后的文字，表头与 locator 由结果字段
 *    交回，宿主把它们写成 durable 的 diagnostic（`truncationDiagnostic`）—— durable 把诊断渲染在
 *    结果末尾的 `<harness>` 段里，正文本身则恰好落在预览 / 截断上限之内，durable 自己那道截断
 *    （`outputLimits`）不会再砍它一刀。
 */
import type { ToolDiagnostic } from '@earendil-works/pi-durable'
import {
  truncateMiddle,
  truncateKeepStart,
  truncateKeepEnd,
  formatSize,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES
} from '../fileTools/truncate'

/**
 * 截断策略 —— 名字说的是**留下**哪一段：
 *  - `middle` 保留首尾、砍掉中间（缺省，bash / ssh 这类「命令在前、结论在后」的输出）
 *  - `keep-start` 保留开头（read 的文件开头 —— 模型再用 offset 往下读；ls/glob/grep 的前几条结果）
 *  - `keep-end` 保留末尾（只有结尾有用的输出）
 *
 * 曾经叫 head / tail：这两个词既能读成「砍掉那一段」也能读成「留下那一段」，声明策略的一侧
 * 与执行截断的一侧各读了一种，`read` 于是保留的是文件末尾。名字改成说结果，别再改回去。
 */
export type TruncateStrategy = 'middle' | 'keep-start' | 'keep-end'

/**
 * 落盘 sink（注入）：把完整文本持久化，返回一个「模型可用 read 工具取回」的 locator。
 * 返回 null 表示落盘失败 → 上层降级为内存截断。
 */
export interface SpillSink {
  write(toolCallId: string, fullText: string): Promise<{ locator: string } | null>
}

export interface ProcessToolOutputOptions {
  toolCallId: string
  fullText: string
  /** 截断策略：middle=保留首尾, keep-start=保留开头, keep-end=保留末尾 */
  strategy: TruncateStrategy
  maxLines?: number
  maxBytes?: number
  /** 落盘 sink；不传 → 仅内存截断不落盘 */
  sink?: SpillSink
  /**
   * 超限说明（表头、落盘位置、「用 Read 取」）写不写进正文。缺省 true（旧口径）；false = 正文只留
   * 预览 / 截断后的文字（预览末尾也不再补 `...`），说明经 `header` / `locator` 交回。
   */
  locatorInText?: boolean
}

export interface ProcessToolOutputResult {
  text: string
  truncated: boolean
  persisted: boolean
  originalLines: number
  originalBytes: number
  /** 超限时的表头 `[Output truncated: N lines / X]`（与旧口径正文第一行同一段字）；未超限为 undefined */
  header?: string
  /** 落盘成功时 sink 交回的 locator（模型用 read 工具取回全文的那个位置）；没落盘为 undefined */
  locator?: string
  /** 截掉之后留下的是哪一段（= 入参 strategy）；未超限为 undefined */
  kept?: TruncateStrategy
}

/** 持久化成功时的 preview 行数/字节上限 */
const PREVIEW_MAX_LINES = 200
const PREVIEW_MAX_BYTES = 10 * 1024

const encoder = new TextEncoder()
const byteLen = (s: string): number => encoder.encode(s).length

export async function processToolOutput(
  opts: ProcessToolOutputOptions
): Promise<ProcessToolOutputResult> {
  const {
    toolCallId,
    fullText,
    strategy,
    maxLines = DEFAULT_MAX_LINES,
    maxBytes = DEFAULT_MAX_BYTES,
    sink,
    locatorInText = true
  } = opts

  const originalLines = fullText.split('\n').length
  const originalBytes = byteLen(fullText)

  // 未超限 → 直接通过
  if (originalLines <= maxLines && originalBytes <= maxBytes) {
    return { text: fullText, truncated: false, persisted: false, originalLines, originalBytes }
  }

  const header = `[Output truncated: ${originalLines} lines / ${formatSize(originalBytes)}]`
  const truncatedFields = { truncated: true, originalLines, originalBytes, header, kept: strategy }

  // 超限 → 尝试经 sink 落盘完整内容
  if (sink) {
    const res = await sink.write(toolCallId, fullText).catch(() => null)
    if (res) {
      const preview = applyTruncation(
        fullText,
        strategy,
        Math.min(PREVIEW_MAX_LINES, maxLines),
        Math.min(PREVIEW_MAX_BYTES, maxBytes)
      )
      const text = locatorInText
        ? `${header}\n[Full output saved to: ${res.locator}]\n[IMPORTANT: Use the Read tool (not bash) to view the full output]\n\n` +
          preview.text +
          (preview.truncated ? '\n...' : '')
        : preview.text
      return { ...truncatedFields, text, persisted: true, locator: res.locator }
    }
  }

  // 无 sink / 落盘失败 → 降级为纯截断
  const fallback = applyTruncation(fullText, strategy, maxLines, maxBytes)
  const text = locatorInText ? `${header}\n\n${fallback.text}` : fallback.text
  return { ...truncatedFields, text, persisted: false }
}

/** 截断后留下的那一段，按模型读得懂的说法 */
const KEPT_PART: Record<TruncateStrategy, string> = {
  middle: 'beginning and end',
  'keep-start': 'beginning',
  'keep-end': 'end'
}

/**
 * `locatorInText: false` 时交回的说明 → durable 的工具诊断（模型可见，渲染在结果末尾的 `<harness>`
 * 段里）。未超限交回 undefined。
 *  - 落盘成功：code `spilled`，写明落盘位置与「用 read 工具（不是 bash）取」——
 *    与旧口径正文里的指路同一个意思；
 *  - 只在内存里截断：code `truncated`，写明留下的是哪一段、全文没有留存 —— 不指路（这个 agent
 *    取不回来，或落盘失败了）。
 */
export function truncationDiagnostic(result: ProcessToolOutputResult): ToolDiagnostic | undefined {
  if (!result.truncated) return undefined
  const what = `Output truncated: ${result.originalLines} lines / ${formatSize(result.originalBytes)}`
  if (result.persisted && result.locator !== undefined) {
    return {
      severity: 'info',
      code: 'spilled',
      message: `${what}; full output saved to ${result.locator}. Use the read tool (not bash) to view it.`
    }
  }
  const part = KEPT_PART[result.kept ?? 'middle']
  return {
    severity: 'info',
    code: 'truncated',
    message: `${what}; showing the ${part} only. The full output was not kept.`
  }
}

function applyTruncation(
  text: string,
  strategy: TruncateStrategy,
  maxLines: number,
  maxBytes: number
): { text: string; truncated: boolean; originalLines: number; originalBytes: number } {
  switch (strategy) {
    case 'middle':
      return truncateMiddle(text, maxLines, maxBytes)
    case 'keep-start':
      return truncateKeepStart(text, maxLines, maxBytes)
    case 'keep-end':
      return truncateKeepEnd(text, maxLines, maxBytes)
  }
}
