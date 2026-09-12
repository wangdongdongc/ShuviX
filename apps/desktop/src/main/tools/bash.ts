/**
 * Bash 工具 — 在指定工作目录中执行 shell 命令
 * 从 pi-coding-agent 移植，支持输出截断、超时控制、abort
 */

import { Type } from 'typebox'
import { collapseProgressOutput } from '../utils/toolUtils/shell'
import { BaseTool } from '@shuvix/agent-runtime'
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
  stopCommandHint,
  formatStartReceipt,
  MAX_RUNNING_PER_SESSION
} from '../services/bgTaskService'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { BashToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import { t } from '../i18n'
/** 默认超时时间（秒） */
const DEFAULT_TIMEOUT = 120

const BashParamsSchema = Type.Object({
  command: Type.String({
    description:
      'The shell command to execute. Supports pipes, redirects, and other bash features. Avoid commands that require interactive input.'
  }),
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
      description:
        'Run the command as a background task bound to this session: it outlives this tool call ' +
        'and has no timeout. Use for dev servers, watchers, and long builds. Returns a pid and a ' +
        'log file path right away — deliberately without any output content. Before relying on ' +
        'the task (e.g. requesting a dev server you just started), read that log with the read ' +
        'tool to confirm it is ready, and read it again whenever you need the output (reading it ' +
        `needs no approval); stop the task with \`${stopCommandHint()}\`. ` +
        'Write the command exactly as you would run it in the foreground: do NOT append `&` and ' +
        'do NOT redirect the output yourself — this option already detaches the process and ' +
        'captures stdout+stderr. Doing either makes the tracked process exit immediately, which ' +
        'loses the real pid and leaves the task untrackable and unstoppable. ' +
        'The task has no stdin: reads see EOF immediately, exactly as in the foreground, and ' +
        'neither you nor the user can send it input. Put any answers in the command itself ' +
        '(`-y`/`--yes` flags, `yes |`, a heredoc). If a command genuinely needs a person at a ' +
        'terminal (a password, a TTY-only prompt), do not run it here or in the foreground — ' +
        'hand the user the exact command to run in their own terminal instead.'
    })
  )
})

const BASH_DESCRIPTION =
  'Execute a bash command in the working directory. The command runs in a bash shell with pipe and redirect support. Use this for running scripts, installing packages, git operations, builds, etc. Prefer built-in tools over shell commands where one fits: `ls` instead of `find`/`ls`, `grep` instead of `grep`/`rg`, `glob` instead of `find -name`, `read` instead of `cat`/`head`/`tail`, `write` instead of `echo >`, `edit` instead of `sed`/`awk`. Use bash when no built-in tool can accomplish the task.'

export class BashTool extends BaseTool<typeof BashParamsSchema> {
  readonly name = 'bash'
  readonly label = t('tool.bashLabel')
  readonly description = BASH_DESCRIPTION
  readonly parameters = BashParamsSchema

  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  /** 安全检查 — 条件性询问是动态的，留在 executeInternal 中 */
  protected async securityCheck(): Promise<void> {
    /* no-op */
  }

  protected async executeInternal(
    toolCallId: string,
    params: {
      command: string
      description: string
      timeout?: number
      run_in_background?: boolean
    },
    signal?: AbortSignal
  ): Promise<AgentToolResult<BashToolDetails>> {
    const timeout = params.timeout ?? DEFAULT_TIMEOUT
    const config = resolveProjectConfig(this.ctx.sessionId)

    // Bash 命令逐条需用户询问 —— 唯一豁免是会话级「免询问」开关（无命令模式匹配）。
    // 判定与响应处理收敛到安全模块（内置 ask-on-command 策略给出 ask，autoAllow 走 force-allow 层）
    const outcome = await getDesktopSecurityContext(this.ctx).enforceCommand(
      // cwd 供安全模块把重定向目标解析成绝对路径
      { channel: 'bash', command: params.command, cwd: config.workingDirectory },
      {
        toolCallId,
        toolName: 'bash',
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
        details: { type: 'bash', exitCode: -1, truncated: false }
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
      details: { type: 'bash', exitCode, truncated: false, cwd: config.workingDirectory }
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
        details: { type: 'bash', exitCode: -1, truncated: false, cwd }
      }
    }

    const started = await runCommand({
      sessionId,
      toolCallId,
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
        details: { type: 'bash', exitCode, truncated: false, cwd }
      }
    }

    return {
      content: [
        { type: 'text' as const, text: formatStartReceipt(started.info, started.logBytes) }
      ],
      // exitCode 0 = 启动成功（非命令结果）；background 标记让 UI 走后台形态
      details: { type: 'bash', exitCode: 0, truncated: false, cwd, background: true }
    }
  }
}

import { registerBuiltinTool } from '../services/toolRegistry'
registerBuiltinTool({
  name: 'bash',
  group: 'general',
  getLabel: () => t('tool.bashLabel'),
  getHint: () => t('tool.bashHint'),
  factory: (ctx) => new BashTool(ctx),
  presentation: {
    icon: 'Terminal',
    iconColor: '#eab308',
    // 展开态融成一段终端会话（提示符 + cwd + 命令 + 输出）；formItems 保留作降级
    detailView: 'terminal',
    formItems: [
      {
        field: 'command',
        renderer: { type: 'code', language: 'bash', wrap: true, lineNumbers: true }
      }
    ],
    showUndeclaredFields: false
  },
  describe: () => ({ description: BASH_DESCRIPTION, parameters: BashParamsSchema })
})
