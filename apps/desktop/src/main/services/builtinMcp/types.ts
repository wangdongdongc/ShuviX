/**
 * 内置能力服务器的**桌面** scope。
 *
 * 运行时只保证 `sessionId`；询问通道由扁平层的 `mcpService` 补齐后传进来 ——
 * 不是因为它推不出来（`requestUserInputFor` 就是按 sessionId 找归属的），而是因为
 * eslint-plugin-boundaries 不让内聚模块反向依赖 `services/` 根目录的扁平服务。
 * 由上层注入，边界与依赖方向都保持原样。
 */
import type { BuiltinMcpScope } from '@shuvix/agent-runtime'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { ChatEventPayload } from '../toolContext'

export interface DesktopBuiltinMcpScope extends BuiltinMcpScope {
  /** 挂起询问并等用户答复（安全模块的 ask 卡走它）；缺省 = 这条会话没有输入面板 */
  requestUserInput?: (request: InputRequest) => Promise<InputResponse>
  /** 运行时单向通知（连接状态条） */
  emitChatEvent?: (event: ChatEventPayload) => void
}
