/**
 * 命令工具的共用实现 —— `bash`（macOS / Linux）与 `powershell`（Windows）是两个工具、同一条路径：
 * 安全询问（enforceCommand）→ bgTaskService.runCommand（前台 / 后台同一次 spawn）→ 输出折叠。
 * 两者只差 shell、发给模型的描述，以及 PowerShell 的命令行长度上限。
 *
 * 为什么是两个工具而不是一个按平台换描述的 `shell` 工具：工具名本身就是给模型的第一个语法
 * 信号 —— 一个叫 bash 的工具，模型就写 bash；在 Windows 上它想写的是 PowerShell，
 * 于是就会在 bash 里再套一层 `powershell -Command "…"`，`$` 被外层展开掉。
 * 哪个工具在哪个平台上存在由注册表的 `platforms` 决定（见 toolRegistry）。
 */

import {
  Type,
  type TBoolean,
  type TNumber,
  type TObject,
  type TOptional,
  type TString
} from 'typebox'
import { BaseTool } from '@shuvix/agent-runtime'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { BashToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import { collapseProgressOutput, type ShellKind } from '../utils/toolUtils/shell'
import {
  getDesktopSecurityContext,
  resolveProjectConfig,
  TOOL_ABORTED,
  type ToolContext
} from '../services/toolContext'
import {
  runCommand,
  listBgTasks,
  runningCount,
  stopCommandFor,
  formatStartReceipt,
  MAX_RUNNING_PER_SESSION
} from '../services/bgTaskService'

/** 默认超时时间（秒） */
export const DEFAULT_TIMEOUT = 120

export interface ShellCommandParams {
  command: string
  description: string
  timeout?: number
  run_in_background?: boolean
}

export type ShellCommandParamsSchema = TObject<{
  command: TString
  description: TString
  timeout: TOptional<TNumber>
  run_in_background: TOptional<TBoolean>
}>

/** 参数 schema —— 字段两个工具一致，只有 command 与 run_in_background 的说明因 shell 而异 */
export function shellCommandParamsSchema(text: {
  command: string
  runInBackground: string
}): ShellCommandParamsSchema {
  return Type.Object({
    command: Type.String({ description: text.command }),
    description: Type.String({
      description: 'Brief description of what this command does and why.'
    }),
    timeout: Type.Optional(
      Type.Number({
        description: `Command timeout in seconds (default: ${DEFAULT_TIMEOUT}s). Increase for long-running commands. Pass 0 for no time limit.`
      })
    ),
    run_in_background: Type.Optional(
      Type.Boolean({
        // 用法说明留在此处（随 tools 块每次请求发一份、走 prompt cache），
        // 不进工具结果 —— 结果会永久留在上下文并被每一步重发。见 formatStartReceipt。
        description: text.runInBackground
      })
    )
  })
}

export interface ShellCommandToolSpec {
  shell: ShellKind
  label: string
  description: string
  parameters: ShellCommandParamsSchema
  /**
   * 询问用户之前的拒绝（如 PowerShell 的命令行长度上限）：返回给模型的说明，或 null 放行。
   * 放在询问之前 —— 不该让用户批准一条注定跑不起来的命令。
   */
  reject?: (command: string) => string | null
}

export class ShellCommandTool extends BaseTool<ShellCommandParamsSchema> {
  readonly name: string
  readonly label: string
  readonly description: string
  readonly parameters: ShellCommandParamsSchema

  constructor(
    private ctx: ToolContext,
    private spec: ShellCommandToolSpec
  ) {
    super()
    this.name = spec.shell
    this.label = spec.label
    this.description = spec.description
    this.parameters = spec.parameters
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  /** 安全检查 — 条件性询问是动态的，留在 executeInternal 中 */
  protected async securityCheck(): Promise<void> {
    /* no-op */
  }

  private details(extra: Omit<BashToolDetails, 'type' | 'truncated'>): BashToolDetails {
    return { type: this.spec.shell, truncated: false, ...extra }
  }

  protected async executeInternal(
    toolCallId: string,
    params: ShellCommandParams,
    signal?: AbortSignal
  ): Promise<AgentToolResult<BashToolDetails>> {
    const timeout = params.timeout ?? DEFAULT_TIMEOUT
    const config = resolveProjectConfig(this.ctx.sessionId)

    const rejected = this.spec.reject?.(params.command)
    if (rejected) {
      return {
        content: [{ type: 'text', text: rejected }],
        details: this.details({ exitCode: -1, cwd: config.workingDirectory })
      }
    }

    // 命令逐条需用户询问 —— 唯一豁免是会话级「免询问」开关（无命令模式匹配）。
    // 判定与响应处理收敛到安全模块（内置 ask-on-command 策略给出 ask，autoAllow 走 force-allow 层）
    const outcome = await getDesktopSecurityContext(this.ctx).enforceCommand(
      // cwd 供安全模块把重定向目标解析成绝对路径
      { channel: this.spec.shell, command: params.command, cwd: config.workingDirectory },
      {
        toolCallId,
        toolName: this.spec.shell,
        description: params.description,
        // 后台任务的询问卡片要标出来 —— 用户批准的是个不会自动结束的进程
        background: params.run_in_background === true,
        abortError: TOOL_ABORTED,
        // 用户选择"其它":不执行命令,把反馈文本作为正常 tool result 返回给 AI
        onOther: 'return',
        // fail-closed：ask 且无询问通道 → 拒绝（桌面 root/派生 agent 恒有通道，
        // 无前端时 harness 层已即时 cancel；此分支只防御未来的无通道调用方）
        missingChannel: 'deny'
      }
    )
    if (outcome.status === 'feedback') {
      return {
        content: [
          {
            type: 'text',
            text: `Command was not executed. User responded with feedback instead:\n${outcome.text}`
          }
        ],
        details: this.details({ exitCode: -1 })
      }
    }

    // 注入 SHUVIX_SESSION_ID，让 shuvix-cli 把当前 session id 透传给主进程
    // （主进程据此把 widget 目录加入 session 的 read/write allowList）
    const extraEnv = { ...config.envVars, SHUVIX_SESSION_ID: this.ctx.sessionId }

    if (params.run_in_background) {
      return this.runInBackground(toolCallId, params, config.workingDirectory, extraEnv)
    }

    // 同步形态 —— 与后台形态**同一条 spawn 路径**，只是等待策略不同（见 bgTaskService.runCommand）。
    // 跑够阈值它也会进后台任务面板：能看实时输出，也能被用户从那里停掉。
    const run = await runCommand({
      sessionId: this.ctx.sessionId,
      toolCallId,
      shell: this.spec.shell,
      command: params.command,
      description: params.description,
      cwd: config.workingDirectory,
      extraEnv,
      background: false,
      timeoutMs: timeout > 0 ? timeout * 1000 : 0,
      signal
    })
    // 同步形态不会转后台（onTimeout 是 kill），这里恒为 settled
    if (run.kind !== 'settled') throw new Error('Command unexpectedly detached')
    if (run.reason === 'abort') throw new Error(TOOL_ABORTED)

    // 折叠进度输出（仅匹配进度类命令时生效）
    let text = collapseProgressOutput(run.output, params.command)
    const exitCode = run.reason === 'timeout' ? 124 : (run.info.exitCode ?? 1)
    if (run.reason === 'timeout') {
      text += `\n\n[Command timed out (${timeout}s)]`
    } else if (exitCode !== 0) {
      text += `\n\n[Exit code: ${exitCode}]`
    }

    // 输出长度的截断/落盘统一由 wrapToolOutput 在构建工具时处理
    return {
      content: [{ type: 'text' as const, text }],
      details: this.details({ exitCode, cwd: config.workingDirectory })
    }
  }

  /**
   * 后台形态 —— 进程脱离本次工具调用存活，输出由 OS 直接写 tool_results 下的日志文件。
   *
   * 刻意**不传 signal**：用户点「停止生成」不该杀后台任务，这正是后台的意义。
   * 任务只在删除会话 / 应用退出时被级联杀（见 bgTaskService）。
   */
  private async runInBackground(
    toolCallId: string,
    params: { command: string; description: string },
    cwd: string,
    extraEnv: Record<string, string>
  ): Promise<AgentToolResult<BashToolDetails>> {
    const sessionId = this.ctx.sessionId

    if (runningCount(sessionId) >= MAX_RUNNING_PER_SESSION) {
      const running = listBgTasks(sessionId).filter((task) => task.status === 'running')
      const text = [
        `Too many background tasks in this session (${running.length}/${MAX_RUNNING_PER_SESSION}).`,
        'Stop one before starting another:',
        ...running.map((task) => `  ${stopCommandFor(task)}   # ${task.description}`)
      ].join('\n')
      return {
        content: [{ type: 'text', text }],
        details: this.details({ exitCode: -1, cwd })
      }
    }

    const started = await runCommand({
      sessionId,
      toolCallId,
      shell: this.spec.shell,
      command: params.command,
      description: params.description,
      cwd,
      extraEnv,
      background: true
    })

    // 预热窗口内就退出了（打错命令 / 缺依赖）→ 按前台形态回话，不留后台条目
    if (started.kind === 'settled') {
      const exitCode = started.info.exitCode ?? 1
      let text = collapseProgressOutput(started.output, params.command)
      if (exitCode !== 0) text += `\n\n[Exit code: ${exitCode}]`
      return {
        content: [{ type: 'text' as const, text }],
        details: this.details({ exitCode, cwd })
      }
    }

    return {
      content: [
        { type: 'text' as const, text: formatStartReceipt(started.info, started.logBytes) }
      ],
      // exitCode 0 = 启动成功（非命令结果）；background 标记让 UI 走后台形态
      details: this.details({ exitCode: 0, cwd, background: true })
    }
  }
}

/**
 * run_in_background 说明里与 shell 无关的部分 —— 两个工具各自补上「别自己脱离 / 重定向」与
 * 「把回答写进命令里」的具体写法。
 */
export function backgroundParamDescription(parts: {
  stopHint: string
  noDetach: string
  answersInline: string
}): string {
  return (
    'Run the command as a background task bound to this session: it outlives this tool call ' +
    'and has no timeout. Use for dev servers, watchers, and long builds. Returns a pid and a ' +
    'log file path right away — deliberately without any output content. Before relying on ' +
    'the task (e.g. requesting a dev server you just started), read that log with the read ' +
    'tool to confirm it is ready, and read it again whenever you need the output (reading it ' +
    `needs no approval); stop the task with \`${parts.stopHint}\`. ` +
    `Write the command exactly as you would run it in the foreground: ${parts.noDetach} — ` +
    'this option already detaches the process and captures stdout+stderr. Doing so makes ' +
    'the tracked process exit immediately, which loses the real pid and leaves the task ' +
    'untrackable and unstoppable. ' +
    'The task has no stdin: reads see EOF immediately, exactly as in the foreground, and ' +
    `neither you nor the user can send it input. Put any answers in the command itself (${parts.answersInline}). ` +
    'If a command genuinely needs a person at a terminal (a password, a TTY-only prompt), do ' +
    'not run it here or in the foreground — hand the user the exact command to run in their ' +
    'own terminal instead.'
  )
}
