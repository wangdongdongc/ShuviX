/**
 * SSH 工具 — 通过 SSH 连接远程服务器并执行命令
 * connect 动作无参数，凭据由用户在 UI 弹窗中输入，不经过大模型
 * exec 动作每次都需用户审批
 */

import { Type } from 'typebox'
import { sshManager } from '../services/sshManager'
import { sshCredentialDao } from '../dao/sshCredentialDao'
import { sessionDao } from '../dao/sessionDao'
import { sanitizeBinaryOutput, collapseProgressOutput } from '../utils/toolUtils/shell'
import { BaseTool } from '@shuvix/agent-runtime'
import { TOOL_ABORTED, type ToolContext } from '../services/toolContext'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { SshToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import { t } from '../i18n'
import { createLogger } from '../logger'
const log = createLogger('Tool:ssh')

/** 默认超时时间（秒） */
const DEFAULT_TIMEOUT = 120

const SshParamsSchema = Type.Object({
  action: Type.Union([Type.Literal('connect'), Type.Literal('exec'), Type.Literal('disconnect')], {
    description:
      'Action to perform: "connect" to establish SSH connection, "exec" to run a command on the remote server, "disconnect" to close the connection.'
  }),
  credentialName: Type.Optional(
    Type.String({
      description:
        'Name of a saved SSH credential for connect action. If provided, connects directly using the saved credential without prompting the user. If omitted, the user will be prompted via a secure UI dialog.'
    })
  ),
  command: Type.Optional(
    Type.String({
      description: 'The command to execute on the remote server (required for exec action).'
    })
  ),
  description: Type.String({
    description:
      'Brief description of what this command does and why. Only applicable for exec action.'
  }),
  timeout: Type.Optional(
    Type.Number({
      description: `Command timeout in seconds (default: ${DEFAULT_TIMEOUT}s). Only for exec action.`
    })
  )
})

/**
 * 动态构建 ssh 工具描述，包含当前已保存的凭据名称（读 DAO，无副作用）。
 * 工具实例与设置页定义枚举共用此函数，保证「发给 LLM」的描述一致。
 */
export function buildSshDescription(): string {
  const savedNames = sshCredentialDao.findAllNames()
  let desc = 'Connect to a remote server via SSH and execute commands.'
  if (savedNames.length > 0) {
    desc += ` The user has configured saved SSH credentials: [${savedNames.join(', ')}]. To use a saved credential, call connect with the credentialName parameter, e.g. ssh({ action: "connect", credentialName: "${savedNames[0]}" }).`
  }
  desc +=
    ' To connect without a saved credential, use action="connect" without credentialName — the user will provide credentials via a secure UI dialog (you do NOT need to provide host, username, or password).'
  desc +=
    ' Use action="exec" with a command to run it on the remote server. Use action="disconnect" to close the connection. Each exec command requires user approval before execution. You do NOT have access to any credentials — never ask the user for passwords in chat.'
  return desc
}

export class SshTool extends BaseTool<typeof SshParamsSchema> {
  readonly name = 'ssh'
  readonly label = t('tool.sshLabel')
  readonly description: string
  readonly parameters = SshParamsSchema

  constructor(private ctx: ToolContext) {
    super()
    this.description = buildSshDescription()
  }

  /** 资源初始化：使用保存凭据的 connect 场景提前建立连接 */
  async preExecute(_toolCallId: string, params: Record<string, unknown>): Promise<void> {
    // 仅处理 action=connect && credentialName 的场景
    if (params.action !== 'connect' || !params.credentialName) return
    // 已有连接则跳过
    if (sshManager.isConnected(this.ctx.sessionId)) return

    const credentialName = params.credentialName as string
    const saved = sshCredentialDao.findByName(credentialName)
    if (!saved) return // 凭据不存在，留给 execute 处理并返回明确错误

    log.info(
      `[preExecute] 使用保存的凭据 "${credentialName}" 连接 SSH session=${this.ctx.sessionId}`
    )
    const credentials = {
      host: saved.host,
      port: saved.port,
      username: saved.username,
      password: saved.authType === 'password' ? saved.password : undefined,
      privateKey: saved.authType === 'key' ? saved.privateKey : undefined,
      passphrase: saved.authType === 'key' && saved.passphrase ? saved.passphrase : undefined,
      proxyUrl: saved.metadata?.proxyUrl || undefined
    }

    const result = await sshManager.connect(this.ctx.sessionId, credentials)
    if (result.success) {
      this.ctx.emitChatEvent?.({
        type: 'runtime_event',
        runtimeId: 'ssh',
        status: {
          label: `${credentials.username}@${credentials.host}`,
          icon: 'Terminal',
          color: '#38bdf8'
        }
      })
    }
    // 连接失败不抛异常，留给 execute 中的 handleConnect 返回明确错误消息
  }

  /** 安全检查 — 审批为动作特定的动态条件性审批，留在 executeInternal 中 */
  protected async securityCheck(): Promise<void> {
    /* no-op */
  }

  protected async executeInternal(
    toolCallId: string,
    params: {
      action: 'connect' | 'exec' | 'disconnect'
      credentialName?: string
      command?: string
      description: string
      timeout?: number
    },
    signal?: AbortSignal
  ): Promise<AgentToolResult<SshToolDetails>> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    switch (params.action) {
      case 'connect':
        return handleConnect(this.ctx, toolCallId, params.credentialName, signal)
      case 'exec':
        return handleExec(
          this.ctx,
          toolCallId,
          params.command,
          params.timeout,
          params.description,
          signal
        )
      case 'disconnect':
        return handleDisconnect(this.ctx)
      default:
        throw new Error(`Unknown action: ${params.action}`)
    }
  }
}

