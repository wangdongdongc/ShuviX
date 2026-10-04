/**
 * 统一工具输出后处理包装器（pi-durable 原生）
 *
 * 把任何工具的 execute 结果中的文本块过一遍 processToolOutput，
 * 实现 "所有工具输出走同一截断 / 落盘入口"。
 *
 * 单一调用点 — 仅由 agentHost 的工具装配使用。工具本体不应再直接调用 processToolOutput。
 *
 * 形状：包装的、交出的都是 pi-durable 的 `ToolRegistration`，执行签名 `execute(args, api, context)`。
 *
 * 超长输出的去处（迁移决定「Tools (#7)」）：ShuviX 自己的落盘（`tool_results/`）先于 durable 自己的
 * 截断做完 —— 正文只留预览（落盘时 ≤ 200 行 / 10 KB）或内存截断后的文字（≤ 工具的上限），
 * **落盘位置与截断说明不写进正文**，而是作为一条 durable diagnostic 交回（code `spilled` /
 * `truncated`），durable 把它渲染在结果末尾的 `<harness>` 段里。包装后的工具另声明自己的
 * `outputLimits`（工具上限的两倍，见 outputLimits.ts），于是 durable 那一道截断碰不到已经截好的正文。
 *
 * 落不落盘是**按 agent** 的判断（手里有没有 read 取回全文）：`spill: 'auto'` 在这次调用真超限、
 * 要落盘的那一刻现问 `api.agent(context)` 的工具表 —— 同一个注册项挂在不同 agent 的工具表里
 * 也各得其所（会话级装配的内置工具就是这样共用的）。
 */

import {
  takeReviewAllowed,
  toolErrorResult,
  truncationDiagnostic,
  backstopOutputLimits,
  type AnyTool,
  type DurableOutputLimits,
  type SecurityContext,
  type McpToolMeta,
  type ToolContent
} from '@shuvix/agent-runtime'
import type {
  ToolDiagnostic,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration
} from '@earendil-works/pi-durable'
import { withToolReview } from '@shuvix/chat-protocol/types/toolReview'
import { processToolOutput, type TruncateStrategy } from '../utils/toolUtils/processToolOutput'
import { TOOL_ABORTED } from './toolContext'

/** 工具可以通过这个接口声明自己想要的截断策略；默认 'middle' */
export interface OutputStrategyAware {
  readonly outputStrategy?: TruncateStrategy
}

/** 把 tool 上的 outputStrategy 抽出来（如果有的话） */
export function getOutputStrategy(tool: object): TruncateStrategy {
  const s = (tool as OutputStrategyAware).outputStrategy
  return s ?? 'middle'
}

/** 工具身上可读的截断上限声明（BaseTool 的字段；函数式注册项上可能没有） */
interface OutputCaps {
  readonly outputMaxBytes?: number
  readonly outputMaxLines?: number
}

/**
 * 落不落盘：
 *  - `'auto'`：这次调用真要落盘时现问 `api.agent(context)`，工具表里有 `read` 才落（每次调用至多问一次，
 *    没超限的调用一次都不问）；
 *  - `true`：超限就落盘；
 *  - `false`：只在内存里截断（agent 没有 read 工具取回全文）。
 */
export type SpillMode = 'auto' | boolean

export interface WrapDurableToolOptions {
  /** 落盘归属的会话（`tool_results/<sessionId>/`）与「已审查」标记的会话 */
  sessionId: string
  /** 截断策略；缺省取工具自己的 `outputStrategy`（再缺省 'middle'） */
  strategy?: TruncateStrategy
  /** 字节上限；缺省取工具自己的 `outputMaxBytes`（再缺省 processToolOutput 的默认值） */
  maxBytes?: number
  /** 行数上限；缺省取工具自己的 `outputMaxLines`（再缺省 processToolOutput 的默认值） */
  maxLines?: number
  /** L1 全工具门的评估门面；缺省 = 不设门（测试/无会话场景） */
  security?: SecurityContext
  spill: SpillMode
}

/** 工具可以传入的截断阈值覆写；`spill` 由宿主按 agent 给（见 processToolOutput） */
export interface ProcessToolOutputOverrides {
  maxBytes?: number
  maxLines?: number
  /** false = 超限只在内存里截断、不落盘（agent 没有 read 工具取回全文）；缺省 true */
  spill?: boolean
}

/** 包装器收的工具：durable 注册项 */
export type WrappableTool = AnyTool

/** 这一段汇报出来的输出里有没有看得见的字（空白不算 —— 只有空白的结果同样会被 provider 兜底改写） */
function hasVisibleOutput(chunk: string | Uint8Array): boolean {
  if (typeof chunk === 'string') return /\S/.test(chunk)
  // 字节流不解码：任何一个非空白字节都算（UTF-8 的多字节字符没有一个字节是 ASCII 空白）
  return chunk.some((b) => b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d)
}

