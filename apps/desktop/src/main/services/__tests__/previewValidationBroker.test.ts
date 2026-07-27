/**
 * previewValidationBroker 单测 —— AppEvent 发布 / IPC 回执对号入座 / 超时诚实降级 /
 * 多回执先到先得。appEventBus 是纯 JS 总线（chat-protocol createAppEventBus），可直测。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
import { appEventBus } from '../../utils/appEventBus'
import { validateChartViaRenderer, reportChartValidation } from '../previewValidationBroker'

afterEach(() => {
  vi.useRealTimers()
})

function captureValidateEvent(): {
  events: Array<Extract<AppEvent, { type: 'preview.validateChart' }>>
  unsub: () => void
} {
  const events: Array<Extract<AppEvent, { type: 'preview.validateChart' }>> = []
  const unsub = appEventBus.subscribe((e) => {
    if (e.type === 'preview.validateChart') events.push(e)
  })
  return { events, unsub }
}

describe('previewValidationBroker', () => {
  it('发布 validateChart 事件并按回执解析', async () => {
    const { events, unsub } = captureValidateEvent()
    const promise = validateChartViaRenderer({ sessionId: 's1', absPath: '/ws/a-graph.md' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ sessionId: 's1', absPath: '/ws/a-graph.md' })

    const first = reportChartValidation({
      validationId: events[0].validationId,
      ok: false,
      error: 'Parse error'
    })
    expect(first).toEqual({ accepted: true })
    await expect(promise).resolves.toEqual({ ok: false, error: 'Parse error', verified: true })

    // 同一 id 的后到回执（多窗口）不再被接受
    const second = reportChartValidation({ validationId: events[0].validationId, ok: true })
    expect(second).toEqual({ accepted: false })
    unsub()
  })

  it('未知 validationId 回执 → accepted:false', () => {
    expect(reportChartValidation({ validationId: 'nope', ok: true })).toEqual({ accepted: false })
  })

  it('超时无应答 → 按未验证成功降级', async () => {
    vi.useFakeTimers()
    const { events, unsub } = captureValidateEvent()
    const promise = validateChartViaRenderer({ sessionId: 's1', absPath: '/ws/a-graph.md' })
    await vi.advanceTimersByTimeAsync(4100)
    await expect(promise).resolves.toEqual({ ok: true, verified: false })
    // 超时后 pending 已清理，迟到回执被拒
    expect(reportChartValidation({ validationId: events[0].validationId, ok: false })).toEqual({
      accepted: false
    })
    unsub()
  })
})
