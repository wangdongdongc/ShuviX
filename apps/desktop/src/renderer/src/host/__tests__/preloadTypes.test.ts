/**
 * P3-08-44（类型层）—— preload 暴露给渲染端的类型与 chat-protocol 的契约对得上：
 *  - 全局 `ChatEvent`（preload/index.d.ts）与 chat-protocol 的 `ChatEvent` 双向可赋值（不再手抄一份）；
 *  - `window.api.sync` 就是 `SyncChannel`；
 *  - `agent.onEvent` 还在（余项事件仍走它）；
 *  - P3-11-08：`agent.withdrawQueued` 与契约同形。
 *
 * 断言都在编译期（typecheck:web 带上本文件）；运行时只跑一条恒真的样本，让 vitest 收得到它。
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ChatEvent as ProtocolChatEvent } from '@shuvix/chat-protocol/events'
import type { SyncChannel } from '@shuvix/chat-protocol/sync'
import type { SessionChannelApi } from '@shuvix/chat-protocol/chatApi'

describe('P3-08-44 preload 类型', () => {
  it('ChatEvent 双向可赋值；sync = SyncChannel；agent.onEvent 在', () => {
    expectTypeOf<ChatEvent>().toEqualTypeOf<ProtocolChatEvent>()
    const toProtocol = (event: ChatEvent): ProtocolChatEvent => event
    const fromProtocol = (event: ProtocolChatEvent): ChatEvent => event
    expectTypeOf<ShuviXAPI['sync']>().toEqualTypeOf<SyncChannel>()
    expectTypeOf<ShuviXAPI['agent']['onEvent']>().toEqualTypeOf<
      (callback: (event: ChatEvent) => void) => () => void
    >()
    expectTypeOf<ShuviXAPI['agent']['withdrawQueued']>().toEqualTypeOf<
      SessionChannelApi['agent']['withdrawQueued']
    >()
    const sample: ChatEvent = { type: 'agent_end', sessionId: 's1', reason: 'ok' }
    expect(fromProtocol(toProtocol(sample))).toBe(sample)
  })
})
