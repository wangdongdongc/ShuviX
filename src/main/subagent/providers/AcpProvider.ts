/**
 * AcpProvider — ACP (Agent Client Protocol) 子智能体
 *
 * 完整管理外部 ACP Agent（如 Claude Code、Gemini CLI 等）的生命周期：
 * - 按 ShuviX sessionId + agentName 复用 ACP session（保持对话上下文）
 * - spawn 进程 → ACP 握手 → session 管理 → prompt 执行 → 结果收集
 * - sessionUpdate 通知转译为 subagent_* ChatEvent 广播到 UI
 * - requestPermission 桥接到 ShuviX 审批 UI
 *
 * 每个 AcpAgentConfig 对应一个 AcpProvider 实例。
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { Readable, Writable } from 'stream'
import { v4 as uuid } from 'uuid'
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import type {
  AnyMessage,
  Client,
  Agent,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  Stream,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate
} from '@agentclientprotocol/sdk'
import { chatFrontendRegistry, type ChatEvent } from '../../frontend'
import { resolveProjectConfig } from '../../tools/types'
import type { ToolContext } from '../../tools/types'
import { mergedPATH } from '../../utils/paths'
import type { SubAgentProvider, SubAgentRunParams, SubAgentRunResult } from '../types'
import { createLogger } from '../../logger'

const log = createLogger('AcpProvider')

// ─── ACP Agent 配置 ──────────────────────────────────

/** 通用 ACP Agent 配置 */
export interface AcpAgentConfig {
  /** 工具名（注册到 ALL_TOOL_NAMES 中的标识符） */
  name: string
  /** 展示名 */
  displayName: string
  /** 可执行文件名或路径（用户需自行安装到 PATH） */
  command: string
  /** 启动参数 */
  args: string[]
  /** 额外环境变量 */
  env?: Record<string, string>
  /** 工具描述（告诉 LLM 何时使用此工具） */
  description: string
}

/**
 * 内置 ACP Agent 列表
 *
 * 用户需自行安装对应 CLI 工具到 PATH：
 *   npm install -g @anthropic-ai/claude-code
 */
export const BUILTIN_ACP_AGENTS: AcpAgentConfig[] = [
  {
    name: 'claude-code',
    displayName: 'Claude Code',
    command: 'claude-agent-acp',
    args: [],
    description: `Delegate complex coding tasks to Claude Code, an autonomous AI coding agent.
Use this tool for tasks that require:
- Multi-file changes across a codebase
- Complex refactoring or architecture changes
- Writing new features with tests
- Debugging and fixing complex issues
- Code exploration and analysis across many files

Claude Code has its own set of tools (bash, read, write, edit, grep, glob) and operates independently.
It does NOT have access to your conversation history — provide all necessary context in the prompt.

The prompt should clearly describe the task, including:
- What needs to be done
- Which files or directories are relevant
- Any constraints or preferences`
  }
]

// ─── ACP 协议日志 ──────────────────────────────────────

/** 包装 ACP Stream，打印双向所有 JSON-RPC 消息 */
function withProtocolLogging(stream: Stream, _label: string): Stream {
  const originalWritable = stream.writable
  const loggedWritable = new WritableStream<AnyMessage>({
    write(message) {
      // log.debug(`[ACP:${label}] ──▶ SEND`, JSON.stringify(message, null, 2))
      const writer = originalWritable.getWriter()
      return writer.write(message).finally(() => writer.releaseLock())
    },
    close() {
      return originalWritable.close()
    },
    abort(reason) {
      return originalWritable.abort(reason)
    }
  })

  const loggedReadable = stream.readable.pipeThrough(
    new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        // log.debug(`[ACP:${label}] ◀── RECV`, JSON.stringify(message, null, 2))
        controller.enqueue(message)
      }
    })
  )

  return { writable: loggedWritable, readable: loggedReadable }
}

// ─── 内部类型 ──────────────────────────────────────────

/** 当前正在执行的任务状态（可变引用，每次 prompt 更新） */
interface TaskState {
  taskId: string
  ctx: ToolContext
  acpToolCallMap: Map<string, string>
  resultBuffer: string
  onEvent: (event: ChatEvent) => void
}

