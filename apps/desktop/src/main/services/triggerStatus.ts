/**
 * 触发源一览（设置 → 触发源页，实验）：今天只有内置 timer 一个实例。**不列谁会响应** —— 触发源与 bot 解绑
 * （用户 2026-10-24）：命不命中由各 bot 在事件到来时用自己的 `when` 决定，从条件反推「订阅者」靠不住；实际叫起了谁
 * 看触发日志（triggerLogService）。这里给的是触发源自身：开关、上一次触发的时刻与原始事件（就是 `when` 里的 `event`）。
 */
import type { TriggerSourceStatus } from '@shuvix/chat-protocol/triggerSources'
import { BUILTIN_TIMER_ID, builtinTimer, isBuiltinTimerEnabled } from './triggerTimer'

export function triggerSourcesStatus(): TriggerSourceStatus[] {
  const last = builtinTimer.lastFiredPayload
  return [
    {
      id: BUILTIN_TIMER_ID,
      kind: 'timer',
      builtin: true,
      enabled: isBuiltinTimerEnabled(),
      ...(last
        ? {
            lastFiredAt: last.firedAt,
            lastEvent: { ...last, trigger: 'timer.fired' } as unknown as Record<string, unknown>
          }
        : {})
    }
  ]
}
