/**
 * 内置能力服务器 `ssh` —— 进程内 MCP server，按会话实例化。
 *
 * **凭据不归 ShuviX 管**：连接信息全部来自用户自己的 `~/.ssh/config`，工具只接受其中的
 * **host 别名**。于是 known_hosts 校验、ProxyJump、IdentityAgent（1Password / YubiKey）
 * 这些都是白拿的，而 ShuviX 不持有任何 SSH 秘密。
 *
 * 用**低层 `Server`** 而不是 `McpServer`：后者的 `registerTool` 要 zod shape，而 zod 只是
 * MCP SDK 的传递依赖，直接用等于凭空多一个未声明的依赖；低层接口收纯 JSON Schema，
 * 也正好和客户端侧已有的 `jsonSchemaToTypebox` 路径对齐。
 *
 * 本轮只有只读的 `list-hosts`（exec / 文件传输在后续里程碑接入安全模块后再加）。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult
} from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { BuiltinMcpFactory } from '@shuvix/agent-runtime'
import { listSshHosts, defaultSshConfigPath, type SshHostEntry } from './sshConfig'
import {
  sshExec,
  sshDisconnect,
  sshConnectedAliases,
  sshCloseSession,
  classifySshFailure
} from './sshControl'
import { getDesktopSecurityContext, TOOL_ABORTED } from '../toolContext'
import { sanitizeBinaryOutput, collapseProgressOutput } from '../../utils/toolUtils/shell'
import type { DesktopBuiltinMcpScope } from './types'
import { createLogger } from '../../logger'

const log = createLogger('mcp:ssh')

/** 一次列举最多回多少台 —— 配置里几百个别名时不该把上下文全占了 */
const MAX_LISTED_HOSTS = 200
/** exec 默认超时（秒） */
const DEFAULT_TIMEOUT_SEC = 120
/** exec 超时上限（秒，1 小时） */
const MAX_TIMEOUT_SEC = 3600

