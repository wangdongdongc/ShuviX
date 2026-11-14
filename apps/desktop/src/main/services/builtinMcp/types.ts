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
import type { ToolAgentIdentity } from '../toolAgent'

export interface DesktopBuiltinMcpScope extends BuiltinMcpScope {
  /** 挂起询问并等用户答复（安全模块的 ask 卡走它）；缺省 = 这条会话没有输入面板 */
  requestUserInput?: (request: InputRequest) => Promise<InputResponse>
  /** 运行时单向通知（连接状态条） */
  emitChatEvent?: (event: ChatEventPayload) => void
  /**
   * 按 durable 对话认出发起调用的 agent（`_meta['shuvix.dev/conversationId']` → 档案名 / root /
   * spawned）。一份实例由根 agent 与它派出的 agent 共用，安全主体得按调用现认：服务器把它交给
   * getDesktopSecurityContext，每次 enforce 按 opts 里的 conversationId 现取（认不出 / 抛错 = root）。
   * **每次调用现问**，不在建连时快照 —— 由 mcpService 从启动时注册的解析器补上
   * （见 setBuiltinMcpAgentResolver）；缺省 = 宿主没接，主体按 root。
   */
  agentOf?: (conversationId: number) => ToolAgentIdentity | undefined
}
