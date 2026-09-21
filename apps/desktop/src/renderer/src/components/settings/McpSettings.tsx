/**
 * MCP 设置页（桌面）—— 客户端配置（复用共享 McpClientPanel，绑 window.api.mcp，允许 stdio）。
 *
 * 内置 `browser` 那一行的展开区挂着内置浏览器自己的设置（站点数据、证书错误处理）：
 * 浏览器是按会话勾选的内置 MCP 能力服务器，它的设置就跟着它放在这里。
 */
import { McpClientPanel } from '@shuvix/app-shell'
import { BrowserDataSettings } from './BrowserDataSettings'

export function McpSettings(): React.JSX.Element {
  return (
    <McpClientPanel
      api={window.api.mcp}
      caps={{ allowStdio: true }}
      renderServerExtra={(server) =>
        server.isBuiltin === 1 && server.name === 'browser' ? <BrowserDataSettings /> : null
      }
    />
  )
}
