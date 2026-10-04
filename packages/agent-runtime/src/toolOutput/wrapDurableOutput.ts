/**
 * 工具输出后处理包装器的宿主无关内核（pi-durable 原生）—— 把一个 durable 注册项（BaseTool 子类或
 * 函数式注册项）包成「结果文本统一过截断 / 落盘」的注册项。
 *
 * 超长输出的去处（迁移决定「Tools (#7)」）：ShuviX 自己的落盘先于 durable 自己的截断做完 —— 正文
 * 只留预览（落盘时 ≤ 200 行 / 10 KB）或内存截断后的文字（≤ 工具的上限），**落盘位置与截断说明不写进
 * 正文**，而是作为一条 durable diagnostic 交回（code `spilled` / `truncated`，见 truncationDiagnostic），
 * durable 把它渲染在结果末尾的 `<harness>` 段里。包装后的注册项另声明自己的 `outputLimits`（实际
 * 所用上限的两倍，见 outputLimits.ts），于是 durable 那一道截断碰不到已经截好的正文。
 *
 * 落盘介质由宿主注入（`sink`，即 SpillSink：桌面写 `tool_results/<sessionId>/`，测试给内存表）；
 * 本模块不碰文件系统。没给 sink = 永不落盘，只在内存里截断。
 *
 * 落不落盘是**按 agent** 的判断（手里有没有 read 取回全文）：`spill: 'auto'` 在这次调用真有文本
 * 超限、要落盘的那一刻现问 `api.agent(context)` 的工具表（每次调用至多问一次；问不出 = 不落盘）——
 * 同一个注册项挂在不同 agent 的工具表里也各得其所（会话级装配的内置工具就是这样共用的）。
 *
 * 其余口径：
 *  - 失败（裁定 Q12）：工具抛错收成 `{ isError: true, content: [{ type: 'text', text: message }] }`，
 *    取消（context 已 abort）照旧抛；工具交回的 isError 结果原样交回，不过后处理；
 *  - 「(no output)」：结果 content 里既没有非空文本也没有图片时补一个明确的文本块（规避 provider
 *    把空结果兜底成 "(see attached image)"）；**工具没给 content、靠 `api.output()` 汇报过看得见的
 *    输出时不补** —— durable 会把它留存的输出当作正文（按 outputLimits 截，并自带截断诊断）；
 *  - details 声明了 `truncated` / `persisted` 的，把这次的截断 / 落盘 OR 进去（没声明的不添字段）。
 *
 * 实现要点：用 Object.create(tool) 让原 tool 成为返回对象的原型，仅把 `execute` 与 `outputLimits`
 * 设为 own property。原型链上的 getter / method / class field 照常可读 —— 不要用 `{...tool}` 展开：
 * 对象 spread 只复制实例自身属性，会把 class 的 getter（派发工具的 description 等）静默丢掉。
 * 宿主在它之上再叠自己的层（桌面：L1 全工具门、「已审查」标记）时同样用 Object.create。
 */
import type {
  ToolDiagnostic,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration
} from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord'
import { backstopOutputLimits, type DurableOutputLimits } from '../tools/outputLimits'
import { toolErrorResult, type AnyTool, type ToolContent } from '../tools/toolResult'
import {
  processToolOutput,
  truncationDiagnostic,
  type SpillSink,
  type TruncateStrategy
} from './spill'

/**
 * 落不落盘：
 *  - `'auto'`：这次调用真要落盘时现问 `api.agent(context)`，工具表里有 `read` 才落；
 *  - `true`：超限就落盘（有 sink 的话）；
 *  - `false`：只在内存里截断（agent 没有 read 工具取回全文）。
 */
export type SpillMode = 'auto' | boolean

