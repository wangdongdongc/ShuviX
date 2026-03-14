/**
 * ACP (Agent Client Protocol) 通用服务
 *
 * 负责管理外部 ACP Agent（如 Claude Code、Gemini CLI 等）的生命周期：
 * - 按 ShuviX sessionId + agentName 复用 ACP session（保持对话上下文）
 * - spawn 进程 → ACP 握手 → session 管理 → prompt 执行 → 结果收集
 * - sessionUpdate 通知转译为 subagent_* ChatEvent 广播到 UI
 * - requestPermission 桥接到 ShuviX 审批 UI
 * - 用户可主动关闭 ACP session（下次调用时创建新 session）
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
import { chatFrontendRegistry, type ChatEvent } from '../frontend'
import type { ToolContext } from '../tools/types'
import { resolveProjectConfig } from '../tools/types'
import log from 'electron-log'
import { mergedPATH } from '../utils/paths'

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
const BUILTIN_ACP_AGENTS: AcpAgentConfig[] = [
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
  // 拦截 Client → Agent（writable 方向）
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

  // 拦截 Agent → Client（readable 方向）
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

// ─── 缓存会话 ──────────────────────────────────────────

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

// ─── 服务实现 ──────────────────────────────────────────

class AcpService {
  /** 缓存的 ACP 会话：key = `${shuvixSessionId}:${agentName}` */
  private cachedSessions = new Map<string, CachedAcpSession>()

  /** 返回所有已注册的 ACP Agent 配置 */
  getRegisteredAgents(): AcpAgentConfig[] {
    return BUILTIN_ACP_AGENTS
  }

  /** 检测 Agent 可执行文件是否在 PATH 中，返回 [command, args] */
  resolveExecutable(config: AcpAgentConfig): { cmd: string; args: string[] } | null {
    const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [config.command], {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, PATH: mergedPATH }
    })
    if (result.status === 0 && result.stdout.trim()) {
      return { cmd: config.command, args: [...config.args] }
    }

    log.warn(`[ACP] Command "${config.command}" not found in PATH`)
    return null
  }

  /**
   * 执行 ACP Agent 任务
   *
   * 同一 ShuviX session + agentName 复用已有 ACP session（保持上下文），
   * 进程异常退出或用户主动关闭后，下次调用自动创建新 session。
   */
  async runTask(params: {
    config: AcpAgentConfig
    ctx: ToolContext
    toolCallId: string
    prompt: string
    description: string
    signal?: AbortSignal
    onEvent: (event: ChatEvent) => void
  }): Promise<{ taskId: string; result: string }> {
    const { config, ctx, toolCallId, prompt, description, signal, onEvent } = params
    const taskId = uuid()
    const cacheKey = `${ctx.sessionId}:${config.name}`

    // 1. 广播 subagent_start
    onEvent({
      type: 'subagent_start',
      sessionId: ctx.sessionId,
      subAgentId: taskId,
      subAgentType: config.name,
      description,
      parentToolCallId: toolCallId
    })

    try {
      const result = await this._executeOnSession({
        config,
        cacheKey,
        ctx,
        taskId,
        prompt,
        signal,
        onEvent
      })

      // 广播 subagent_end
      onEvent({
        type: 'subagent_end',
        sessionId: ctx.sessionId,
        subAgentId: taskId,
        subAgentType: config.name,
        result
      })

      return { taskId, result }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)

      onEvent({
        type: 'subagent_end',
        sessionId: ctx.sessionId,
        subAgentId: taskId,
        subAgentType: config.name,
        result: `Error: ${errMsg}`
      })

      throw err
    }
  }

  /** 销毁指定会话的 ACP Agent session（用户主动关闭） */
  destroySession(shuvixSessionId: string, agentName: string): void {
    const cacheKey = `${shuvixSessionId}:${agentName}`
    const cached = this.cachedSessions.get(cacheKey)
    if (!cached) return

    log.info(`[ACP] Destroying session ${cacheKey}`)
    this._killAndCleanup(cached)
  }

  /** 销毁指定 ShuviX 会话的所有 ACP session */
  destroyAllForSession(shuvixSessionId: string): void {
    for (const [key, cached] of this.cachedSessions) {
      if (key.startsWith(shuvixSessionId + ':')) {
        log.info(`[ACP] Destroying session ${key}`)
        this._killAndCleanup(cached)
      }
    }
  }

  /** 中止所有活跃任务（应用退出时调用） */
  abortAll(): void {
    for (const [, cached] of this.cachedSessions) {
      if (!cached.process.killed) {
        cached.process.kill('SIGTERM')
        setTimeout(() => {
          if (!cached.process.killed) cached.process.kill('SIGKILL')
        }, 3000)
      }
    }
    this.cachedSessions.clear()
  }

  // ─── 内部实现 ──────────────────────────────────────

  /** 在已有或新建的 ACP session 上执行 prompt */
  private async _executeOnSession(params: {
    config: AcpAgentConfig
    cacheKey: string
    ctx: ToolContext
    taskId: string
    prompt: string
    signal?: AbortSignal
    onEvent: (event: ChatEvent) => void
  }): Promise<string> {
    const { config, cacheKey, ctx, taskId, prompt, signal, onEvent } = params

    // 获取或创建缓存会话
    let cached = this.cachedSessions.get(cacheKey)

    // 进程已死 → 清理缓存
    if (cached && cached.process.killed) {
      log.info(`[ACP] Cached session for ${cacheKey} process is dead, creating new one`)
      this.cachedSessions.delete(cacheKey)
      cached = undefined
    }

    if (!cached) {
      cached = await this._createSession({
        config,
        cacheKey,
        shuvixSessionId: ctx.sessionId,
        ctx,
        taskId,
        onEvent
      })
      this.cachedSessions.set(cacheKey, cached)

      // 广播 acp_event: session_created
      chatFrontendRegistry.broadcast({
        type: 'acp_event',
        sessionId: ctx.sessionId,
        action: 'session_created',
        agentName: config.name,
        displayName: config.displayName
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
      if (cached.process.killed && this.cachedSessions.get(cacheKey) === cached) {
        this.cachedSessions.delete(cacheKey)
      }

      if (signal?.aborted) {
        return cached.taskState?.resultBuffer || 'Task was aborted.'
      }

      const errMsg = err instanceof Error ? err.message : String(err)
      if (cached.stderrBuffer) {
        log.error(`[ACP] ${config.name} stderr:\n${cached.stderrBuffer.slice(-2000)}`)
      }
      throw new Error(`ACP Agent "${config.displayName}" error: ${errMsg}`)
    } finally {
      signalCleanup?.()
      if (cached.taskState?.taskId === taskId) {
        cached.taskState = null
      }
    }
  }

  /** 创建新的 ACP session（spawn + 握手 + newSession） */
  private async _createSession(params: {
    config: AcpAgentConfig
    cacheKey: string
    shuvixSessionId: string
    ctx: ToolContext
    taskId: string
    onEvent: (event: ChatEvent) => void
  }): Promise<CachedAcpSession> {
    const { config, cacheKey, shuvixSessionId, ctx, taskId, onEvent } = params
    const projectConfig = resolveProjectConfig(shuvixSessionId)
    const cwd = projectConfig.workingDirectory

    const resolved = this.resolveExecutable(config)
    if (!resolved) {
      throw new Error(
        `ACP Agent "${config.displayName}" executable not found. ` +
          `Ensure "${config.command}" is installed and available in PATH.`
      )
    }

    const child = spawn(resolved.cmd, resolved.args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...config.env,
        NODE_NO_WARNINGS: '1',
        PATH: mergedPATH
      }
    })

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
      if (this.cachedSessions.get(cacheKey) === cached) {
        this.cachedSessions.delete(cacheKey)
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
        // sessionUpdate 通知处理 — 通过 cached.taskState 可变引用路由到当前任务
        sessionUpdate: async (notification: SessionNotification): Promise<void> => {
          const ts = cached.taskState
          if (!ts) return
          this._handleSessionUpdate(
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

  /** Kill 进程并清理缓存 */
  private _killAndCleanup(cached: CachedAcpSession): void {
    // 从缓存移除（exit handler 会检测到已移除，不重复广播）
    this.cachedSessions.delete(cached.cacheKey)

    if (!cached.process.killed) {
      cached.process.kill('SIGTERM')
      setTimeout(() => {
        if (!cached.process.killed) cached.process.kill('SIGKILL')
      }, 3000)
    }

    // 广播 session_destroyed
    chatFrontendRegistry.broadcast({
      type: 'acp_event',
      sessionId: cached.shuvixSessionId,
      action: 'session_destroyed',
      agentName: cached.config.name,
      displayName: cached.config.displayName
    })
  }

  /** 处理 ACP sessionUpdate 通知，翻译为 subagent_* ChatEvent */
  private _handleSessionUpdate(
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
          // 终态：广播 tool_end
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
          // 中间更新：仅在 title 有新值时转发（如 "Read File" → "Read /path/to/file"）
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
          // 同时流式广播到 UI
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
        // 思考内容流式广播到 UI
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
}

/** 全局单例 */
export const acpService = new AcpService()
