import { BuiltinToolsView } from '@shuvix/app-shell'

/**
 * 工具配置页：复用共享的 <BuiltinToolsView>（每工具一个子页 + 顶部 metadata 卡片）。
 * 浏览器的数据 / 证书设置与数据库的已保存连接随各自的能力搬到了 MCP 设置里内置 `browser` /
 * `database` 那一行（BrowserDataSettings / DatabaseConnectionsSettings）。
 * 子智能体管理已移至侧栏的「智能体」分组（AgentGroup）。
 */
export function ToolSettings(): React.JSX.Element {
  return <BuiltinToolsView loadDefinitions={() => window.api.tools.definitions()} />
}
