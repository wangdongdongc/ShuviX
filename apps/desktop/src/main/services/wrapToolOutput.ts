/**
 * 统一工具输出后处理包装器
 *
 * 把任何 AgentTool 的 execute 结果中的文本块过一遍 processToolOutput，
 * 实现 "所有工具输出走同一截断 / 落盘入口"。
 *
 * 单一调用点 — 仅由 agentToolBuilder.buildTools 和 SubAgentManager.buildSubAgentTools 使用。
 * 工具本体不应再直接调用 processToolOutput。
 */

import type { TSchema } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { processToolOutput, type TruncateStrategy } from '../utils/toolUtils/processToolOutput'
import { hookService } from './hooks'
import { resolveProjectConfig } from './toolContext'
import { createLogger } from '../logger'

const hookLog = createLogger('WrapToolOutput')

/** 工具可以通过这个接口声明自己想要的截断策略；默认 'middle' */
export interface OutputStrategyAware {
  readonly outputStrategy?: TruncateStrategy
}

/** 把 tool 上的 outputStrategy 抽出来（如果有的话） */
export function getOutputStrategy(tool: object): TruncateStrategy {
  const s = (tool as OutputStrategyAware).outputStrategy
  return s ?? 'middle'
}

/** 工具可以传入的截断阈值覆写 */
export interface ProcessToolOutputOverrides {
  maxBytes?: number
  maxLines?: number
}

/**
 * 包装一个 AgentTool —— execute 返回结果后，把 content 里的文本块过 processToolOutput。
 * 同时把 truncated / persisted OR 进 details（仅当 details 已经声明了对应字段时）。
 *
 * 也是 PreToolUse / PostToolUse hook 的挂载点：
 *   - PreToolUse：execute 之前触发；任一 hook 返回 permissionDecision: 'deny' → 工具拒绝执行；
 *     返回 hookSpecificOutput.updatedInput 会重写 params。
 *   - PostToolUse：execute 完成、processToolOutput 截断之后触发；fire-and-forget，仅观察。
 *
 * 实现要点：用 Object.create(tool) 让原 tool 成为返回对象的原型，仅把 `execute`
 * 设为 own property 覆盖原方法。这样原型链上的 getter / method / class field
 * 都能正常访问 —— 不要用 `{...tool}` 展开，因为对象 spread 只复制实例自身属性，
 * 会把 class 的 getter（如曾经的 AgentTool.description getter）静默丢掉，
 * 导致工具描述无法透传给 LLM。本包装器的职责只是改 execute 行为，
 * 不应影响 tool 元数据（name / description / parameters / label 等）。
 */
export function wrapToolOutput<P extends TSchema, D>(
  tool: AgentTool<P, D>,
  sessionId: string,
  strategy: TruncateStrategy,
  overrides?: ProcessToolOutputOverrides
): AgentTool<P, D> {
  const originalExecute = tool.execute.bind(tool)
  // 取工具名用于 hook matcher（默认空串，配 "*" 命中）
  const toolName = (tool as { name?: string }).name ?? ''

  // 懒查并缓存 workingDirectory —— session 生命周期内不变
  let cachedCwd: string | null = null
  const getCwd = (): string => {
    if (cachedCwd != null) return cachedCwd
    try {
      cachedCwd = resolveProjectConfig(sessionId).workingDirectory
    } catch {
      cachedCwd = ''
    }
    return cachedCwd
  }

  const wrappedExecute: AgentTool<P, D>['execute'] = async (
    toolCallId,
    params,
    signal,
    onUpdate
  ) => {
    const cwd = getCwd()
    // ── PreToolUse hook ──
    let effectiveParams = params
    const preOutputs = await hookService.fire('PreToolUse', {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: toolName,
      tool_input: params as unknown
    })
    for (const out of preOutputs) {
      const decision = out.hookSpecificOutput?.permissionDecision
      if (decision === 'deny') {
        const reason = out.hookSpecificOutput?.reason ?? 'blocked by hook'
        hookLog.warn(`PreToolUse deny tool=${toolName} reason=${reason}`)
        return {
          content: [{ type: 'text', text: `[hook blocked] ${reason}` }],
          details: undefined as unknown as D,
          isError: true
        }
      }
      if (out.hookSpecificOutput?.updatedInput !== undefined) {
        effectiveParams = out.hookSpecificOutput.updatedInput as typeof params
      }
    }

    const result = await originalExecute(toolCallId, effectiveParams, signal, onUpdate)
    let truncated = false
    let persisted = false
    const newContent: typeof result.content = []
    for (const block of result.content) {
      if (block.type !== 'text') {
        newContent.push(block)
        continue
      }
      const proc = await processToolOutput({
        sessionId,
        toolCallId,
        fullText: block.text,
        strategy,
        maxBytes: overrides?.maxBytes,
        maxLines: overrides?.maxLines
      })
      if (proc.truncated) truncated = true
      if (proc.persisted) persisted = true
      newContent.push({ ...block, text: proc.text })
    }
    const newDetails = mergeTruncatedIntoDetails(result.details, truncated, persisted)
    const wrappedResult = { ...result, content: newContent, details: newDetails }

    // ── PostToolUse hook（fire-and-forget：不影响返回结果） ──
    void hookService
      .fire('PostToolUse', {
        session_id: sessionId,
        hook_event_name: 'PostToolUse',
        cwd,
        tool_name: toolName,
        tool_input: effectiveParams as unknown,
        tool_output: newContent,
        is_error: Boolean((wrappedResult as { isError?: boolean }).isError)
      })
      .catch((err) =>
        hookLog.warn(`PostToolUse error: ${err instanceof Error ? err.message : String(err)}`)
      )

    return wrappedResult
  }

  // Object.create 保留原型链：name / description / label / parameters / 其它
  // class getter / method 都能通过原型链查找到，仅 execute 被覆盖。
  const wrapped = Object.create(tool) as AgentTool<P, D>
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
