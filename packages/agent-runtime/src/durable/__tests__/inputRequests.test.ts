/**
 * 挂起询问的「中止后拒收」窗口 —— 从已删除的 harnessSession.test.ts 搬来的那一条（P1-01）。
 *
 * 关停链路是「abort() 等 run 跑完」+「宿主按当前绑定的运行时路由用户应答」。
 * 正在关停的运行时已不在绑定表里，此时若还接受新询问，那条挂起就再也没人应答 ——
 * 双方互等，会话卡死。所以中止之后到下一轮开始之前，一律当作已取消。
 */
import { describe, expect, it } from 'vitest'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { PendingInputRequests } from '../inputRequests'

function makeInputs(hasCapability = true): { inputs: PendingInputRequests; events: string[] } {
  const events: string[] = []
  const inputs = new PendingInputRequests('s1', {
    broadcast: (e) => events.push(e.type),
    hasUserInputCapability: () => hasCapability
  })
  return { inputs, events }
}

describe('PendingInputRequests', () => {
  it('中止后新到的询问直接判为已取消（否则关停与工具互等，会话永远停在「正在停止」）', async () => {
    const { inputs, events } = makeInputs()
    const ask = (id: string): Promise<InputResponse> =>
      inputs.request({ id, kind: 'ask', toolName: 'bash', command: 'ls', createdAt: 0 })

    // 中止前：正常挂起，等用户应答
    let settled: InputResponse | undefined
    void ask('r1').then((r) => (settled = r))
    await Promise.resolve()
    expect(settled).toBeUndefined()
    expect(inputs.count).toBe(1)
    expect(inputs.summaries).toEqual(['bash: ls'])

    inputs.cancelAll()
    await Promise.resolve()
    expect(settled).toEqual({ kind: 'cancel', reason: 'aborted' })
    expect(inputs.count).toBe(0)
    expect(events).toEqual(['input_request', 'input_request_resolved'])

    // 中止后新到的询问：立刻取消，不再挂起
    await expect(ask('r2')).resolves.toEqual({ kind: 'cancel', reason: 'aborted' })

    // 下一轮开始后恢复受理
    inputs.reopen()
    let afterReopen: InputResponse | undefined
    void ask('r3').then((r) => (afterReopen = r))
    await Promise.resolve()
    expect(afterReopen).toBeUndefined()
    expect(inputs.respond('r3', { kind: 'cancel', reason: 'aborted' })).toBe(true)
    expect(inputs.respond('r3', { kind: 'cancel', reason: 'aborted' })).toBe(false)
  })

  it('没有前端能展示询问面板 → 立即取消，不挂起也不广播', async () => {
    const { inputs, events } = makeInputs(false)
    await expect(
      inputs.request({ id: 'r1', kind: 'ask', toolName: 'bash', command: 'ls', createdAt: 0 })
    ).resolves.toEqual({ kind: 'cancel', reason: 'aborted' })
    expect(inputs.count).toBe(0)
    expect(events).toEqual([])
  })
})
