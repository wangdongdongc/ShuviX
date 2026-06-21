// MCP Server 类型已下沉 @shuvix/chat-protocol（桌面/扩展/共享 McpManager 单一来源）。
// 此处再导出，兼容既有 import 路径与 DB 行语义。
export type { McpTransportType, McpServer } from '@shuvix/chat-protocol/types/mcp'
