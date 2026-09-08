/**
 * MCP 设置页（桌面）—— 客户端配置（复用共享 McpClientPanel，绑 window.api.mcp，允许 stdio）。
 */
import { McpClientPanel } from '@shuvix/app-shell'

export function McpSettings(): React.JSX.Element {
  return <McpClientPanel api={window.api.mcp} caps={{ allowStdio: true }} />
}