export interface WrapDurableOutputOptions {
  /** 截断策略；缺省取工具自己的 `outputStrategy`（再缺省 'middle'） */
  strategy?: TruncateStrategy
  /** 字节上限；缺省取工具自己的 `outputMaxBytes`（再缺省 processToolOutput 的默认值） */
  maxBytes?: number
  /** 行数上限；缺省取工具自己的 `outputMaxLines`（再缺省 processToolOutput 的默认值） */
  maxLines?: number
  spill: SpillMode
  /**
   * 落盘口（宿主注入）：`write(spillId, fullText)` 把一段全文存下来，交回模型能用 read 取回的
   * locator；交回 null（或抛错）= 没存成，降级为内存截断。`spillId` 是这次调用的 `api.callId`，
   * 同一次调用的第 n（≥ 2）段超长文本是 `<callId>-<n>`。会话归属由宿主绑在 sink 上。
   * 不给 = 永不落盘。
   */
  sink?: SpillSink
}

/** 工具可以通过这个接口声明自己想要的截断策略；缺省 'middle' */
export interface OutputStrategyAware {
  readonly outputStrategy?: TruncateStrategy
}

/** 工具身上声明的截断策略（BaseTool 的字段；函数式注册项上可能没有 → 'middle'） */
export function outputStrategyOf(tool: object): TruncateStrategy {
  return (tool as OutputStrategyAware).outputStrategy ?? 'middle'
}

/** 工具身上可读的截断上限声明（BaseTool 的字段；函数式注册项上可能没有） */
interface OutputCaps {
  readonly outputMaxBytes?: number
  readonly outputMaxLines?: number
}

/** 这一段汇报出来的输出里有没有看得见的字（空白不算 —— 只有空白的结果同样会被 provider 兜底改写） */
function hasVisibleOutput(chunk: string | Uint8Array): boolean {
  if (typeof chunk === 'string') return /\S/.test(chunk)
  // 字节流不解码：任何一个非空白字节都算（UTF-8 的多字节字符没有一个字节是 ASCII 空白）
  return chunk.some((b) => b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d)
}

/**
 * 这次调用用的落盘口：`false` / 没有 sink → 不落；`true` → 原样；`'auto'` → 写之前先问工具表
 * （至多一次；答「不落」或问不出 → 交回 null，内核按「没存成」降级为内存截断）。
 */
function spillSinkFor(
  sink: SpillSink | undefined,
  spill: SpillMode,
  api: ToolExecutionApi,
  context: Context
): SpillSink | undefined {
  if (sink === undefined || spill === false) return undefined
  if (spill === true) return sink
  let decision: Promise<boolean> | undefined
  const canRead = (): Promise<boolean> =>
    (decision ??= api
      .agent(context)
      .then((agent) => agent.tools.some((t) => t.name === 'read'))
      .catch(() => false))
  return {
    write: async (spillId, fullText) => ((await canRead()) ? sink.write(spillId, fullText) : null)
  }
}

/**
 * 包装一个 durable 工具 —— execute 返回结果后，把 content 里的文本块过 processToolOutput
 * （说明不进正文，写成 diagnostic），并补齐 (no output) / details 合并 / 包装后的 outputLimits。
 */