/** 处理 connect 动作 */
async function handleConnect(
  ctx: ToolContext,
  toolCallId: string,
  credentialName?: string,
  signal?: AbortSignal
): Promise<AgentToolResult<SshToolDetails>> {
  // 检查是否已有连接
  if (sshManager.isConnected(ctx.sessionId)) {
    const info = sshManager.getConnectionInfo(ctx.sessionId)
    return {
      content: [
        {
          type: 'text',
          text: `Already connected to remote server. Use exec to run commands or disconnect first.`
        }
      ],
      details: { type: 'ssh', action: 'connect', alreadyConnected: true, host: info?.host }
    }
  }

  // --- 路径 A：使用已保存的凭据 ---
  if (credentialName) {
    const saved = sshCredentialDao.findByName(credentialName)
    if (!saved) {
      const availableNames = sshCredentialDao.findAllNames()
      const hint =
        availableNames.length > 0
          ? ` Available saved credentials: [${availableNames.join(', ')}].`
          : ' No saved credentials are configured.'
      return {
        content: [
          {
            type: 'text',
            text: `No saved SSH credential found with name "${credentialName}".${hint} Use connect without credentialName to let the user enter credentials manually.`
          }
        ],
        details: { type: 'ssh', action: 'connect', success: false, credentialNotFound: true }
      }
    }

    log.info(`使用保存的凭据 "${credentialName}" 连接 SSH session=${ctx.sessionId}`)
    const credentials = {
      host: saved.host,
      port: saved.port,
      username: saved.username,
      password: saved.authType === 'password' ? saved.password : undefined,
      privateKey: saved.authType === 'key' ? saved.privateKey : undefined,
      passphrase: saved.authType === 'key' && saved.passphrase ? saved.passphrase : undefined,
      proxyUrl: saved.metadata?.proxyUrl || undefined
    }

    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    const result = await sshManager.connect(ctx.sessionId, credentials)
    if (result.success) {
      ctx.emitChatEvent?.({
        type: 'runtime_event',
        runtimeId: 'ssh',
        status: {
          label: `${credentials.username}@${credentials.host}`,
          icon: 'Terminal',
          color: '#38bdf8'
        }
      })
      return {
        content: [
          {
            type: 'text',
            text: `Connected to remote server using saved credential "${credentialName}" successfully. You can now use exec to run commands.`
          }
        ],
        details: { type: 'ssh', action: 'connect', success: true, credentialName }
      }
    } else {
      return {
        content: [
          {
            type: 'text',
            text: `Connection failed using saved credential "${credentialName}": ${result.error}. This credential was configured by the user in Settings > Tools > SSH Credentials — please inform them to check their SSH credential configuration.`
          }
        ],
        details: {
          type: 'ssh',
          action: 'connect',
          success: false,
          credentialName,
          error: result.error
        }
      }
    }
  }

  // --- 路径 B：原有 UI 弹窗流程（不变） ---
  if (!ctx.requestUserInput) {
    throw new Error('SSH credential input not available')
  }

  log.info(`请求 SSH 凭据 session=${ctx.sessionId}`)
  const response = await ctx.requestUserInput({
    id: toolCallId,
    kind: 'sshCredentials',
    toolName: 'ssh',
    createdAt: Date.now()
  })

  if (signal?.aborted) throw new Error(TOOL_ABORTED)

  if (response.kind === 'cancel') {
    throw new Error(TOOL_ABORTED)
  }
  // 用户提交"其它"反馈,不连接,把文本作为正常 tool result 返回
  if (response.kind === 'other') {
    return {
      content: [
        {
          type: 'text',
          text: `SSH connection was not attempted. User responded with feedback instead:\n${response.text}`
        }
      ],
      details: { type: 'ssh', action: 'connect', cancelled: true }
    }
  }
  if (response.kind !== 'sshCredentials') {
    throw new Error('Unexpected response kind for SSH credentials request')
  }
  const credentials = response.credentials

  // 使用 sshManager 建立连接（凭据不返回给大模型）
  const result = await sshManager.connect(ctx.sessionId, credentials)

  if (result.success) {
    // 通知前端连接已建立
    ctx.emitChatEvent?.({
      type: 'runtime_event',
      runtimeId: 'ssh',
      status: {
        label: `${credentials.username}@${credentials.host}`,
        icon: 'Terminal',
        color: '#38bdf8'
      }
    })
    return {
      content: [
        {
          type: 'text',
          text: 'Connected to remote server successfully. You can now use exec to run commands.'
        }
      ],
      details: { type: 'ssh', action: 'connect', success: true }
    }
  } else {
    return {
      content: [{ type: 'text', text: `SSH connection failed: ${result.error}` }],
      details: { type: 'ssh', action: 'connect', success: false, error: result.error }
    }
  }
}

