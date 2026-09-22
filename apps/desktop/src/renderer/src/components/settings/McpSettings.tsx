/**
 * MCP 设置页（桌面）—— 客户端配置（复用共享 McpClientPanel，绑 window.api.mcp，允许 stdio）。
 *
 * 内置能力服务器那几行的展开区挂着它们自己的设置：`browser` —— 内置浏览器的站点数据与证书错误处理；
 * `database` —— 已保存的数据库连接。它们都是按会话勾选的内置 MCP 能力服务器，设置就跟着它们放在这里。
 */
import { McpClientPanel } from '@shuvix/app-shell'
import { BrowserDataSettings } from './BrowserDataSettings'
import { DatabaseConnectionsSettings } from './DatabaseConnectionsSettings'

export function McpSettings(): React.JSX.Element {
  return (
    <McpClientPanel
      api={window.api.mcp}
      caps={{ allowStdio: true }}
      renderServerExtra={(server) => {
        if (server.isBuiltin !== 1) return null
        if (server.name === 'browser') return <BrowserDataSettings />
        if (server.name === 'database') return <DatabaseConnectionsSettings />
        return null
      }}
    />
  )
}
