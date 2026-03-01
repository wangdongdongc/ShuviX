/**
 * SSH 工具 — 通过 SSH 连接远程服务器并执行命令
 * connect 动作无参数，凭据由用户在 UI 弹窗中输入，不经过大模型
 * exec 动作每次都需用户审批
 */

import { Type } from '@sinclair/typebox'
import { sshManager } from '../services/sshManager'
import { sshCredentialDao } from '../dao/sshCredentialDao'
import { sessionDao } from '../dao/sessionDao'
import { truncateTail, formatSize, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from './utils/truncate'
import { BaseTool, TOOL_ABORTED, type ToolContext } from './types'
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
  timeout: Type.Optional(
    Type.Number({
      description: `Command timeout in seconds (default: ${DEFAULT_TIMEOUT}s). Only for exec action.`
    })
  )
})

export class SshTool extends BaseTool<typeof SshParamsSchema> {
  readonly name = 'ssh'
  readonly label = t('tool.sshLabel')
  readonly description: string
  readonly parameters = SshParamsSchema

  constructor(private ctx: ToolContext) {
    super()
    // 动态构建描述，包含已保存的凭据名称
    const savedNames = sshCredentialDao.findAllNames()
    let desc = 'Connect to a remote server via SSH and execute commands.'
    if (savedNames.length > 0) {
      desc += ` The user has configured saved SSH credentials: [${savedNames.join(', ')}]. To use a saved credential, call connect with the credentialName parameter, e.g. ssh({ action: "connect", credentialName: "${savedNames[0]}" }).`
    }
    desc +=
      ' To connect without a saved credential, use action="connect" without credentialName — the user will provide credentials via a secure UI dialog (you do NOT need to provide host, username, or password).'
    desc +=
      ' Use action="exec" with a command to run it on the remote server. Use action="disconnect" to close the connection. Each exec command requires user approval before execution.'
    this.description = desc
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
      passphrase: saved.authType === 'key' && saved.passphrase ? saved.passphrase : undefined
    }

    const result = await sshManager.connect(this.ctx.sessionId, credentials)
    if (result.success) {
      this.ctx.onSshConnected?.(credentials.host, credentials.port, credentials.username)
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
      timeout?: number
    },
    signal?: AbortSignal
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    switch (params.action) {
      case 'connect':
        return handleConnect(this.ctx, toolCallId, params.credentialName, signal)
      case 'exec':
        return handleExec(this.ctx, toolCallId, params.command, params.timeout, signal)
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
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
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
      details: { action: 'connect', alreadyConnected: true, host: info?.host }
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
        details: { action: 'connect', success: false, credentialNotFound: true }
      }
    }

    log.info(`使用保存的凭据 "${credentialName}" 连接 SSH session=${ctx.sessionId}`)
    const credentials = {
      host: saved.host,
      port: saved.port,
      username: saved.username,
      password: saved.authType === 'password' ? saved.password : undefined,
      privateKey: saved.authType === 'key' ? saved.privateKey : undefined,
      passphrase: saved.authType === 'key' && saved.passphrase ? saved.passphrase : undefined
    }

    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    const result = await sshManager.connect(ctx.sessionId, credentials)
    if (result.success) {
      ctx.onSshConnected?.(credentials.host, credentials.port, credentials.username)
      return {
        content: [
          {
            type: 'text',
            text: `Connected to remote server using saved credential "${credentialName}" successfully. You can now use exec to run commands.`
          }
        ],
        details: { action: 'connect', success: true, credentialName }
      }
    } else {
      return {
        content: [
          {
            type: 'text',
            text: `Connection failed using saved credential "${credentialName}": ${result.error}. This credential was configured by the user in Settings > Tools > SSH Credentials — please inform them to check their SSH credential configuration.`
          }
        ],
        details: { action: 'connect', success: false, credentialName, error: result.error }
      }
    }
  }

  // --- 路径 B：原有 UI 弹窗流程（不变） ---
  if (!ctx.requestSshCredentials) {
    throw new Error('SSH credential input not available')
  }

  log.info(`请求 SSH 凭据 session=${ctx.sessionId}`)
  const credentials = await ctx.requestSshCredentials(toolCallId)

  if (signal?.aborted) throw new Error(TOOL_ABORTED)

  // 用户取消连接
  if (!credentials) {
    return {
      content: [{ type: 'text', text: 'User cancelled SSH connection.' }],
      details: { action: 'connect', cancelled: true }
    }
  }

  // 使用 sshManager 建立连接（凭据不返回给大模型）
  const result = await sshManager.connect(ctx.sessionId, credentials)

  if (result.success) {
    // 通知前端连接已建立
    ctx.onSshConnected?.(credentials.host, credentials.port, credentials.username)
    return {
      content: [
        {
          type: 'text',
          text: 'Connected to remote server successfully. You can now use exec to run commands.'
        }
      ],
      details: { action: 'connect', success: true }
    }
  } else {
    return {
      content: [{ type: 'text', text: `SSH connection failed: ${result.error}` }],
      details: { action: 'connect', success: false, error: result.error }
    }
  }
}

