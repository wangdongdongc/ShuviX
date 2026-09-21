/**
 * 扩展端「会话 → 询问通道」登记处（userInputBroker）—— 内置 browser server 的安全门按会话 id 在这里
 * 取询问通道（通道长在那条会话的根运行时上，直接去拿运行时会成环）。
 *
 * 钉的是三条：登记了就路由过去；没登记 / 已注销 → 以 `NO_INTERACTIVE_INPUT` 拒绝（安全门据此
 * fail-closed）；会话之间互不串，同一会话后登记的覆盖先登记的。
 *
 * 登记表是模块级的 Map：每条用例用自己的会话 id，互不干扰。
 */
import { describe, expect, it, vi } from 'vitest'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import {
  clearSessionInputChannel,
  requestUserInputFor,
  setSessionInputChannel
} from '../userInputBroker'

const request = (id: string): InputRequest => ({
  id,
  kind: 'ask',
  toolName: 'mcp__browser__open_tab',
  command: 'https://a.example/',
  createdAt: 0
})

const channel = (
  reply: InputResponse
): ReturnType<typeof vi.fn<(req: InputRequest) => Promise<InputResponse>>> =>
  vi.fn(async (_req: InputRequest) => reply)

describe('userInputBroker', () => {
  it('UIB-1 登记了通道 → 请求原样交给它，回它的答复', async () => {
    const ch = channel({ kind: 'ask', allowed: true })
    setSessionInputChannel('uib-1', ch)
    const req = request('tc-1')
    await expect(requestUserInputFor('uib-1', req)).resolves.toEqual({
      kind: 'ask',
      allowed: true
    })
    expect(ch).toHaveBeenCalledTimes(1)
    expect(ch).toHaveBeenCalledWith(req)
  })

  it('UIB-2 从没登记过的会话 → Error("NO_INTERACTIVE_INPUT")', async () => {
    const outcome = requestUserInputFor('uib-unknown', request('tc-2'))
    await expect(outcome).rejects.toBeInstanceOf(Error)
    await expect(outcome).rejects.toThrow('NO_INTERACTIVE_INPUT')
  })

  it('UIB-3 注销之后 → 同样拒绝，通道不再被调用', async () => {
    const ch = channel({ kind: 'ask', allowed: true })
    setSessionInputChannel('uib-3', ch)
    clearSessionInputChannel('uib-3')
    await expect(requestUserInputFor('uib-3', request('tc-3'))).rejects.toThrow(
      'NO_INTERACTIVE_INPUT'
    )
    expect(ch).not.toHaveBeenCalled()
  })

  it('UIB-4 会话之间互不串；注销一条不影响另一条；同一会话后登记的覆盖先登记的', async () => {
    const a = channel({ kind: 'ask', allowed: true })
    const b = channel({ kind: 'ask', allowed: false })
    setSessionInputChannel('uib-4a', a)
    setSessionInputChannel('uib-4b', b)
    await expect(requestUserInputFor('uib-4a', request('x'))).resolves.toEqual({
      kind: 'ask',
      allowed: true
    })
    await expect(requestUserInputFor('uib-4b', request('y'))).resolves.toEqual({
      kind: 'ask',
      allowed: false
    })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)

    clearSessionInputChannel('uib-4a')
    await expect(requestUserInputFor('uib-4a', request('z'))).rejects.toThrow(
      'NO_INTERACTIVE_INPUT'
    )
    await expect(requestUserInputFor('uib-4b', request('z'))).resolves.toEqual({
      kind: 'ask',
      allowed: false
    })

    const b2 = channel({ kind: 'other', text: 'use the staging site' })
    setSessionInputChannel('uib-4b', b2)
    await expect(requestUserInputFor('uib-4b', request('w'))).resolves.toEqual({
      kind: 'other',
      text: 'use the staging site'
    })
    expect(b).toHaveBeenCalledTimes(2)
    expect(b2).toHaveBeenCalledTimes(1)
  })
})