/** 缓存的 ACP 会话（按 sessionId:agentName 复用） */
interface CachedAcpSession {
  process: ChildProcess
  connection: ClientSideConnection
  acpSessionId: string
  config: AcpAgentConfig
  cacheKey: string
  shuvixSessionId: string
  stderrBuffer: string
  /** 当前活跃任务（null = 空闲，进程仍保持运行） */
  taskState: TaskState | null
}

// ─── 全局 session 缓存（所有 AcpProvider 实例共享） ──────

/** 缓存的 ACP 会话：key = `${shuvixSessionId}:${agentName}` */
const cachedSessions = new Map<string, CachedAcpSession>()

// ─── Provider 实现 ──────────────────────────────────────

export class AcpProvider implements SubAgentProvider {
  readonly name: string
  readonly displayName: string
  readonly description: string

  constructor(private config: AcpAgentConfig) {
    this.name = config.name
    this.displayName = config.displayName
    this.description = config.description
  }

  async runTask(params: SubAgentRunParams): Promise<SubAgentRunResult> {
    const { ctx, toolCallId, prompt, description, signal, onEvent } = params
    const taskId = uuid()
    const cacheKey = `${ctx.sessionId}:${this.config.name}`

    // 广播 subagent_start
    onEvent({
      type: 'subagent_start',
      sessionId: ctx.sessionId,
      subAgentId: taskId,
      subAgentType: this.config.name,
      description,
      parentToolCallId: toolCallId
    })

    try {
      const result = await this._executeOnSession({
        cacheKey,
        ctx,
        taskId,
        prompt,
        signal,
        onEvent
      })

      onEvent({
        type: 'subagent_end',
        sessionId: ctx.sessionId,
        subAgentId: taskId,
        subAgentType: this.config.name,
        result
      })

      return { taskId, result }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)

      onEvent({
        type: 'subagent_end',
        sessionId: ctx.sessionId,
        subAgentId: taskId,
        subAgentType: this.config.name,
        result: `Error: ${errMsg}`
      })

      throw err
    }
  }

  destroy(sessionId: string): void {
    const cacheKey = `${sessionId}:${this.config.name}`
    const cached = cachedSessions.get(cacheKey)
    if (!cached) return

    log.info(`Destroying session ${cacheKey}`)
    killAndCleanup(cached)
  }

  abortAll(sessionId: string): void {
    for (const [key, cached] of cachedSessions) {
      if (key.startsWith(sessionId + ':')) {
        log.info(`Destroying session ${key}`)
        killAndCleanup(cached)
      }
    }
  }

  /** 检测 Agent 可执行文件是否在 PATH 中 */
  resolveExecutable(): { cmd: string; args: string[] } | null {
    const result = spawnSync(
      process.platform === 'win32' ? 'where' : 'which',
      [this.config.command],
      {
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, PATH: mergedPATH }
      }
    )
    if (result.status === 0 && result.stdout.trim()) {
      return { cmd: this.config.command, args: [...this.config.args] }
    }

    log.warn(`Command "${this.config.command}" not found in PATH`)
    return null
  }

  // ─── 内部实现 ──────────────────────────────────────

  /** 在已有或新建的 ACP session 上执行 prompt */
  private async _executeOnSession(params: {
    cacheKey: string
    ctx: ToolContext
    taskId: string
    prompt: string
    signal?: AbortSignal
    onEvent: (event: ChatEvent) => void
  }): Promise<string> {
    const { cacheKey, ctx, taskId, prompt, signal, onEvent } = params

    // 获取或创建缓存会话
    let cached = cachedSessions.get(cacheKey)

    // 进程已死 → 清理缓存
    if (cached && cached.process.killed) {
      log.info(`Cached session for ${cacheKey} process is dead, creating new one`)
      cachedSessions.delete(cacheKey)
      cached = undefined
    }

    if (!cached) {
      cached = await this._createSession({
        cacheKey,
        shuvixSessionId: ctx.sessionId,
        ctx,
        taskId,
        onEvent
      })
      cachedSessions.set(cacheKey, cached)

      // 广播 acp_event: session_created
      chatFrontendRegistry.broadcast({
        type: 'acp_event',
        sessionId: ctx.sessionId,
        action: 'session_created',
        agentName: this.config.name,
        displayName: this.config.displayName
      })
    }

    // 更新当前任务状态（可变引用，connection handlers 通过 cached.taskState 读取）
    cached.taskState = {
      taskId,
      ctx,
      acpToolCallMap: new Map(),
      resultBuffer: '',
      onEvent
    }

    // signal 联动：取消当前 prompt（不 kill 进程，保留 session）
    let signalCleanup: (() => void) | null = null
    if (signal) {
      const onAbort = (): void => {
        if (cached!.connection && cached!.acpSessionId) {
          cached!.connection.cancel({ sessionId: cached!.acpSessionId }).catch(() => {})
        }
      }
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
        signalCleanup = () => signal.removeEventListener('abort', onAbort)
      }
    }

    try {
      const promptResp = await cached.connection.prompt({
        sessionId: cached.acpSessionId,
        prompt: [{ type: 'text', text: prompt }]
      })

      const result =
        cached.taskState?.resultBuffer ||
        (promptResp.stopReason === 'cancelled'
          ? 'Task was cancelled.'
          : 'Task completed (no output captured).')

      return result
    } catch (err) {
      // 进程意外退出时清理缓存
      if (cached.process.killed && cachedSessions.get(cacheKey) === cached) {
        cachedSessions.delete(cacheKey)
      }

      if (signal?.aborted) {
        return cached.taskState?.resultBuffer || 'Task was aborted.'
      }

      const errMsg = err instanceof Error ? err.message : String(err)
      if (cached.stderrBuffer) {
        log.error(`${this.config.name} stderr:\n${cached.stderrBuffer.slice(-2000)}`)
      }
      throw new Error(`ACP Agent "${this.config.displayName}" error: ${errMsg}`)
    } finally {
      signalCleanup?.()
      if (cached.taskState?.taskId === taskId) {
        cached.taskState = null
      }
    }
  }

  /** 创建新的 ACP session（spawn + 握手 + newSession） */
  private async _createSession(params: {
    cacheKey: string
    shuvixSessionId: string
    ctx: ToolContext
    taskId: string
    onEvent: (event: ChatEvent) => void
  }): Promise<CachedAcpSession> {
    const { cacheKey, shuvixSessionId, ctx, taskId, onEvent } = params
    const projectConfig = resolveProjectConfig(shuvixSessionId)
    const cwd = projectConfig.workingDirectory

    const resolved = this.resolveExecutable()
    if (!resolved) {
      throw new Error(
        `ACP Agent "${this.config.displayName}" executable not found. ` +
          `Ensure "${this.config.command}" is installed and available in PATH.`
      )
    }

    const child = spawn(resolved.cmd, resolved.args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...this.config.env,
        NODE_NO_WARNINGS: '1',
        PATH: mergedPATH
      }
    })

    const config = this.config
    const cached: CachedAcpSession = {
      process: child,
      connection: undefined as unknown as ClientSideConnection,
      acpSessionId: '',
      config,
      cacheKey,
      shuvixSessionId,
      stderrBuffer: '',
      taskState: {
        taskId,
        ctx,
        acpToolCallMap: new Map(),
        resultBuffer: '',
        onEvent
      }
    }

    // 进程退出时自动清理缓存 + 广播销毁事件
    child.on('exit', () => {
      if (cachedSessions.get(cacheKey) === cached) {
        cachedSessions.delete(cacheKey)
        chatFrontendRegistry.broadcast({
          type: 'acp_event',
          sessionId: shuvixSessionId,
          action: 'session_destroyed',
          agentName: config.name,
          displayName: config.displayName
        })
      }
    })

    // 收集 stderr 日志
    child.stderr?.on('data', (chunk: Buffer) => {
      cached.stderrBuffer += chunk.toString()
      if (cached.stderrBuffer.length > 10000) {
        cached.stderrBuffer = cached.stderrBuffer.slice(-5000)
      }
    })

    // 将 Node Stream 转为 Web Stream（ACP SDK 需要）
    const inputStream = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
    const outputStream = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>

    // 建立 ACP 连接（带协议日志）
    const rawStream = ndJsonStream(outputStream, inputStream)
    const stream = withProtocolLogging(rawStream, config.name)

    const connection = new ClientSideConnection(
      (_agent: Agent): Client => ({
        // sessionUpdate 通知处理
        sessionUpdate: async (notification: SessionNotification): Promise<void> => {
          const ts = cached.taskState
          if (!ts) return
          handleSessionUpdate(
            notification.update,
            ts.ctx.sessionId,
            ts.taskId,
            config.name,
            ts.acpToolCallMap,
            ts.onEvent,
            (text: string) => {
              if (cached.taskState) cached.taskState.resultBuffer += text
            }
          )
        },

        // requestPermission 桥接到 ShuviX 审批 UI
        requestPermission: async (
          reqParams: RequestPermissionRequest
        ): Promise<RequestPermissionResponse> => {
          const ts = cached.taskState
          if (!ts) return { outcome: { outcome: 'cancelled' } }

          const toolTitle = reqParams.toolCall.title || 'Unknown operation'
          const commandDesc =
            typeof reqParams.toolCall.rawInput === 'string'
              ? reqParams.toolCall.rawInput
              : JSON.stringify(reqParams.toolCall.rawInput ?? toolTitle)

          if (ts.ctx.requestUserInput && reqParams.options.length > 0) {
            const kindLabels: Record<string, string> = {
              allow_once: '✓ Allow once',
              allow_always: '✓ Allow always',
              reject_once: '✗ Reject once',
              reject_always: '✗ Reject always'
            }
            const askOptions = reqParams.options.map((o) => ({
              label: o.name,
              description: kindLabels[o.kind] || o.kind
            }))

            const permissionToolCallId = uuid()
            const selections = await ts.ctx.requestUserInput(permissionToolCallId, {
              question: `[${config.displayName}] ${toolTitle}`,
              detail: commandDesc !== toolTitle ? commandDesc : undefined,
              options: askOptions,
              allowMultiple: false
            })

            const selectedName = selections[0]
            if (selectedName) {
              const selectedOption = reqParams.options.find((o) => o.name === selectedName)
              if (selectedOption) {
                return { outcome: { outcome: 'selected', optionId: selectedOption.optionId } }
              }
            }

            return { outcome: { outcome: 'cancelled' } }
          }

          const firstOption = reqParams.options[0]
          if (firstOption) {
            return { outcome: { outcome: 'selected', optionId: firstOption.optionId } }
          }

          return { outcome: { outcome: 'cancelled' } }
        }
      }),
      stream
    )

    cached.connection = connection

    try {
      // ACP 握手
      await connection.initialize({
        protocolVersion: 1,
        clientInfo: {
          name: 'shuvix',
          title: 'ShuviX',
          version: '0.1.0'
        },
        clientCapabilities: {}
      })

      // 创建 session
      const sessionResp = await connection.newSession({
        cwd,
        mcpServers: []
      })

      cached.acpSessionId = sessionResp.sessionId

      return cached
    } catch (err) {
      // 握手/session 创建失败 → kill 进程
      if (!child.killed) {
        child.kill('SIGTERM')
      }
      throw err
    }
  }
}

