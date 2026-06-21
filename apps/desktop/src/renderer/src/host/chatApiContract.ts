/**
 * 编译期契约断言 —— 保证 Electron 暴露的 `window.api`（全局类型 `ShuviXAPI`）结构上
 * 满足 `@shuvix/chat-protocol` 定义的 `ChatApi` 协议契约。
 *
 * chat-ui 只面向 `ChatApi` 编程；桌面端 renderer 通过 `getChatApi()` 回退到 window.api。
 * 此文件让「window.api 改动导致与契约不兼容」在桌面端 typecheck:web 阶段即报错（零漂移），
 * 并指出不匹配的命名空间/方法。纯类型校验，无有效运行时行为。
 */
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'

// 若 ShuviXAPI 不再可赋值给 ChatApi，此行报错（TS 会指出具体不兼容的成员）。
const _chatApiContract: ChatApi = undefined as unknown as ShuviXAPI
void _chatApiContract