/** 处理 exec 动作 */
async function handleExec(
  ctx: ToolContext,
  toolCallId: string,
  command: string | undefined,
  timeout: number | undefined,
  signal?: AbortSignal
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
  if (!command) {
    throw new Error('command is required for exec action')
  }

  if (!sshManager.isConnected(ctx.sessionId)) {
    throw new Error('No active SSH connection. Use ssh({ action: "connect" }) first.')
  }

  // 每条命令都需用户审批（会话开启 sshAutoApprove 时跳过）
  let sshAutoApprove = false
  try {
    const sess = sessionDao.findById(ctx.sessionId)
    sshAutoApprove = JSON.parse(sess?.settings || '{}').sshAutoApprove === true
  } catch {
    /* ignore */
  }
  if (ctx.requestApproval && !sshAutoApprove) {
    const approval = await ctx.requestApproval(toolCallId, command)
    if (!approval.approved) {
      throw new Error(approval.reason || 'User denied execution of this command')
    }
  }

  if (signal?.aborted) throw new Error(TOOL_ABORTED)

  const connInfo = sshManager.getConnectionInfo(ctx.sessionId)
  log.info(`SSH exec (${connInfo?.host}): ${command.slice(0, 80)}`)

  try {
    const result = await sshManager.exec(ctx.sessionId, command, timeout ?? DEFAULT_TIMEOUT, signal)
    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')

    // 截断过长的输出
    const truncated = truncateTail(combined, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES)

    let text = ''
    if (truncated.truncated) {
      text += `[Output truncated: ${truncated.originalLines} lines / ${formatSize(truncated.originalBytes)}]\n\n`
    }
    text += truncated.text

    if (result.exitCode === 124) {
      text += `\n\n[Command timed out (${timeout ?? DEFAULT_TIMEOUT}s)]`
    } else if (result.exitCode !== 0) {
      text += `\n\n[Exit code: ${result.exitCode}]`
    }

    return {
      content: [{ type: 'text' as const, text }],
      details: {
        action: 'exec',
        exitCode: result.exitCode,
        truncated: truncated.truncated
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)
    if (errMsg === TOOL_ABORTED || errMsg === 'Aborted') throw err
    // 连接级错误，清理过期连接以便下次可直接重连
    if (sshManager.isConnected(ctx.sessionId)) {
      const connInfo = sshManager.getConnectionInfo(ctx.sessionId)
      await sshManager.disconnect(ctx.sessionId)
      if (connInfo) ctx.onSshDisconnected?.(connInfo.host, connInfo.port, connInfo.username)
    }
    throw new Error(
      `SSH command failed: ${errMsg}. The connection has been closed. Use ssh({ action: "connect" }) to reconnect.`
    )
  }
}

/** 处理 disconnect 动作 */
async function handleDisconnect(
  ctx: ToolContext
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
  if (!sshManager.isConnected(ctx.sessionId)) {
    return {
      content: [{ type: 'text', text: 'No active SSH connection to disconnect.' }],
      details: { action: 'disconnect', wasConnected: false }
    }
  }

  // 先获取连接信息再断开
  const connInfo = sshManager.getConnectionInfo(ctx.sessionId)
  await sshManager.disconnect(ctx.sessionId)
  // 通知前端连接已断开
  if (connInfo) ctx.onSshDisconnected?.(connInfo.host, connInfo.port, connInfo.username)
  return {
    content: [{ type: 'text', text: 'SSH connection closed.' }],
    details: { action: 'disconnect', wasConnected: true }
  }
}