// ─── 模块级辅助函数 ──────────────────────────────────

/** Kill 进程并清理缓存 */
function killAndCleanup(cached: CachedAcpSession): void {
  cachedSessions.delete(cached.cacheKey)

  if (!cached.process.killed) {
    cached.process.kill('SIGTERM')
    setTimeout(() => {
      if (!cached.process.killed) cached.process.kill('SIGKILL')
    }, 3000)
  }

  chatFrontendRegistry.broadcast({
    type: 'acp_event',
    sessionId: cached.shuvixSessionId,
    action: 'session_destroyed',
    agentName: cached.config.name,
    displayName: cached.config.displayName
  })
}

/** 处理 ACP sessionUpdate 通知，翻译为 subagent_* ChatEvent */
function handleSessionUpdate(
  update: SessionUpdate,
  sessionId: string,
  taskId: string,
  agentType: string,
  acpToolCallMap: Map<string, string>,
  onEvent: (event: ChatEvent) => void,
  appendResult: (text: string) => void
): void {
  switch (update.sessionUpdate) {
    case 'tool_call': {
      const tc = update as ToolCall & { sessionUpdate: 'tool_call' }
      const shuvixToolCallId = uuid()
      acpToolCallMap.set(tc.toolCallId, shuvixToolCallId)

      onEvent({
        type: 'subagent_tool_start',
        sessionId,
        subAgentId: taskId,
        subAgentType: agentType,
        toolCallId: shuvixToolCallId,
        toolName: tc.title || 'tool'
      })
      break
    }

    case 'tool_call_update': {
      const tcu = update as ToolCallUpdate & { sessionUpdate: 'tool_call_update' }
      const mappedId = acpToolCallMap.get(tcu.toolCallId)
      if (!mappedId) break

      if (tcu.status === 'completed' || tcu.status === 'failed') {
        let resultText = ''
        if (tcu.rawOutput != null) {
          resultText =
            typeof tcu.rawOutput === 'string' ? tcu.rawOutput : JSON.stringify(tcu.rawOutput)
        }

        onEvent({
          type: 'subagent_tool_end',
          sessionId,
          subAgentId: taskId,
          subAgentType: agentType,
          toolCallId: mappedId,
          toolName: tcu.title || undefined,
          result: resultText || undefined,
          isError: tcu.status === 'failed'
        })
      } else if (tcu.title) {
        onEvent({
          type: 'subagent_tool_end',
          sessionId,
          subAgentId: taskId,
          subAgentType: agentType,
          toolCallId: mappedId,
          toolName: tcu.title
        })
      }
      break
    }

    case 'agent_message_chunk': {
      const chunk = update as { sessionUpdate: 'agent_message_chunk'; content: unknown }
      const content = chunk.content as { type: string; text?: string }
      if (content?.type === 'text' && content.text) {
        appendResult(content.text)
        onEvent({
          type: 'subagent_text_delta',
          sessionId,
          subAgentId: taskId,
          subAgentType: agentType,
          delta: content.text
        })
      }
      break
    }

    case 'agent_thought_chunk': {
      const chunk = update as { sessionUpdate: 'agent_thought_chunk'; content: unknown }
      const content = chunk.content as { type: string; text?: string }
      if (content?.type === 'text' && content.text) {
        onEvent({
          type: 'subagent_thinking_delta',
          sessionId,
          subAgentId: taskId,
          subAgentType: agentType,
          delta: content.text
        })
      }
      break
    }

    case 'plan': {
      const plan = update as {
        sessionUpdate: 'plan'
        entries: Array<{ content: string; status: string }>
      }
      const planToolCallId = uuid()
      const planText = plan.entries.map((e) => `[${e.status}] ${e.content}`).join('\n')

      onEvent({
        type: 'subagent_tool_start',
        sessionId,
        subAgentId: taskId,
        subAgentType: agentType,
        toolCallId: planToolCallId,
        toolName: 'planning'
      })

      onEvent({
        type: 'subagent_tool_end',
        sessionId,
        subAgentId: taskId,
        subAgentType: agentType,
        toolCallId: planToolCallId,
        toolName: 'planning',
        result: planText
      })
      break
    }

    default:
      break
  }
}

/** 中止所有 ACP 进程（应用退出时调用） */
export function abortAllAcpSessions(): void {
  for (const [, cached] of cachedSessions) {
    if (!cached.process.killed) {
      cached.process.kill('SIGTERM')
      setTimeout(() => {
        if (!cached.process.killed) cached.process.kill('SIGKILL')
      }, 3000)
    }
  }
  cachedSessions.clear()
}
