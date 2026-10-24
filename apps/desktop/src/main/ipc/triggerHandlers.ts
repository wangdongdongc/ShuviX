import { defineHandler } from './registry'
import { triggerSourcesStatus } from '../services/triggerStatus'

/**
 * 触发源 IPC（实验）—— 设置 → 触发源页只读这一份：有哪些触发源、开没开、上一次什么时候触发、哪些 bot 订阅了它。
 * 开关本身是设置项（`triggers.timer.enabled`），经 settings:set 写。
 */
export function registerTriggerHandlers(): void {
  defineHandler('trigger:status', () => triggerSourcesStatus())
}
