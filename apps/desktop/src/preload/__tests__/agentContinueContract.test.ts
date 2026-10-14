/**
 * P3-12-07（preload / 契约那一半）：`api.agent.continue(sid)` 走 `invoke('agent:continue', sid)`（通道表
 * `shared/apiTable` 里的一条：invoke、转发一个参数）；`window.api` 的类型（index.d.ts）与渠道契约
 * `SessionChannelApi.agent.continue` 都声明了它，回包是 `AgentContinueResult`。index.d.ts 静态查源码。
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentContinueResult, SessionChannelApi } from '@shuvix/chat-protocol/chatApi'
import { API_TABLE } from '../../shared/apiTable'

describe('P3-12-07 agent.continue contract', () => {
  it('P3-12-07 preload forwards to agent:continue; index.d.ts declares it; SessionChannelApi carries it', () => {
    expect(API_TABLE.agent.continue).toEqual({ kind: 'invoke', channel: 'agent:continue', args: 1 })
    const dts = readFileSync(join(__dirname, '..', 'index.d.ts'), 'utf8')
    expect(dts).toMatch(/\n\s+continue: \(sessionId: string\) => Promise<AgentContinueResult>\n/)
    expectTypeOf<SessionChannelApi['agent']['continue']>().toEqualTypeOf<
      (sessionId: string) => Promise<AgentContinueResult>
    >()
    expectTypeOf<AgentContinueResult>().toEqualTypeOf<{
      success: boolean
      error?: string
      code?: string
    }>()
  })
})
