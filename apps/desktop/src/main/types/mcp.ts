// MCP 类型已下沉 @shuvix/chat-protocol（桌面/扩展/共享 McpManager 单一来源）。此处再导出。
export type {
  McpTransportType,
  McpServer,
  McpServerStatus,
  McpServerAddParams,
  McpServerUpdateParams,
  McpServerInfo,
  McpToolInfo
} from '@shuvix/chat-protocol/types/mcp'
// McpToolDetails 由 types/message.ts 从 chatMessage 再导出，勿在此重复（避免 index.ts 歧义）
