/**
 * 扩展工具输出包装（轻量）—— 把每个工具的文本输出过共享 processToolOutput（截断 + 经 sink 落盘），
 * 并（当传入 hookCtx 时）挂各端共享的 PreToolUse / PostToolUse 内置 hook：
 * - PreToolUse：execute 前触发；`deny` → 拒绝执行；`updatedInput` → 改写参数
 * - PostToolUse：execute 后触发；fire-and-forget，仅观察
 *
 * hook 引擎为扩展的 {@link hookEngine} 单例（仅 builtin）；桌面对应完整 HookService。
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { processToolOutput, type SpillSink, type TruncateStrategy } from '@shuvix/agent-runtime'
import { hookEngine } from './hooks'

/** 触发 hook 所需的会话上下文（缺省则不挂 Pre/PostToolUse） */
export interface HookCtx {
  sessionId: string
  cwd: string
}

/** 包装单个工具：execute 前后挂 hook + 文本块过 processToolOutput（保留原型链，仅覆盖 execute） */
export function wrapToolOutput(tool: AgentTool, sink: SpillSink, hookCtx?: HookCtx): AgentTool {
  const originalExecute = tool.execute.bind(tool)
  const strategy: TruncateStrategy =
    (tool as { outputStrategy?: TruncateStrategy }).outputStrategy ?? 'middle'
  const toolName = (tool as { name?: string }).name ?? ''

  const wrappedExecute: AgentTool['execute'] = async (toolCallId, params, signal, onUpdate) => {
    let effectiveParams = params
    // ── PreToolUse hook ──
    if (hookCtx) {
      const preOutputs = await hookEngine.fire('PreToolUse', {
        session_id: hookCtx.sessionId,
        hook_event_name: 'PreToolUse',
        cwd: hookCtx.cwd,
        tool_name: toolName,
        tool_input: params as unknown
      })
      for (const out of preOutputs) {
        if (out.hookSpecificOutput?.permissionDecision === 'deny') {
          const reason = out.hookSpecificOutput?.reason ?? 'blocked by hook'
          return {
            content: [{ type: 'text', text: `[hook blocked] ${reason}` }],
            details: undefined as never,
            isError: true
          }
        }
        if (out.hookSpecificOutput?.updatedInput !== undefined) {
          effectiveParams = out.hookSpecificOutput.updatedInput as typeof params
        }
      }
    }

    const result = await originalExecute(toolCallId, effectiveParams, signal, onUpdate)
    const newContent: typeof result.content = []
    for (const block of result.content) {
      if (block.type !== 'text') {
        newContent.push(block)
        continue
      }
      const proc = await processToolOutput({ toolCallId, fullText: block.text, strategy, sink })
      newContent.push({ ...block, text: proc.text })
    }
    const wrappedResult = { ...result, content: newContent }

    // ── PostToolUse hook（fire-and-forget） ──
    if (hookCtx) {
      void hookEngine
        .fire('PostToolUse', {
          session_id: hookCtx.sessionId,
          hook_event_name: 'PostToolUse',
          cwd: hookCtx.cwd,
          tool_name: toolName,
          tool_input: effectiveParams as unknown,
          tool_output: newContent,
          is_error: Boolean((wrappedResult as { isError?: boolean }).isError)
        })
        .catch(() => {})
    }

    return wrappedResult
  }

  const wrapped = Object.create(tool) as AgentTool
  Object.defineProperty(wrapped, 'execute', {
    value: wrappedExecute,
    writable: true,
    enumerable: true,
    configurable: true
  })
  return wrapped
}

/** 批量包装 */
export function wrapToolsOutput(
  tools: AgentTool[],
  sink: SpillSink,
  hookCtx?: HookCtx
): AgentTool[] {
  return tools.map((t) => wrapToolOutput(t, sink, hookCtx))
}
