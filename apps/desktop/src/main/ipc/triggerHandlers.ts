import { defineHandler } from './registry'
import { triggerSourcesStatus } from '../services/triggerStatus'
import { triggerLogService } from '../services/triggerLogService'

/**
 * 触发源 IPC（实验）—— 设置 → 触发源页：有哪些触发源、开没开、上一次什么时候触发与原始事件；外加触发日志（哪个事件
 * 叫起了哪个 bot）的列表与清空。开关本身是设置项（`triggers.timer.enabled`），经 settings:set 写。
 */
export function registerTriggerHandlers(): void {
  defineHandler('trigger:status', () => triggerSourcesStatus())
  defineHandler('trigger:logs', (_ctx, params?: { limit?: number }) =>
    triggerLogService.list(typeof params?.limit === 'number' ? params.limit : undefined)
  )
  defineHandler('trigger:clearLogs', () => {
    triggerLogService.clear()
    return { success: true }
  })
}
