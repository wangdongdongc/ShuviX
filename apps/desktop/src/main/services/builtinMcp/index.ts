/**
 * 内置能力服务器的清单 —— 名字 → 工厂。
 *
 * 只导出**数据**，注册动作由 `mcpService` 完成：本模块是内聚模块，不能反向依赖上层扁平服务
 * （eslint-plugin-boundaries 拦着），所以由上层来取、而不是本模块去注册。
 *
 * 新增一台内置能力服务器 = 这里加一行 + 一条种子迁移 + chat-protocol 里的一条呈现。
 */
import { BROWSER_MCP_SERVER_NAME, type BuiltinMcpFactory } from '@shuvix/agent-runtime'
import type { DesktopBuiltinMcpScope } from './types'
import { createSshMcpServerFactory } from './sshServer'
import { createDesktopBrowserMcpServerFactory } from './browserServer'
import { createDatabaseMcpServerFactory, DATABASE_MCP_SERVER_NAME } from './databaseServer'
import { CHROME_MCP_SERVER_NAME, createChromeMcpServerFactory } from './chromeServer'

/**
 * 键就是 `mcp_servers.name`，也是工具名前缀
 * （`mcp__ssh__list-hosts`、`mcp__browser__click`、`mcp__database__query`、`mcp__chrome__click`）
 */
export const BUILTIN_MCP_FACTORIES: Record<string, BuiltinMcpFactory<DesktopBuiltinMcpScope>> = {
  ssh: createSshMcpServerFactory(),
  [BROWSER_MCP_SERVER_NAME]: createDesktopBrowserMcpServerFactory(),
  [DATABASE_MCP_SERVER_NAME]: createDatabaseMcpServerFactory(),
  // 用户真实的 Chrome：只由 Chrome 标签页会话的基座档案 `tab` 声明，普通会话选不到（见 chromeServer.ts）
  [CHROME_MCP_SERVER_NAME]: createChromeMcpServerFactory()
}

export { CHROME_MCP_SERVER_NAME }

export { listSshHosts, defaultSshConfigPath, type SshHostEntry } from './sshConfig'
export type { DesktopBuiltinMcpScope } from './types'