/**
 * 包装一个 durable 工具 —— execute 返回结果后，把 content 里的文本块过 processToolOutput。
 * 同时把 truncated / persisted OR 进 details（仅当 details 已经声明了对应字段时）。
 *
 * 也是安全模块 **L1 全工具门** 的挂载点：execute（含 preExecute）之前，以
 * {kind:'invocation'} 客体 + 请求的工具维度（toolName/operation）过统一评估 ——
 * 第三方 MCP 这类没有专属资源客体的入口由此可被策略设门（内置能力服务器的工具另带可信的
 * annotations，见 McpInvocationFacts）。门带着这次调用的 durable taskId / conversationId
 * （询问与审查按 tool task 认人：provider 的 toolCallId 会话内可能重复）。
 * 无内置门（未命中规则 = 非事件，不弹窗不记日志）；ask 挂起询问、「其它」反馈转为正常 tool result。
 *
 * 失败的口径（裁定 Q12）：门拒绝（deny 抛错）或工具自己抛错，都收成
 * `{ isError: true, content: [{ type: 'text', text: message }] }` —— 模型看到的就是错误消息本身，
 * 不落进 durable 的 `<harness>[error]` 诊断；取消（context 已 abort）照旧抛。失败结果原样交回，
 * 不过后处理（与旧版一致：抛错从不经过这一层的截断 / 审查标记）。
 *
 * 「(no output)」兜底：工具交回的 content 里既没有非空文本也没有图片时补一个明确的文本块（规避
 * provider 把空结果兜底成 "(see attached image)"）。**工具没给 content、靠 `api.output()` 汇报了
 * 输出时不补** —— durable 会把它留存的那段输出当作结果正文（durable 按 outputLimits 截它，并自带
 * 截断诊断）；只有既没给 content、也没汇报过看得见的输出时才补。
 *
 * 实现要点：用 Object.create(tool) 让原 tool 成为返回对象的原型，仅把 `execute` 与 `outputLimits`
 * 设为 own property 覆盖原成员。这样原型链上的 getter / method / class field
 * 都能正常访问 —— 不要用 `{...tool}` 展开，因为对象 spread 只复制实例自身属性，
 * 会把 class 的 getter（如派发工具的 description）静默丢掉，
 * 导致工具描述无法透传给 LLM。本包装器的职责只是改 execute 行为与截断上限，
 * 不应影响 tool 元数据（name / description / parameters / label / replay 等）。
 */
