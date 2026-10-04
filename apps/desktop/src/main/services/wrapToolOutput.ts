/**
 * 统一工具输出后处理包装器
 *
 * 把任何工具的 execute 结果中的文本块过一遍 processToolOutput，
 * 实现 "所有工具输出走同一截断 / 落盘入口"。
 *
 * 单一调用点 — 仅由 agentHost 的 resolveTools 使用。工具本体不应再直接调用 processToolOutput。
 *
 * 形状（P1-04 起）：包装的是 pi-durable 的 `ToolRegistration`，执行签名 `execute(args, api, context)`；
 * 旧形状工具（ask / git / MCP 桥接层，`execute(toolCallId, params, signal)`）先经 `asToolRegistration`
 * 转成 durable 注册项再包。
 * TODO(pi-durable p1): P1-06 改写成 durable 原生的包装器（落盘位置走 diagnostics、outputLimits、
 * taskId 穿进安全模块）；P1-05 之后不再有旧形状工具。
 */

import {
  asToolRegistration,
  takeReviewAllowed,
  toolErrorResult,
  type AnyLegacyAgentTool,
  type AnyTool,
  type SecurityContext,
  type McpAgentToolMeta,
  type ToolContent
} from '@shuvix/agent-runtime'
import type { ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable'
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

/** 工具可以传入的截断阈值覆写；`spill` 由宿主按 agent 给（见 processToolOutput） */
export interface ProcessToolOutputOverrides {
  maxBytes?: number
  maxLines?: number
  /** false = 超限只在内存里截断、不落盘（agent 没有 read 工具取回全文） */
  spill?: boolean
}

/** 包装器收的工具：durable 注册项，或（P1-05 之前的）旧形状工具 */
export type WrappableTool = AnyTool | AnyLegacyAgentTool

/**
 * 包装一个工具 —— execute 返回结果后，把 content 里的文本块过 processToolOutput。
 * 同时把 truncated / persisted OR 进 details（仅当 details 已经声明了对应字段时）。
 *
 * 也是安全模块 **L1 全工具门** 的挂载点：execute（含 preExecute）之前，以
 * {kind:'invocation'} 客体 + 请求的工具维度（toolName/operation）过统一评估 ——
 * 第三方 MCP 这类没有专属资源客体的入口由此可被策略设门（内置能力服务器的工具另带可信的
 * annotations，见 McpInvocationFacts）。
 * 无内置门（未命中规则 = 非事件，不弹窗不记日志）；ask 挂起询问、「其它」反馈转为正常 tool result。
 *
 * 失败的口径（裁定 Q12）：门拒绝（deny 抛错）或工具自己抛错，都收成
 * `{ isError: true, content: [{ type: 'text', text: message }] }` —— 模型看到的就是错误消息本身，
 * 不落进 durable 的 `<harness>[error]` 诊断；取消（context 已 abort）照旧抛。失败结果原样交回，
 * 不过后处理（与旧版一致：抛错从不经过这一层的截断 / 审查标记）。
 *
 * 实现要点：用 Object.create(tool) 让原 tool 成为返回对象的原型，仅把 `execute`
 * 设为 own property 覆盖原方法。这样原型链上的 getter / method / class field
 * 都能正常访问 —— 不要用 `{...tool}` 展开，因为对象 spread 只复制实例自身属性，
 * 会把 class 的 getter（如派发工具的 description、BaseTool 的 outputLimits）静默丢掉，
 * 导致工具描述无法透传给 LLM。本包装器的职责只是改 execute 行为，
 * 不应影响 tool 元数据（name / description / parameters / label / replay 等）。
 */
export function wrapToolOutput(
  tool: WrappableTool,
  sessionId: string,
  strategy: TruncateStrategy,
  overrides?: ProcessToolOutputOverrides,
  /** L1 全工具门的评估门面；缺省 = 不设门（测试/无会话场景） */
  security?: SecurityContext
): AnyTool {
  const inner = asToolRegistration(tool)
  const toolName = inner.name ?? ''

  const wrappedExecute: ToolRegistration['execute'] = async (args, api, context) => {
    const toolCallId = api.callId
    const signal = context.abortSignal

    // ── L1 全工具门（安全模块）：execute（含 preExecute）之前 ──
    if (security) {
      try {
        const rawAction = (args as Record<string, unknown> | undefined)?.action
        const outcome = await security.enforceInvocation({
          toolCallId,
          toolName,
          operation: typeof rawAction === 'string' ? rawAction : undefined,
          // MCP 工具随身带着 server/tool 与（仅内置 server 才可信的）行为提示，
          // 让这道门对它们不再只有「有人要调工具」这一句话可说
          mcp: (tool as Partial<McpAgentToolMeta>).mcpMeta,
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
      result = await inner.execute(args, api, context)
    } catch (err) {
      // 放行之后工具自己失败了：这枚「已审查」标记不会再有人取走，当场丢掉 —— 否则留到上限才被挤掉，
      // 碰上复用 toolCallId 的 provider 还会挂到一次审查员没看过的调用上
      takeReviewAllowed(sessionId, toolCallId)
      if (signal?.aborted) throw err
      return toolErrorResult(err)
    }
    if (result.isError) {
      // 工具交回的失败（BaseTool 模板 / 旧形状桥按 Q12 收口的抛错）：同上丢掉审查标记，原样交回
      takeReviewAllowed(sessionId, toolCallId)
      return result
    }
    let truncated = false
    let persisted = false
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
        // 前一段预览里写的「全文在这里」指向的就是别人的全文
        toolCallId: textIndex++ === 0 ? toolCallId : `${toolCallId}-${textIndex}`,
        fullText: block.text,
        strategy,
        maxBytes: overrides?.maxBytes,
        maxLines: overrides?.maxLines,
        spill: overrides?.spill
      })
      if (proc.truncated) truncated = true
      if (proc.persisted) persisted = true
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

    const newDetails = mergeTruncatedIntoDetails(result.details, truncated, persisted)
    // 自动审查放行了这次调用：在工具结果上留个标记（工具卡上的「已审查」）。写进 details 而不是
    // 广播一个事件，是为了随 toolResult 落盘 —— 实时与重开会话看到的是同一张卡
    const reviewed = takeReviewAllowed(sessionId, toolCallId)
    const details = reviewed ? withToolReview(newDetails, reviewed) : newDetails
    return {
      ...result,
      content: newContent,
      ...(details === undefined ? {} : { details: details as ToolExecutionResult['details'] })
    }
  }

  // Object.create 保留原型链：name / description / label / parameters / replay / outputLimits /
  // 其它 class getter / method 都能通过原型链查找到，仅 execute 被覆盖。
  const wrapped = Object.create(inner) as AnyTool
  Object.defineProperty(wrapped, 'execute', {
    value: wrappedExecute,
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
