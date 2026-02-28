/**
 * 并行工具执行协调器
 *
 * 在 pi-agent-core 框架的串行 executeToolCalls 循环外，预先并行启动不需要用户交互的工具。
 * 框架逐个 await tool.execute() 时，wrapper 直接返回预执行的缓存结果。
 *
 * 生命周期协议：
 *   preExecute(toolCallId, params) → 资源初始化（容器创建、连接建立等）
 *   execute(toolCallId, params, signal, onUpdate) → 实际执行（命令运行、文件操作等）
 *
 * 串行工具 / 单工具：preExecute → execute
 * 并行工具：所有 preExecute 逐一执行完毕 → 所有 execute 并行启动
 *
 * 时序：message_end → registerBatch → tool[0].execute → await Promise.resolve()（让出 microtask）
 *       → batch 已注册 → Phase1(preExecute) → Phase2(execute) → 返回预执行结果
 */

import { validateToolArguments, type Tool } from '@mariozechner/pi-ai'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import { resolveProjectConfig } from '../tools/types'
import { sessionDao } from '../dao/sessionDao'
import { createLogger } from '../logger'

const log = createLogger('Parallel')

// ─── 类型 ───────────────────────────────────────────────────

interface ToolCallInfo {
  id: string
  name: string
  arguments: Record<string, unknown>
}

type ToolExecuteFn = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  onUpdate?: (partialResult: AgentToolResult<unknown>) => void
) => Promise<AgentToolResult<unknown>>

/** 资源初始化函数（容器创建、连接建立等），在 execute 之前调用 */
type PreExecuteFn = (toolCallId: string, params: Record<string, unknown>) => Promise<void>

const noopPreExecute: PreExecuteFn = () => Promise.resolve()

interface ToolEntry {
  /** 工具定义（含 TypeBox schema，用于 validateToolArguments） */
  tool: Tool
  /** 原始 execute 函数（未被 wrapper 包装） */
  execute: ToolExecuteFn
  /** 资源初始化函数（默认 no-op） */
  preExecute: PreExecuteFn
}

interface BatchEntry {
  id: string
  name: string
  rawArgs: Record<string, unknown>
  serial: boolean
  /** 预执行的 Promise（仅 parallel 工具） */
  resultPromise?: Promise<AgentToolResult<unknown>>
}

interface Batch {
  entries: BatchEntry[]
  launched: boolean
  abortController?: AbortController
}

// ─── 分类逻辑 ─────────────────────────────────────────────

function requiresSerial(
  sessionId: string,
  toolName: string,
  rawArgs: Record<string, unknown>
): boolean {
  // ask 工具始终需要用户输入
  if (toolName === 'ask') return true

  // bash：sandbox 模式需要审批
  if (toolName === 'bash') {
    try {
      const config = resolveProjectConfig({ sessionId })
      return config.sandboxEnabled
    } catch {
      return true // 无法确定时保守串行
    }
  }

  // ssh connect（无 credentialName）需要凭据输入
  if (toolName === 'ssh' && rawArgs.action === 'connect' && !rawArgs.credentialName) {
    return true
  }

  // ssh exec：检查是否自动审批
  if (toolName === 'ssh' && rawArgs.action === 'exec') {
    try {
      const sess = sessionDao.findById(sessionId)
      const autoApprove = JSON.parse(sess?.settings || '{}').sshAutoApprove === true
      return !autoApprove
    } catch {
      return true
    }
  }

  // shuvix-project update / shuvix-setting set
  if (toolName === 'shuvix-project' && rawArgs.action === 'update') return true
  if (toolName === 'shuvix-setting' && rawArgs.action === 'set') return true

  return false
}

// ─── 协调器 ─────────────────────────────────────────────────

class ParallelExecutionCoordinator {
  /** 每个 session 注册的工具原始 executor */
  private executors = new Map<string, Map<string, ToolEntry>>()

  /** 每个 session 当前活跃的 batch */
  private batches = new Map<string, Batch>()

  /** buildTools 时注册每个工具的原始 execute 和可选的 preExecute */
  registerExecutor(
    sessionId: string,
    toolName: string,
    tool: Tool,
    execute: ToolExecuteFn,
    preExecute?: PreExecuteFn
  ): void {
    let sessionMap = this.executors.get(sessionId)
    if (!sessionMap) {
      sessionMap = new Map()
      this.executors.set(sessionId, sessionMap)
    }
    sessionMap.set(toolName, { tool, execute, preExecute: preExecute ?? noopPreExecute })
  }

