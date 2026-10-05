/**
 * 统一工具输出后处理包装器（pi-durable 原生）—— 桌面这一层。
 *
 * 截断 / 落盘 / 诊断 / (no output) / outputLimits 的内核在 @shuvix/agent-runtime 的
 * `wrapDurableOutput`（宿主无关，落盘口注入）。这里只叠桌面自己的三样：
 *  - 落盘口：`desktopSpillSink(sessionId)` —— 写 `userData/tool_results/<sessionId>/`；
 *  - 安全模块 **L1 全工具门**：工具执行（含 preExecute）之前；
 *  - 自动审查放行的「已审查」标记：写进成功结果的 details。
 *
 * 单一调用点 — 仅由 agentHost 的工具装配使用。工具本体不应再直接调用 processToolOutput。
 *
 * 形状：包装的、交出的都是 pi-durable 的 `ToolRegistration`，执行签名 `execute(args, api, context)`。
 * 两层都用 Object.create 叠在原工具上（门这一层在外，内核那一层在里），工具元数据经原型链透出。
 */

import {
  takeReviewAllowed,
  toolErrorResult,
  wrapDurableOutput,
  outputStrategyOf,
  type AnyTool,
  type SecurityContext,
  type McpToolMeta,
  type SpillMode,
  type TruncateStrategy
} from '@shuvix/agent-runtime'
import type { Context } from '@earendil-works/chord'
import type {
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration
} from '@earendil-works/pi-durable'
import { withToolReview } from '@shuvix/chat-protocol/types/toolReview'
import { desktopSpillSink } from '../utils/toolUtils/processToolOutput'
import { TOOL_ABORTED } from './toolContext'

export type { OutputStrategyAware, SpillMode } from '@shuvix/agent-runtime'

/** 把 tool 上的 outputStrategy 抽出来（如果有的话；缺省 'middle'） */
export function getOutputStrategy(tool: object): TruncateStrategy {
  return outputStrategyOf(tool)
}

/**
 * L1 全工具门的评估门面：固定一个，或按这次调用现取（会话级装配的工具被不同 agent 共用时，
 * 门的主体要是**发起这次调用的** agent —— `api.conversationId` 认得出是谁）。交回 undefined = 这次不设门。
 */
export type SecurityResolver =
  | SecurityContext
  | ((api: ToolExecutionApi, context: Context) => SecurityContext | undefined)

export interface WrapDurableToolOptions {
  /** 落盘归属的会话（`tool_results/<sessionId>/`）与「已审查」标记的会话 */
  sessionId: string
  /** 截断策略；缺省取工具自己的 `outputStrategy`（再缺省 'middle'） */
  strategy?: TruncateStrategy
  /** 字节上限；缺省取工具自己的 `outputMaxBytes`（再缺省 processToolOutput 的默认值） */
  maxBytes?: number
  /** 行数上限；缺省取工具自己的 `outputMaxLines`（再缺省 processToolOutput 的默认值） */
  maxLines?: number
  /** L1 全工具门的评估门面（或按调用现取）；缺省 = 不设门（测试/无会话场景） */
  security?: SecurityResolver
  /** 落不落盘（见 SpillMode：`'auto'` = 这次调用的 agent 工具表里有 read 才落） */
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

/**
 * 包装一个 durable 工具：内核（截断 / 落盘走 diagnostics / outputLimits …，见 wrapDurableOutput）
 * 之上叠 L1 全工具门与「已审查」标记。
 *
 * **L1 全工具门**：execute（含 preExecute）之前，以 {kind:'invocation'} 客体 + 请求的工具维度
 * （toolName/operation）过统一评估 —— 第三方 MCP 这类没有专属资源客体的入口由此可被策略设门
 * （内置能力服务器的工具另带可信的 annotations，见 McpInvocationFacts）。门带着这次调用的 durable
 * taskId / conversationId（询问与审查按 tool task 认人：provider 的 toolCallId 会话内可能重复）。
 * 无内置门（未命中规则 = 非事件，不弹窗不记日志）；ask 挂起询问、「其它」反馈转为正常 tool result
 * （不过后处理）。门拒绝（deny 抛错）按裁定 Q12 收成 isError 结果；取消照旧抛。
 *
 * **「已审查」标记**：自动审查放行了这次调用时，安全模块记下一枚标记；工具成功之后取走、写进
 * details（随 toolResult 落盘 —— 实时与重开会话看到的是同一张卡）。工具失败（isError / 抛错）时
 * 当场丢掉，免得留到上限才被挤掉、或挂到复用 toolCallId 的另一次调用上。
 */
export function wrapDurableTool(tool: WrappableTool, opts: WrapDurableToolOptions): AnyTool {
  const { sessionId, security } = opts
  const toolName = tool.name ?? ''
  const core = wrapDurableOutput(tool, {
    strategy: opts.strategy,
    maxBytes: opts.maxBytes,
    maxLines: opts.maxLines,
    spill: opts.spill,
    sink: desktopSpillSink(sessionId)
  })

  const gatedExecute: ToolRegistration['execute'] = async (args, api, context) => {
    const toolCallId = api.callId
    const signal = context.abortSignal

    // ── L1 全工具门（安全模块）：execute（含 preExecute）之前 ──
    const gate = typeof security === 'function' ? security(api, context) : security
    if (gate) {
      try {
        const rawAction = (args as Record<string, unknown> | undefined)?.action
        const outcome = await gate.enforceInvocation({
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

    let result: ToolExecutionResult
    try {
      // 内核已按 Q12 收口抛错（只有取消会抛到这里）
      result = await core.execute(args, api, context)
    } catch (err) {
      takeReviewAllowed(sessionId, toolCallId)
      throw err
    }
    if (result.isError) {
      takeReviewAllowed(sessionId, toolCallId)
      return result
    }
    const reviewed = takeReviewAllowed(sessionId, toolCallId)
    if (!reviewed) return result
    return {
      ...result,
      details: withToolReview(result.details, reviewed) as ToolExecutionResult['details']
    }
  }

  // 门这一层也只覆盖 execute：outputLimits 与工具元数据都经原型链（内核那一层 → 原工具）透出
  const wrapped = Object.create(core) as AnyTool
  Object.defineProperty(wrapped, 'execute', {
    value: gatedExecute,
    writable: true,
    enumerable: true,
    configurable: true
  })
  return wrapped
}

/**
 * 旧调用形状：位置参数版的 `wrapDurableTool`。`overrides.spill` 缺省 true（= processToolOutput 的缺省：
 * 超限就落盘）。P1-11 起 agentHost 只用 `wrapDurableTool(tool, { sessionId, spill: 'auto', security })`，
 * 这里与 getOutputStrategy / ProcessToolOutputOverrides 只剩单测在用。TODO(pi-durable p1): P1-13 删掉，
 * 单测改调 wrapDurableTool。
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