export function wrapDurableOutput(tool: AnyTool, opts: WrapDurableOutputOptions): AnyTool {
  const inner = tool
  const caps = tool as OutputCaps
  const strategy = opts.strategy ?? outputStrategyOf(tool)
  const maxBytes = opts.maxBytes ?? caps.outputMaxBytes
  const maxLines = opts.maxLines ?? caps.outputMaxLines
  const { spill, sink } = opts
  // durable 那一道截断只当兜底：实际所用上限的两倍（一个文本块截完恰在上限之内，两个也碰不到它）
  const outputLimits: DurableOutputLimits = backstopOutputLimits({
    outputStrategy: strategy,
    outputMaxBytes: maxBytes,
    outputMaxLines: maxLines
  })

  const wrappedExecute: ToolRegistration['execute'] = async (args, api, context) => {
    // api 是普通对象（durable 明说包装器可以展开它）：只换掉 output，记下工具有没有经它汇报过输出
    let reportedOutput = false
    const trackedApi: ToolExecutionApi = {
      ...api,
      output: (chunk) => {
        if (!reportedOutput && hasVisibleOutput(chunk)) reportedOutput = true
        api.output(chunk)
      }
    }

    let result: ToolExecutionResult
    try {
      result = await inner.execute(args, trackedApi, context)
    } catch (err) {
      if (context.abortSignal?.aborted) throw err
      return toolErrorResult(err)
    }
    // 工具交回的失败（BaseTool 模板 / 函数式注册项按 Q12 收口的抛错）：原样交回，不过后处理
    if (result.isError) return result

    // 工具靠 api.output() 汇报：结果正文交给 durable 用它留存的输出，这里既不截也不补 (no output)
    if (result.content === undefined && reportedOutput) return result

    const callSink = spillSinkFor(sink, spill, api, context)
    let truncated = false
    let persisted = false
    const diagnostics: ToolDiagnostic[] = []
    const content: ToolContent[] = []
    let textIndex = 0
    for (const block of result.content ?? []) {
      if (block.type !== 'text') {
        content.push(block)
        continue
      }
      const proc = await processToolOutput({
        // 一次调用可能回好几段超长文本：每段落自己的文件，不然后一段覆盖前一段，
        // 前一段的诊断里写的「全文在这里」指向的就是别人的全文
        toolCallId: textIndex++ === 0 ? api.callId : `${api.callId}-${textIndex}`,
        fullText: block.text,
        strategy,
        maxBytes,
        maxLines,
        sink: callSink,
        // 落盘位置 / 截断说明不进正文，下面写成 diagnostic
        locatorInText: false
      })
      if (proc.truncated) truncated = true
      if (proc.persisted) persisted = true
      const diagnostic = truncationDiagnostic(proc)
      if (diagnostic) diagnostics.push(diagnostic)
      content.push({ ...block, text: proc.text })
    }
    // 规避 pi-ai provider 序列化的坑：工具结果若无非空文本且无图片，各 provider
    // （openai/anthropic/google/mistral…）会把 content 兜底成 "(see attached image)"，
    // 反而误导模型（例如 grep 无匹配、命令成功但无输出的空结果）。这里统一保证
    // 「成功但无输出」也带一个明确的非空文本块。
    const hasImageBlock = content.some((b) => b.type === 'image')
    const hasNonEmptyText = content.some((b) => b.type === 'text' && b.text.trim() !== '')
    if (!hasImageBlock && !hasNonEmptyText) {
      const nonText = content.filter((b) => b.type !== 'text')
      content.length = 0
      content.push(...nonText, { type: 'text', text: '(no output)' })
    }

    const details = mergeTruncatedIntoDetails(result.details, truncated, persisted)
    // 工具自己的诊断在前，截断 / 落盘说明在后（durable 再把 api.diagnostic() 汇报的排在最前）
    const allDiagnostics = [...(result.diagnostics ?? []), ...diagnostics]
    return {
      ...result,
      content,
      ...(details === undefined ? {} : { details }),
      ...(allDiagnostics.length === 0 ? {} : { diagnostics: allDiagnostics })
    }
  }

  // Object.create 保留原型链：name / description / label / parameters / replay /
  // 其它 class getter / method 都能通过原型链查找到，仅 execute 与 outputLimits 被覆盖。
  const wrapped = Object.create(inner) as AnyTool
  Object.defineProperty(wrapped, 'execute', {
    value: wrappedExecute,
    writable: true,
    enumerable: true,
    configurable: true
  })
  // BaseTool 的 outputLimits 是原型上的 getter：own 数据属性遮住它（按包装器实际用的上限算）
  Object.defineProperty(wrapped, 'outputLimits', {
    value: outputLimits,
    writable: true,
    enumerable: true,
    configurable: true
  })
  return wrapped
}

/**
 * 把 truncated / persisted OR 进 details 对象 ——
 * 只在 details 本来就有同名字段时合并，避免给那些没声明这两个字段的 details 类型偷偷加字段。
 */
function mergeTruncatedIntoDetails<D>(details: D, truncated: boolean, persisted: boolean): D {
  if (!details || typeof details !== 'object') return details
  const d = details as unknown as Record<string, unknown>
  const out: Record<string, unknown> = { ...d }
  if ('truncated' in d) out.truncated = Boolean(d.truncated) || truncated
  if ('persisted' in d) out.persisted = Boolean(d.persisted) || persisted
  return out as unknown as D
}