export function wrapDurableTool(tool: WrappableTool, opts: WrapDurableToolOptions): AnyTool {
  const inner = tool
  const toolName = inner.name ?? ''
  const { sessionId, security, spill } = opts
  const caps = tool as OutputCaps
  const strategy = opts.strategy ?? getOutputStrategy(tool)
  const maxBytes = opts.maxBytes ?? caps.outputMaxBytes
  const maxLines = opts.maxLines ?? caps.outputMaxLines
  // durable 那一道截断只当兜底：工具上限的两倍（一个文本块截完恰在上限之内，两个也碰不到它）
  const outputLimits: DurableOutputLimits = backstopOutputLimits({
    outputStrategy: strategy,
    outputMaxBytes: maxBytes,
    outputMaxLines: maxLines
  })

  const wrappedExecute: ToolRegistration['execute'] = async (args, api, context) => {
    const toolCallId = api.callId
    const signal = context.abortSignal

    // ── L1 全工具门（安全模块）：execute（含 preExecute）之前 ──
    if (security) {
      try {
        const rawAction = (args as Record<string, unknown> | undefined)?.action
        const outcome = await security.enforceInvocation({
          toolCallId,
          taskId: api.taskId,
          conversationId: api.conversationId,
          toolName,
          operation: typeof rawAction === 'string' ? rawAction : undefined,
          // MCP 工具随身带着 server/tool 与（仅内置 server 才可信的）行为提示，
          // 让这道门对它们不再只有「有人要调工具」这一句话可说
          mcp: (tool as Partial<McpToolMeta>).mcpMeta,
          abortError: TOOL_ABORTED,
          onOther: 'return',
          signal
        })
        if (outcome.status === 'feedback') {
          return {
            content: [
              {
                type: 'text',
                text: `Tool was not executed. User responded with feedback instead:\n${outcome.text}`
              }
            ]
          }
        }
      } catch (err) {
        if (signal?.aborted) throw err
        return toolErrorResult(err)
      }
    }

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
      // 放行之后工具自己失败了：这枚「已审查」标记不会再有人取走，当场丢掉 —— 否则留到上限才被挤掉，
      // 碰上复用 toolCallId 的 provider 还会挂到一次审查员没看过的调用上
      takeReviewAllowed(sessionId, toolCallId)
      if (signal?.aborted) throw err
      return toolErrorResult(err)
    }
    if (result.isError) {
      // 工具交回的失败（BaseTool 模板 / 函数式注册项按 Q12 收口的抛错）：同上丢掉审查标记，原样交回
      takeReviewAllowed(sessionId, toolCallId)
      return result
    }

    // 落不落盘：每次调用至多现问一次（同一次调用回好几段超长文本时共用一个答案）
    let spillDecision: Promise<boolean> | undefined
    const decideSpill =
      spill === 'auto'
        ? (): Promise<boolean> =>
            (spillDecision ??= api
              .agent(context)
              .then((agent) => agent.tools.some((t) => t.name === 'read')))
        : spill

    let truncated = false
    let persisted = false
    const diagnostics: ToolDiagnostic[] = []
    let content: ToolContent[] | undefined
    if (result.content === undefined && reportedOutput) {
      // 工具靠 api.output() 汇报：结果正文交给 durable 用它留存的输出，这里不补 (no output)
      content = undefined
    } else {
      const newContent: ToolContent[] = []
      let textIndex = 0
      for (const block of result.content ?? []) {
        if (block.type !== 'text') {
          newContent.push(block)
          continue
        }
        const proc = await processToolOutput({
          sessionId,
          // 一次调用可能回好几段超长文本：每段落自己的文件，不然后一段覆盖前一段，
          // 前一段的诊断里写的「全文在这里」指向的就是别人的全文
          toolCallId: textIndex++ === 0 ? toolCallId : `${toolCallId}-${textIndex}`,
          fullText: block.text,
          strategy,
          maxBytes,
          maxLines,
          spill: decideSpill,
          // 落盘位置 / 截断说明不进正文，下面写成 diagnostic
          locatorInText: false
        })
        if (proc.truncated) truncated = true
        if (proc.persisted) persisted = true
        const diagnostic = truncationDiagnostic(proc)
        if (diagnostic) diagnostics.push(diagnostic)
        newContent.push({ ...block, text: proc.text })
      }
      // 规避 pi-ai provider 序列化的坑：工具结果若无非空文本且无图片，各 provider
      // （openai/anthropic/google/mistral…）会把 content 兜底成 "(see attached image)"，
      // 反而误导模型（例如 grep 无匹配、命令成功但无输出的空结果）。这里统一保证
      // 「成功但无输出」也带一个明确的非空文本块。
      const hasImageBlock = newContent.some((b) => b.type === 'image')
      const hasNonEmptyText = newContent.some((b) => b.type === 'text' && b.text.trim() !== '')
      if (!hasImageBlock && !hasNonEmptyText) {
        const nonText = newContent.filter((b) => b.type !== 'text')
        newContent.length = 0
        newContent.push(...nonText, { type: 'text', text: '(no output)' })
      }
      content = newContent
    }

    const newDetails = mergeTruncatedIntoDetails(result.details, truncated, persisted)
    // 自动审查放行了这次调用：在工具结果上留个标记（工具卡上的「已审查」）。写进 details 而不是
    // 广播一个事件，是为了随 toolResult 落盘 —— 实时与重开会话看到的是同一张卡
    const reviewed = takeReviewAllowed(sessionId, toolCallId)
    const details = reviewed ? withToolReview(newDetails, reviewed) : newDetails
    // 工具自己的诊断在前，截断 / 落盘说明在后（durable 再把 api.diagnostic() 汇报的排在最前）
    const allDiagnostics = [...(result.diagnostics ?? []), ...diagnostics]
    return {
      ...result,
      // content 为 undefined 只出现在「工具本来就没给 content」那一支，展开的 result 里它同样没有
      ...(content === undefined ? {} : { content }),
      ...(details === undefined ? {} : { details: details as ToolExecutionResult['details'] }),
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
 * 旧调用形状（P1-11 改写 agentHost 之前的调用方）：位置参数版的 `wrapDurableTool`。
 * `overrides.spill` 缺省 true（= processToolOutput 的缺省：超限就落盘）。
 */
export function wrapToolOutput(
  tool: WrappableTool,
  sessionId: string,
  strategy: TruncateStrategy,
  overrides?: ProcessToolOutputOverrides,
  /** L1 全工具门的评估门面；缺省 = 不设门（测试/无会话场景） */
  security?: SecurityContext
): AnyTool {
  return wrapDurableTool(tool, {
    sessionId,
    strategy,
    maxBytes: overrides?.maxBytes,
    maxLines: overrides?.maxLines,
    spill: overrides?.spill ?? true,
    security
  })
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