const EXEC_TOOL = {
  name: 'exec',
  title: 'Run a command over SSH',
  description:
    "Run a shell command on a remote machine. `host` must be one of the aliases returned by list-hosts — there is no way to give a hostname, user, port or credential here, because ssh resolves all of that from the user's own config. The connection is multiplexed and reused, so several hosts can be worked with in parallel simply by varying `host`. Every command asks the user for confirmation before it runs.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      host: { type: 'string', description: 'A host alias from list-hosts.' },
      command: { type: 'string', description: 'The shell command to run on the remote machine.' },
      description: {
        type: 'string',
        description: 'One short line on what this command does and why. Shown to the user.'
      },
      timeout: {
        type: 'integer',
        description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}).`
      }
    },
    required: ['host', 'command', 'description'],
    additionalProperties: false
  },
  annotations: {
    title: 'Run a command over SSH',
    readOnlyHint: false,
    // 远端命令能做任何事 —— 这条提示是给策略用的，别因为「多数命令只是看看」就调软
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true
  }
}

const DISCONNECT_TOOL = {
  name: 'disconnect',
  title: 'Close an SSH connection',
  description:
    'Close the multiplexed connection to one host. Rarely needed — idle connections close on their own, and they are all released when the session is deleted.',
  inputSchema: {
    type: 'object' as const,
    properties: { host: { type: 'string', description: 'A host alias from list-hosts.' } },
    required: ['host'],
    additionalProperties: false
  },
  annotations: {
    title: 'Close an SSH connection',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
}

const LIST_HOSTS_TOOL = {
  name: 'list-hosts',
  title: 'List SSH hosts',
  description:
    "List the host aliases defined in the user's ~/.ssh/config. These aliases are the only way to address a machine with this server — there is no way to pass a raw hostname, user or credential, because connection details and authentication are resolved by ssh itself from the user's own config. If the list is empty the user has not configured any SSH hosts yet; tell them to add one to ~/.ssh/config.",
  // 无参工具的规范写法：显式只接受空对象
  inputSchema: { type: 'object' as const, additionalProperties: false },
  outputSchema: {
    type: 'object' as const,
    properties: {
      configPath: { type: 'string', description: 'Path of the ssh config that was read' },
      total: {
        type: 'integer',
        description: 'How many aliases the config defines, before the listing cap'
      },
      truncated: { type: 'boolean', description: 'True when `hosts` is shorter than `total`' },
      hosts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            alias: { type: 'string' },
            hostname: { type: 'string' },
            user: { type: 'string' },
            port: { type: 'integer' }
          },
          required: ['alias']
        }
      }
    },
    required: ['configPath', 'total', 'truncated', 'hosts']
  },
  annotations: {
    title: 'List SSH hosts',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
}

/** 人读的一行：`alias  →  user@hostname:port` */
function formatHost(h: { alias: string; hostname?: string; user?: string; port?: number }): string {
  const target = [h.user ? `${h.user}@` : '', h.hostname ?? '', h.port ? `:${h.port}` : '']
    .join('')
    .trim()
  return target ? `${h.alias}  →  ${target}` : h.alias
}

/**
 * 把一台 ssh server 接到给定的 server-side transport 上。
 *
 * 资源释放挂在 `transport.onclose`：客户端断开会传播到这一侧（InMemoryTransport.close），
 * 于是「会话结束 → McpManager 关连接 → 这里释放」只有一条路径。本轮没有要释放的东西，
 * 钩子先立好 —— exec 的 control socket 就挂在这里。
 */
export function createSshMcpServerFactory(opts?: {
  configPath?: string
}): BuiltinMcpFactory<DesktopBuiltinMcpScope> {
  return (scope, transport) => createSshMcpServer(scope, transport, opts?.configPath)
}

export async function createSshMcpServer(
  scope: DesktopBuiltinMcpScope,
  transport: Transport,
  /** 配置路径覆写（仅测试 / 未来的 fixture 用）；缺省是用户真正的 ~/.ssh/config */
  configPathOverride?: string
): Promise<void> {
  const server = new Server(
    { name: 'shuvix-ssh', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [LIST_HOSTS_TOOL, EXEC_TOOL, DISCONNECT_TOOL]
  }))

  /** 每次调用现读配置：用户可能刚改过 ~/.ssh/config，缓存在实例上只会让人困惑 */
  const readConfig = (): { configPath: string; hosts: SshHostEntry[] } => {
    const configPath = configPathOverride ?? defaultSshConfigPath()
    return { configPath, hosts: listSshHosts(configPath) }
  }

  const err = (text: string): CallToolResult => ({
    content: [{ type: 'text' as const, text }],
    isError: true
  })

  /**
   * 把 `host` 参数换成一个**确实写在用户配置里**的别名。
   *
   * 这不只是给个友好报错：别名会原样进 `ssh` 的 argv，若放任模型自填，
   * 一个 `-oProxyCommand=…` 就成了本地任意命令执行。「只接受 host 别名」必须是
   * 这里的一次核对，而不只是文档里的一句话。
   */
  const resolveAlias = (host: unknown): SshHostEntry | string => {
    const { configPath, hosts } = readConfig()
    if (typeof host !== 'string' || host.trim() === '') return 'A `host` alias is required.'
    // 复核而非依赖枚举：枚举与校验是两件事，写在两处才叫两道。以 `-` 开头的记号
    // 进了 argv 就是 ssh 的选项（`-oProxyCommand=…` = 本地执行），务必在这里也拦一次。
    if (host.startsWith('-')) return `"${host}" is not a usable host alias.`
    const found = hosts.find((h) => h.alias === host)
    if (found) return found
    const known = hosts.map((h) => h.alias)
    return known.length === 0
      ? `No SSH host aliases are defined in ${configPath}, so "${host}" cannot be reached. Ask the user to add a Host entry there.`
      : `"${host}" is not a host alias in ${configPath}. Only these aliases can be used: ${known.join(', ')}.`
  }

  const handleListHosts = (): CallToolResult => {
    const { configPath, hosts: all } = readConfig()
    const hosts = all.slice(0, MAX_LISTED_HOSTS)
    const connected = new Set(
      sshConnectedAliases(
        scope.sessionId,
        hosts.map((h) => h.alias)
      )
    )
    const text =
      hosts.length === 0
        ? `No SSH host aliases are defined in ${configPath}. Ask the user to add a Host entry there — this server can only address machines by alias.`
        : [
            `${hosts.length} host alias(es) from ${configPath}:`,
            ...hosts.map(
              (h) => `  ${formatHost(h)}${connected.has(h.alias) ? '  [connected]' : ''}`
            ),
            ...(all.length > hosts.length
              ? [`  … ${all.length - hosts.length} more not shown`]
              : [])
          ].join('\n')
    return {
      // 规范要求带 outputSchema 的工具同时回一份序列化文本，供不读 structuredContent 的客户端
      content: [{ type: 'text' as const, text }],
      structuredContent: {
        configPath,
        total: all.length,
        truncated: all.length > hosts.length,
        hosts: hosts.map((h) => ({ ...h, connected: connected.has(h.alias) }))
      }
    }
  }

  const handleExec = async (
    args: Record<string, unknown>,
    toolCallId: string,
    signal?: AbortSignal
  ): Promise<CallToolResult> => {
    const alias = resolveAlias(args.host)
    if (typeof alias === 'string') return err(alias)
    const command = typeof args.command === 'string' ? args.command : ''
    if (!command.trim()) return err('A `command` is required.')
    // 两头都要夹住，而且是同一类错误：上限是因为 setTimeout 的毫秒数超过 2^31-1 会被
    // Node 截成 1ms（「我要等很久」变成「立刻超时」）；下限是因为 floor 会把 0.5 变成 0
    // （`setTimeout(0)` 同样立刻就烧）。两端都让模型拿到与它意图相反的结果。
    const rawTimeout = args.timeout
    const timeoutSec =
      typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
        ? Math.min(Math.max(Math.floor(rawTimeout), 1), MAX_TIMEOUT_SEC)
        : DEFAULT_TIMEOUT_SEC

    // 命令级安全门。**这是内置服务器相对第三方 server 的实质特权**：它拿得到会话的
    // SecurityContext，于是远端命令走的是和 bash 同一条命令客体（channel: 'ssh'），
    // ask-on-command / block-catastrophic-commands 这些策略照常生效 ——
    // 而一台普通 MCP server 只能过 L1 那道「有人要调工具」的门。
    const security = getDesktopSecurityContext({
      sessionId: scope.sessionId,
      requestUserInput: scope.requestUserInput
    })
    const outcome = await security.enforceCommand(
      { channel: 'ssh', command, host: alias.alias },
      {
        toolCallId,
        toolName: 'mcp__ssh__exec',
        description: typeof args.description === 'string' ? args.description : undefined,
        abortError: TOOL_ABORTED,
        onOther: 'return',
        missingChannel: 'deny'
      }
    )
    if (outcome.status === 'feedback') {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Command was not executed. User responded with feedback instead:\n${outcome.text}`
          }
        ]
      }
    }
    // 询问可能挂了很久，这期间 run 可能已被中止。**真正重要的是不要再去跑那条命令** ——
    // 返回的这句话其实到不了模型那边（SDK 对已取消的请求直接丢弃响应），
    // 但「用户点开卡片时早已中止，approve 后却还是连上去跑了」必须不发生。
    if (signal?.aborted) return err('Aborted')

    const result = await sshExec({
      sessionId: scope.sessionId,
      alias: alias.alias,
      command,
      timeoutSec,
      signal,
      configPath: configPathOverride
    })

    // ssh 自身失败（连不上、主机密钥不认）用 255 报出来，翻译成可操作的说明；
    // 远端命令自己的非零退出码不属于这一类，原样带回去让 agent 自己判断
    if (result.exitCode === 255) {
      const explained = classifySshFailure(alias.alias, result.stderr, result.stdout)
      if (explained) return err(explained)
    }
    if (result.exitCode === 0) announceConnected(alias.alias)

    const raw = [result.stdout, result.stderr].filter(Boolean).join('\n')
    let text = collapseProgressOutput(sanitizeBinaryOutput(raw), command)
    if (result.timedOut) text += `\n\n[Command timed out after ${timeoutSec}s]`
    else if (result.exitCode !== 0) text += `\n\n[Exit code: ${result.exitCode}]`
    return { content: [{ type: 'text' as const, text: text.trim() || '(no output)' }] }
  }

  const handleDisconnect = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const alias = resolveAlias(args.host)
    if (typeof alias === 'string') return err(alias)
    const wasConnected = await sshDisconnect(scope.sessionId, alias.alias, configPathOverride)
    announceConnected(undefined)
    return {
      content: [
        {
          type: 'text' as const,
          text: wasConnected
            ? `Closed the connection to "${alias.alias}".`
            : `There was no open connection to "${alias.alias}".`
        }
      ]
    }
  }

  /** 连接状态条：连上时显示别名，断开时清掉 */
  const announceConnected = (alias: string | undefined): void => {
    scope.emitChatEvent?.({
      type: 'runtime_event',
      runtimeId: 'ssh',
      status: alias ? { label: alias, icon: 'Terminal', color: '#38bdf8' } : null
    })
  }

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    // 客户端把 pi 那边的 toolCallId 放在 `_meta` 里（见 McpManager.callTool）——
    // 询问卡片用它做路由键，于是这台服务器的 ask 和内置工具的 ask 长得一样
    const meta = request.params._meta as Record<string, unknown> | undefined
    const toolCallId =
      typeof meta?.['shuvix.dev/toolCallId'] === 'string'
        ? (meta['shuvix.dev/toolCallId'] as string)
        : `ssh-${String(extra.requestId)}`

    switch (request.params.name) {
      case LIST_HOSTS_TOOL.name:
        return handleListHosts()
      case EXEC_TOOL.name:
        return handleExec(args, toolCallId, extra.signal)
      case DISCONNECT_TOOL.name:
        return handleDisconnect(args)
      default:
        return err(`Unknown tool: ${request.params.name}`)
    }
  })

  // 会话没了 → McpManager 关掉这条连接 → 传播到这一侧 → 释放该会话名下的 control socket。
  // 这是「寿命绑会话」在资源上的兑现：一次运行时重建（invalidate）不会走到这里，
  // 所以 ssh 连接挺得过重建，而会话删除挺不过。
  transport.onclose = (): void => {
    const aliases = listSshHosts(configPathOverride ?? defaultSshConfigPath()).map((h) => h.alias)
    void sshCloseSession(scope.sessionId, aliases, configPathOverride)
      .then((n) => log.info(`ssh server closed session=${scope.sessionId} (${n} connection(s))`))
      .catch((e: unknown) => log.warn(`ssh close failed: ${e instanceof Error ? e.message : e}`))
  }

  await server.connect(transport)
  log.info(`ssh server ready session=${scope.sessionId}`)
}
