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
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { BuiltinMcpScope } from '@shuvix/agent-runtime'
import { listSshHosts, defaultSshConfigPath } from './sshConfig'
import { createLogger } from '../../logger'

const log = createLogger('mcp:ssh')

/** 一次列举最多回多少台 —— 配置里几百个别名时不该把上下文全占了 */
const MAX_LISTED_HOSTS = 200

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
    required: ['configPath', 'hosts']
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
export async function createSshMcpServer(
  scope: BuiltinMcpScope,
  transport: Transport
): Promise<void> {
  const server = new Server(
    { name: 'shuvix-ssh', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [LIST_HOSTS_TOOL] }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== LIST_HOSTS_TOOL.name) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }],
        isError: true
      }
    }

    const configPath = defaultSshConfigPath()
    const all = listSshHosts(configPath)
    const hosts = all.slice(0, MAX_LISTED_HOSTS)
    const structuredContent = { configPath, hosts }

    const text =
      hosts.length === 0
        ? `No SSH host aliases are defined in ${configPath}. Ask the user to add a Host entry there — this server can only address machines by alias.`
        : [
            `${hosts.length} host alias(es) from ${configPath}:`,
            ...hosts.map((h) => `  ${formatHost(h)}`),
            ...(all.length > hosts.length
              ? [`  … ${all.length - hosts.length} more not shown`]
              : [])
          ].join('\n')

    return {
      // 规范要求带 outputSchema 的工具同时回一份序列化文本，供不读 structuredContent 的客户端
      content: [{ type: 'text' as const, text }],
      structuredContent
    }
  })

  transport.onclose = (): void => {
    log.info(`ssh server closed session=${scope.sessionId}`)
  }

  await server.connect(transport)
  log.info(`ssh server ready session=${scope.sessionId}`)
}
