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
import type { SecurityContext } from '@shuvix/agent-runtime'
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

/** 工具可以传入的截断阈值覆写 */
export interface ProcessToolOutputOverrides {
  maxBytes?: number
  maxLines?: number
}

/**
 * 包装一个 AgentTool —— execute 返回结果后，把 content 里的文本块过 processToolOutput。
 * 同时把 truncated / persisted OR 进 details（仅当 details 已经声明了对应字段时）。
 *
 * 也是安全模块 **L1 全工具门** 的挂载点：execute（含 preExecute）之前，以
 * {kind:'invocation'} 客体 + 请求的工具维度（toolName/operation）过统一评估 ——
 * MCP/browser/database 等尚无专属资源客体的入口由此可被策略设门。
 * 无内置门（未命中规则 = 非事件，不弹窗不记日志）；deny throw、ask 挂起询问、
 * 「其它」反馈转为正常 tool result。先于 preExecute，故 ssh 的凭据抢跑连接也被覆盖。
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
  overrides?: ProcessToolOutputOverrides,
  /** L1 全工具门的评估门面；缺省 = 不设门（测试/无会话场景） */
  security?: SecurityContext
): AgentTool<P, D> {
  const originalExecute = tool.execute.bind(tool)
  const toolName = (tool as { name?: string }).name ?? ''

  const wrappedExecute: AgentTool<P, D>['execute'] = async (
    toolCallId,
    params,
    signal,
    onUpdate
  ) => {
    // ── L1 全工具门（安全模块）：execute（含 preExecute）之前 ──
    if (security) {
      const rawAction = (params as Record<string, unknown> | undefined)?.action
      const outcome = await security.enforceInvocation({
        toolCallId,
        toolName,
        operation: typeof rawAction === 'string' ? rawAction : undefined,
        abortError: TOOL_ABORTED,
        onOther: 'return'
      })
      if (outcome.status === 'feedback') {
        return {
          content: [
            {
              type: 'text',
              text: `Tool was not executed. User responded with feedback instead:\n${outcome.text}`
            }
          ],
          details: undefined as unknown as D
        }
      }
    }

    const result = await originalExecute(toolCallId, params, signal, onUpdate)
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
    return { ...result, content: newContent, details: newDetails }
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
