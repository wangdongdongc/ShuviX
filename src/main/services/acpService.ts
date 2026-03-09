/**
 * ACP (Agent Client Protocol) 通用服务
 *
 * 负责管理外部 ACP Agent（如 Claude Code、Gemini CLI 等）的生命周期：
 * - spawn 进程 → ACP 握手 → session 管理 → prompt 执行 → 结果收集
 * - sessionUpdate 通知转译为 subagent_* ChatEvent 广播到 UI
 * - requestPermission 桥接到 ShuviX 审批 UI
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
import type { ChatEvent } from '../frontend'
import type { ToolContext } from '../tools/types'
import { resolveProjectConfig } from '../tools/types'
import log from 'electron-log'

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
 *   npm install -g @zed-industries/claude-agent-acp
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
function withProtocolLogging(stream: Stream, label: string): Stream {
  // 拦截 Client → Agent（writable 方向）
  const originalWritable = stream.writable
  const loggedWritable = new WritableStream<AnyMessage>({
    write(message) {
      log.info(`[ACP:${label}] ──▶ SEND`, JSON.stringify(message, null, 2))
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
        log.info(`[ACP:${label}] ◀── RECV`, JSON.stringify(message, null, 2))
        controller.enqueue(message)
      }
    })
  )

  return { writable: loggedWritable, readable: loggedReadable }
}

// ─── 任务管理 ──────────────────────────────────────────

interface ActiveTask {
  process: ChildProcess
  connection?: ClientSideConnection
  sessionId?: string
  abortController: AbortController
}

// ─── 服务实现 ──────────────────────────────────────────

class AcpService {
  private activeTasks = new Map<string, ActiveTask>()

  /** 返回所有已注册的 ACP Agent 配置 */
  getRegisteredAgents(): AcpAgentConfig[] {
    return BUILTIN_ACP_AGENTS
  }

  /** 检测 Agent 可执行文件是否在 PATH 中，返回 [command, args] */
  resolveExecutable(config: AcpAgentConfig): { cmd: string; args: string[] } | null {
    const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [config.command], {
      encoding: 'utf-8',
      timeout: 5000
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
   * @returns 最终结果文本
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
    const projectConfig = resolveProjectConfig(ctx.sessionId)
    const cwd = projectConfig.workingDirectory

    // 1. 解析可执行文件
    const resolved = this.resolveExecutable(config)
    if (!resolved) {
      throw new Error(
        `ACP Agent "${config.displayName}" executable not found. ` +
          `Ensure "${config.command}" is installed and available in PATH.`
      )
    }

    // 2. 广播 subagent_start
    onEvent({
      type: 'subagent_start',
      sessionId: ctx.sessionId,
      subAgentId: taskId,
      subAgentType: config.name,
      description,
      parentToolCallId: toolCallId
    })

    const abortController = new AbortController()

    // 外部 signal 联动
    if (signal) {
      if (signal.aborted) {
        abortController.abort()
      } else {
        signal.addEventListener('abort', () => abortController.abort(), { once: true })
      }
    }

    try {
      const result = await this._executeAcpSession({
        config,
        resolved,
        cwd,
        taskId,
        ctx,
        toolCallId,
        prompt,
        abortController,
        onEvent
      })

      // 3. 广播 subagent_end
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
    } finally {
      this.activeTasks.delete(taskId)
    }
  }

  /** 中止指定任务 */
  abortTask(taskId: string): void {
    const task = this.activeTasks.get(taskId)
    if (!task) return

    task.abortController.abort()

    // 发送 ACP cancel
    if (task.connection && task.sessionId) {
      task.connection.cancel({ sessionId: task.sessionId }).catch(() => {})
    }

    // 强制 kill 进程
    if (!task.process.killed) {
      task.process.kill('SIGTERM')
      setTimeout(() => {
        if (!task.process.killed) task.process.kill('SIGKILL')
      }, 3000)
    }
  }

  /** 中止所有活跃任务（应用退出时调用） */
  abortAll(): void {
    for (const taskId of this.activeTasks.keys()) {
      this.abortTask(taskId)
    }
  }

  // ─── 内部实现 ──────────────────────────────────────

  private async _executeAcpSession(params: {
    config: AcpAgentConfig
    resolved: { cmd: string; args: string[] }
    cwd: string
    taskId: string
    ctx: ToolContext
    toolCallId: string
    prompt: string
    abortController: AbortController
    onEvent: (event: ChatEvent) => void
  }): Promise<string> {
    const { config, resolved, cwd, taskId, ctx, prompt, abortController, onEvent } = params

    // Spawn 子进程（不传 signal，手动管理 abort 以避免 uncaught AbortError）
    const child = spawn(resolved.cmd, resolved.args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...config.env,
        // 不注入 API Key — Agent 使用自身认证
        NODE_NO_WARNINGS: '1'
      }
    })

    // 手动处理 abort：kill 进程
    const onAbort = (): void => {
      if (!child.killed) {
        child.kill('SIGTERM')
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL')
        }, 3000)
      }
    }
    if (abortController.signal.aborted) {
      onAbort()
    } else {
      abortController.signal.addEventListener('abort', onAbort, { once: true })
    }

    const activeTask: ActiveTask = {
      process: child,
      abortController
    }
    this.activeTasks.set(taskId, activeTask)

    // 收集 stderr 日志
    let stderrBuffer = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString()
      if (stderrBuffer.length > 10000) {
        stderrBuffer = stderrBuffer.slice(-5000)
      }
    })

    // 将 Node Stream 转为 Web Stream（ACP SDK 需要）
    const inputStream = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
    const outputStream = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>

    // 建立 ACP 连接（带协议日志）
    const rawStream = ndJsonStream(outputStream, inputStream)
    const stream = withProtocolLogging(rawStream, config.name)

    // ACP tool_call ID → ShuviX tool_call ID 映射
    const acpToolCallMap = new Map<string, string>()
    let resultBuffer = ''

    const connection = new ClientSideConnection(
      (_agent: Agent): Client => ({
        // sessionUpdate 通知处理
        sessionUpdate: async (notification: SessionNotification): Promise<void> => {
          this._handleSessionUpdate(
            notification.update,
            ctx.sessionId,
            taskId,
            config.name,
            acpToolCallMap,
            onEvent,
            (text: string) => {
              resultBuffer += text
            }
          )
        },

        // requestPermission 桥接到 ShuviX 审批 UI
        requestPermission: async (
          params: RequestPermissionRequest
        ): Promise<RequestPermissionResponse> => {
          if (abortController.signal.aborted) {
            return { outcome: { outcome: 'cancelled' } }
          }

          // 从 ACP toolCall 中提取命令描述
          const toolTitle = params.toolCall.title || 'Unknown operation'
          const commandDesc =
            typeof params.toolCall.rawInput === 'string'
              ? params.toolCall.rawInput
              : JSON.stringify(params.toolCall.rawInput ?? toolTitle)

          if (ctx.requestUserInput && params.options.length > 0) {
            // 将 ACP PermissionOption 映射为 ask 选项，展示给用户选择
            const kindLabels: Record<string, string> = {
              allow_once: '✓ Allow once',
              allow_always: '✓ Allow always',
              reject_once: '✗ Reject once',
              reject_always: '✗ Reject always'
            }
            const askOptions = params.options.map((o) => ({
              label: o.name,
              description: kindLabels[o.kind] || o.kind
            }))

            const permissionToolCallId = uuid()
            const selections = await ctx.requestUserInput(permissionToolCallId, {
              question: `[${config.displayName}] ${toolTitle}`,
              detail: commandDesc !== toolTitle ? commandDesc : undefined,
              options: askOptions,
              allowMultiple: false
            })

            // 根据用户选择的 label 匹配回 ACP option
            const selectedName = selections[0]
            if (selectedName) {
              const selectedOption = params.options.find((o) => o.name === selectedName)
              if (selectedOption) {
                return { outcome: { outcome: 'selected', optionId: selectedOption.optionId } }
              }
            }

            return { outcome: { outcome: 'cancelled' } }
          }

          // 无 requestUserInput 回调时默认允许（第一个选项通常是 allow）
          const firstOption = params.options[0]
          if (firstOption) {
            return { outcome: { outcome: 'selected', optionId: firstOption.optionId } }
          }

          return { outcome: { outcome: 'cancelled' } }
        }
      }),
      stream
    )

    activeTask.connection = connection

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

      const acpSessionId = sessionResp.sessionId
      activeTask.sessionId = acpSessionId

      // 发送 prompt
      const promptResp = await connection.prompt({
        sessionId: acpSessionId,
        prompt: [{ type: 'text', text: prompt }]
      })

      // 等待完成
      if (promptResp.stopReason === 'cancelled') {
        return resultBuffer || 'Task was cancelled.'
      }

      return resultBuffer || 'Task completed (no output captured).'
    } catch (err) {
      if (abortController.signal.aborted) {
        return resultBuffer || 'Task was aborted.'
      }
      const errMsg = err instanceof Error ? err.message : String(err)
      if (stderrBuffer) {
        log.error(`[ACP] ${config.name} stderr:\n${stderrBuffer.slice(-2000)}`)
      }
      throw new Error(`ACP Agent "${config.displayName}" error: ${errMsg}`)
    } finally {
      // 清理 abort 监听
      abortController.signal.removeEventListener('abort', onAbort)
      // 确保进程退出
      if (!child.killed) {
        child.kill('SIGTERM')
      }
      // 等待连接关闭
      await connection.closed.catch(() => {})
    }
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
          toolName: tc.title || 'tool',
          toolArgs: typeof tc.rawInput === 'object' ? (tc.rawInput as Record<string, unknown>) : {}
        })
        break
      }

      case 'tool_call_update': {
        const tcu = update as ToolCallUpdate & { sessionUpdate: 'tool_call_update' }
        const mappedId = acpToolCallMap.get(tcu.toolCallId)
        if (!mappedId) break

        // 只在完成/失败时广播 tool_end
        if (tcu.status === 'completed' || tcu.status === 'failed') {
          // 提取结果文本
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
            toolName: tcu.title || 'tool',
            result: resultText || undefined,
            isError: tcu.status === 'failed'
          })
        }
        break
      }

      case 'agent_message_chunk': {
        const chunk = update as { sessionUpdate: 'agent_message_chunk'; content: unknown }
        const content = chunk.content as { type: string; text?: string }
        if (content?.type === 'text' && content.text) {
          appendResult(content.text)
        }
        break
      }

      case 'plan': {
        // 将 plan 作为一对 tool_start/end 展示
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

      // 其他 update 类型忽略
      default:
        break
    }
  }
}

/** 全局单例 */
export const acpService = new AcpService()
