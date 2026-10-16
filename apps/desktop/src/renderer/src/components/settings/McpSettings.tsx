/**
 * MCP 设置页（桌面）—— 客户端配置（复用共享 McpClientPanel，绑 window.api.mcp，允许 stdio）。
 *
 * 内置能力服务器那几行的展开区挂着它们自己的设置：`browser` —— 一个入口，浏览器自己的设置（搜索引擎、
 * 网站数据、证书）住在浏览器窗口的设置页里（2026-10-16 搬过去）；`database` —— 已保存的数据库连接；
 * `chrome` —— Chrome 扩展的连接状态与安装。
 */
import { McpClientPanel } from '@shuvix/app-shell'
import { BrowserSettingsLink } from './BrowserSettingsLink'
import { DatabaseConnectionsSettings } from './DatabaseConnectionsSettings'
import { ChromeExtensionSettings } from './ChromeExtensionSettings'

export function McpSettings(): React.JSX.Element {
  return (
    <McpClientPanel
      api={window.api.mcp}
      caps={{ allowStdio: true }}
      renderServerExtra={(server) => {
        if (server.isBuiltin !== 1) return null
        if (server.name === 'browser') return <BrowserSettingsLink />
        if (server.name === 'database') return <DatabaseConnectionsSettings />
        if (server.name === 'chrome') return <ChromeExtensionSettings />
        return null
      }}
    />
  )
}
