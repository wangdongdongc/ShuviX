/**
 * 触发源一览（设置 → 触发源页，实验）：今天只有内置 timer 一个实例。订阅者是 bot md 里绑定了它的那些
 * `shuvix-bot-on`（按埋点 id 认 —— timer 类触发源的事件都是 `timer.fired`）。
 */
import { getTriggerPoint } from '@shuvix/agent-runtime'
import type { TriggerSourceStatus } from '@shuvix/chat-protocol/triggerSources'
import { botService } from './botService'
import { BUILTIN_TIMER_ID, builtinTimer, isBuiltinTimerEnabled } from './triggerTimer'

export function triggerSourcesStatus(): TriggerSourceStatus[] {
  const subscribers: TriggerSourceStatus['subscribers'] = []
  for (const entry of botService.listAll()) {
    for (const binding of entry.file.bindings ?? []) {
      if (binding.trigger !== 'timer.fired' || !getTriggerPoint(binding.trigger)) continue
      subscribers.push({
        bot: entry.file.name,
        displayName: entry.file.displayName,
        ...(binding.when ? { when: binding.when } : {})
      })
    }
  }
  const last = builtinTimer.lastFiredPayload
  return [
    {
      id: BUILTIN_TIMER_ID,
      kind: 'timer',
      builtin: true,
      enabled: isBuiltinTimerEnabled(),
      ...(last ? { lastFiredAt: last.firedAt } : {}),
      subscribers
    }
  ]
}
