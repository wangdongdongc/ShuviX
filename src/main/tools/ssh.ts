/**
 * SSH 工具 — 通过 SSH 连接远程服务器并执行命令
 * connect 动作无参数，凭据由用户在 UI 弹窗中输入，不经过大模型
 * exec 动作每次都需用户审批
 */

import { Type } from '@sinclair/typebox'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { sshManager } from '../services/sshManager'
import { truncateTail, formatSize, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from './utils/truncate'
import { TOOL_ABORTED, type ToolContext } from './types'
import { t } from '../i18n'
import { createLogger } from '../logger'
const log = createLogger('Tool:ssh')

/** 默认超时时间（秒） */
const DEFAULT_TIMEOUT = 120

const SshParamsSchema = Type.Object({
  action: Type.Union(
    [Type.Literal('connect'), Type.Literal('exec'), Type.Literal('disconnect')],
    { description: 'Action to perform: "connect" to establish SSH connection (credentials provided by user via UI), "exec" to run a command on the remote server, "disconnect" to close the connection.' }
  ),
  command: Type.Optional(
    Type.String({ description: 'The command to execute on the remote server (required for exec action).' })
  ),
  timeout: Type.Optional(
    Type.Number({ description: `Command timeout in seconds (default: ${DEFAULT_TIMEOUT}s). Only for exec action.` })
  )
})

/** 创建 ssh 工具实例 */
export function createSshTool(ctx: ToolContext): AgentTool<typeof SshParamsSchema> {
  return {
    name: 'ssh',
    label: t('tool.sshLabel'),
    description:
      'Connect to a remote server via SSH and execute commands. Use action="connect" to initiate a connection (user will provide credentials via a secure UI dialog — you do NOT need to provide host, username, or password). Use action="exec" with a command to run it on the remote server. Use action="disconnect" to close the connection. Each exec command requires user approval before execution.',
    parameters: SshParamsSchema,
    execute: async (
      toolCallId: string,
      params: { action: 'connect' | 'exec' | 'disconnect'; command?: string; timeout?: number },
      signal?: AbortSignal
    ) => {
      if (signal?.aborted) throw new Error(TOOL_ABORTED)

      switch (params.action) {
        case 'connect':
          return handleConnect(ctx, toolCallId, signal)
        case 'exec':
          return handleExec(ctx, toolCallId, params.command, params.timeout, signal)
        case 'disconnect':
          return handleDisconnect(ctx)
        default:
          throw new Error(`Unknown action: ${params.action}`)
      }
    }
  }
}

/** 处理 connect 动作 */
async function handleConnect(
  ctx: ToolContext,
  toolCallId: string,
  signal?: AbortSignal
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: any }> {
  // 检查是否已有连接
  if (sshManager.isConnected(ctx.sessionId)) {
    const info = sshManager.getConnectionInfo(ctx.sessionId)
    return {
      content: [{ type: 'text', text: `Already connected to remote server. Use exec to run commands or disconnect first.` }],
      details: { action: 'connect', alreadyConnected: true, host: info?.host }
    }
  }

  // 请求用户输入凭据（通过 IPC 弹出 UI 弹窗）
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
      content: [{ type: 'text', text: 'Connected to remote server successfully. You can now use exec to run commands.' }],
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
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: any }> {
  if (!command) {
    throw new Error('command is required for exec action')
  }

  if (!sshManager.isConnected(ctx.sessionId)) {
    throw new Error('No active SSH connection. Use ssh({ action: "connect" }) first.')
  }

  // 每条命令都需用户审批
  if (ctx.requestApproval) {
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
  } catch (err: any) {
    if (err.message === TOOL_ABORTED || err.message === 'Aborted') throw err
    // 连接级错误，清理过期连接以便下次可直接重连
    if (sshManager.isConnected(ctx.sessionId)) {
      const connInfo = sshManager.getConnectionInfo(ctx.sessionId)
      await sshManager.disconnect(ctx.sessionId)
      if (connInfo) ctx.onSshDisconnected?.(connInfo.host, connInfo.port, connInfo.username)
    }
    throw new Error(
      `SSH command failed: ${err.message}. The connection has been closed. Use ssh({ action: "connect" }) to reconnect.`
    )
  }
}

/** 处理 disconnect 动作 */
async function handleDisconnect(
  ctx: ToolContext
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: any }> {
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