  /** handleMessageEnd 时注册当前 turn 的 tool call batch */
  registerBatch(sessionId: string, toolCalls: ToolCallInfo[]): void {
    if (toolCalls.length < 2) return // 单工具无需并行

    const entries: BatchEntry[] = toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      rawArgs: tc.arguments || {},
      serial: requiresSerial(sessionId, tc.name, tc.arguments || {})
    }))

    const parallelCount = entries.filter((e) => !e.serial).length
    if (parallelCount < 2) return // 可并行的工具不足 2 个，无收益

    log.info(
      `注册 batch: session=${sessionId}, 总计 ${entries.length} 个工具, ` +
        `${parallelCount} 个可并行, ${entries.length - parallelCount} 个串行`
    )
    this.batches.set(sessionId, { entries, launched: false })
  }

  /**
   * 工具 wrapper 的统一入口
   * - 无 batch → preExecute + originalExecute（串行）
   * - 当前工具是 serial → preExecute + originalExecute（串行）
   * - batch 未启动 → launchAll()：Phase1(preExecute) + Phase2(execute 并行)
   * - 返回预执行的缓存结果
   */
  async execute(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
    originalExecute: ToolExecuteFn
  ): Promise<AgentToolResult<unknown>> {
    const batch = this.batches.get(sessionId)

    // 无 batch：单工具串行路径，先 preExecute 再 execute
    if (!batch) {
      return this.serialExecute(
        sessionId,
        toolName,
        toolCallId,
        params,
        signal,
        onUpdate,
        originalExecute
      )
    }

    const entry = batch.entries.find((e) => e.id === toolCallId)
    if (!entry) {
      return this.serialExecute(
        sessionId,
        toolName,
        toolCallId,
        params,
        signal,
        onUpdate,
        originalExecute
      )
    }

    // 串行工具：preExecute + execute
    if (entry.serial) {
      return this.serialExecute(
        sessionId,
        toolName,
        toolCallId,
        params,
        signal,
        onUpdate,
        originalExecute
      )
    }

    // 首次进入 parallel 工具时启动整个 batch（Phase1 + Phase2）
    if (!batch.launched) {
      await this.launchAll(sessionId, batch, signal)
    }

    // 返回预执行结果
    if (entry.resultPromise) {
      return entry.resultPromise
    }

    // 兜底：预执行未覆盖到（不应发生），走串行
    return this.serialExecute(
      sessionId,
      toolName,
      toolCallId,
      params,
      signal,
      onUpdate,
      originalExecute
    )
  }

  /** 串行路径：preExecute → execute */
  private async serialExecute(
    sessionId: string,
    toolName: string,
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
    originalExecute: ToolExecuteFn
  ): Promise<AgentToolResult<unknown>> {
    const toolEntry = this.executors.get(sessionId)?.get(toolName)
    if (toolEntry?.preExecute) {
      try {
        await toolEntry.preExecute(toolCallId, params)
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: err instanceof Error ? err.message : String(err) }
          ],
          details: {}
        }
      }
    }
    return originalExecute(toolCallId, params, signal, onUpdate)
  }

  /**
   * Phase 1: 逐一执行所有 parallel 工具的 preExecute（资源初始化）
   * Phase 2: 并行启动所有未失败工具的 execute
   */
  private async launchAll(
    sessionId: string,
    batch: Batch,
    parentSignal?: AbortSignal
  ): Promise<void> {
    batch.launched = true
    const batchAbort = new AbortController()
    batch.abortController = batchAbort

    // 链接 parent signal
    if (parentSignal) {
      if (parentSignal.aborted) {
        batchAbort.abort()
        return
      }
      parentSignal.addEventListener('abort', () => batchAbort.abort(), { once: true })
    }

    const sessionExecutors = this.executors.get(sessionId)
    if (!sessionExecutors) return

    // 预校验参数 & 收集可执行的 entries
    interface PreparedEntry {
      entry: BatchEntry
      toolEntry: ToolEntry
      validatedArgs: Record<string, unknown>
    }
    const prepared: PreparedEntry[] = []

    for (const entry of batch.entries) {
      if (entry.serial) continue

      const toolEntry = sessionExecutors.get(entry.name)
      if (!toolEntry) continue // 工具未注册（如动态 MCP 工具），跳过

      // 校验参数（与框架的 validateToolArguments 一致）
      try {
        const validatedArgs = validateToolArguments(toolEntry.tool, {
          type: 'toolCall',
          id: entry.id,
          name: entry.name,
          arguments: entry.rawArgs
        })
        prepared.push({ entry, toolEntry, validatedArgs })
      } catch (err) {
        entry.resultPromise = Promise.resolve({
          content: [
            { type: 'text' as const, text: err instanceof Error ? err.message : String(err) }
          ],
          details: {}
        })
      }
    }

    // ─── Phase 1: 逐一 preExecute（资源初始化） ─────────────
    for (const { entry, toolEntry, validatedArgs } of prepared) {
      if (batchAbort.signal.aborted) break
      try {
        await toolEntry.preExecute(entry.id, validatedArgs)
      } catch (err) {
        // preExecute 失败 → 存储 error result，跳过 execute
        entry.resultPromise = Promise.resolve({
          content: [
            { type: 'text' as const, text: err instanceof Error ? err.message : String(err) }
          ],
          details: {}
        })
      }
    }

    // ─── Phase 2: 并行启动 execute ──────────────────────────
    let launchedCount = 0
    for (const { entry, toolEntry, validatedArgs } of prepared) {
      // 跳过 preExecute 已失败的 entry（已有 resultPromise）
      if (entry.resultPromise) continue

      entry.resultPromise = toolEntry
        .execute(entry.id, validatedArgs, batchAbort.signal, undefined)
        .catch(
          (err): AgentToolResult<unknown> => ({
            content: [
              { type: 'text' as const, text: err instanceof Error ? err.message : String(err) }
            ],
            details: {}
          })
        )

      launchedCount++
    }

    if (launchedCount > 0) {
      log.info(`并行启动 ${launchedCount} 个工具 session=${sessionId}`)
    }
  }

  /** 取消当前 batch（steering 中断或用户 abort） */
  cancelBatch(sessionId: string): void {
    const batch = this.batches.get(sessionId)
    if (batch?.abortController) {
      batch.abortController.abort()
    }
    this.batches.delete(sessionId)
  }

  /** 清理会话所有状态 */
  clearSession(sessionId: string): void {
    this.cancelBatch(sessionId)
    this.executors.delete(sessionId)
  }
}

export const parallelCoordinator = new ParallelExecutionCoordinator()