/** 处理 exec 动作 */
async function handleExec(
  ctx: ToolContext,
  toolCallId: string,
  command: string | undefined,
  timeout: number | undefined,
  description: string | undefined,
  signal?: AbortSignal
): Promise<AgentToolResult<SshToolDetails>> {
  if (!command) {
    throw new Error('command is required for exec action')
  }

  if (!sshManager.isConnected(ctx.sessionId)) {
    throw new Error('No active SSH connection. Use ssh({ action: "connect" }) first.')
  }

  // 每条命令都需用户审批 —— 唯一豁免是会话级「免审批」开关（无命令模式匹配）
  const sess = sessionDao.pickSettings(ctx.sessionId, ['autoApprove'])
  if (ctx.requestUserInput && !sess?.autoApprove) {
    const response = await ctx.requestUserInput({
      id: toolCallId,
      kind: 'approval',
      toolName: 'ssh',
      command,
      description,
      createdAt: Date.now()
    })
    if (response.kind === 'cancel') {
      throw new Error(TOOL_ABORTED)
    }
    // 用户提交"其它"反馈,不执行命令,把文本作为正常 tool result 返回
    if (response.kind === 'other') {
      return {
        content: [
          {
            type: 'text',
            text: `Command was not executed. User responded with feedback instead:\n${response.text}`
          }
        ],
        details: { type: 'ssh', action: 'exec', cancelled: true }
      }
    }
    if (response.kind !== 'approval' || !response.approved) {
      throw new Error(
        (response.kind === 'approval' && response.reason) || 'User denied execution of this command'
      )
    }
  }

  if (signal?.aborted) throw new Error(TOOL_ABORTED)

  const connInfo = sshManager.getConnectionInfo(ctx.sessionId)
  log.info(`SSH exec (${connInfo?.host}): ${command.slice(0, 80)}`)

  try {
    const result = await sshManager.exec(ctx.sessionId, command, timeout ?? DEFAULT_TIMEOUT, signal)
    const raw = [result.stdout, result.stderr].filter(Boolean).join('\n')
    // 清理控制字符 + 折叠进度输出（仅匹配进度类命令时生效）
    let text = collapseProgressOutput(sanitizeBinaryOutput(raw), command)

    if (result.exitCode === 124) {
      text += `\n\n[Command timed out (${timeout ?? DEFAULT_TIMEOUT}s)]`
    } else if (result.exitCode !== 0) {
      text += `\n\n[Exit code: ${result.exitCode}]`
    }

    // 输出长度的截断/落盘统一由 wrapToolOutput 在构建工具时处理
    return {
      content: [{ type: 'text' as const, text }],
      details: {
        type: 'ssh',
        action: 'exec',
        exitCode: result.exitCode,
        truncated: false,
        // 终端形态详情区用它渲染提示符（远端无可跟踪的 cwd，显示主机才是 ssh 的语义）
        host: connInfo?.host
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    if (errMsg === TOOL_ABORTED || errMsg === 'Aborted') throw err
    // 连接级错误，清理过期连接以便下次可直接重连
    if (sshManager.isConnected(ctx.sessionId)) {
      const connInfo = sshManager.getConnectionInfo(ctx.sessionId)
      await sshManager.disconnect(ctx.sessionId)
      if (connInfo)
        ctx.emitChatEvent?.({
          type: 'runtime_event',
          runtimeId: 'ssh',
          status: null
        })
    }
    throw new Error(
      `SSH command failed: ${errMsg}. The connection has been closed. Use ssh({ action: "connect" }) to reconnect.`
    )
  }
}

/** 处理 disconnect 动作 */
async function handleDisconnect(ctx: ToolContext): Promise<AgentToolResult<SshToolDetails>> {
  if (!sshManager.isConnected(ctx.sessionId)) {
    return {
      content: [{ type: 'text', text: 'No active SSH connection to disconnect.' }],
      details: { type: 'ssh', action: 'disconnect', wasConnected: false }
    }
  }

  // 先获取连接信息再断开
  const connInfo = sshManager.getConnectionInfo(ctx.sessionId)
  await sshManager.disconnect(ctx.sessionId)
  // 通知前端连接已断开
  if (connInfo)
    ctx.emitChatEvent?.({
      type: 'runtime_event',
      runtimeId: 'ssh',
      status: null
    })
  return {
    content: [{ type: 'text', text: 'SSH connection closed.' }],
    details: { type: 'ssh', action: 'disconnect', wasConnected: true }
  }
}

import { registerBuiltinTool } from '../services/toolRegistry'
registerBuiltinTool({
  name: 'ssh',
  group: 'remote',
  getLabel: () => t('tool.sshLabel'),
  getHint: () => t('tool.sshHint'),
  factory: (ctx) => new SshTool(ctx),
  presentation: {
    icon: 'Terminal',
    iconColor: '#38bdf8',
    // 仅 exec 会带 command，connect / disconnect 无命令可渲染，自动降级回通用表单形态
    detailView: 'terminal'
  },
  describe: () => ({ description: buildSshDescription(), parameters: SshParamsSchema })
})
