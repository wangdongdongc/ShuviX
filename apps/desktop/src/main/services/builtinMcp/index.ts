/**
 * 内置能力服务器的清单 —— 名字 → 工厂。
 *
 * 只导出**数据**，注册动作由 `mcpService` 完成：本模块是内聚模块，不能反向依赖上层扁平服务
 * （eslint-plugin-boundaries 拦着），所以由上层来取、而不是本模块去注册。
 *
 * 新增一台内置能力服务器 = 这里加一行 + 一条种子迁移。
 */
import type { BuiltinMcpFactory } from '@shuvix/agent-runtime'
import { createSshMcpServerFactory } from './sshServer'

/** 键就是 `mcp_servers.name`，也是工具名前缀（`mcp__ssh__list-hosts`） */
export const BUILTIN_MCP_FACTORIES: Record<string, BuiltinMcpFactory> = {
  ssh: createSshMcpServerFactory()
}

export { listSshHosts, defaultSshConfigPath, type SshHostEntry } from './sshConfig'
