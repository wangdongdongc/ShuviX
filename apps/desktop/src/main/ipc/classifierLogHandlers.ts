import { defineHandler } from './registry'
import { classifierLogService } from '../services/classifierLogService'
import type { ClassifierLogListParams } from '../types'

/**
 * 分类器调用日志 IPC —— 列表、详情、出现过的场景、清空（设置「监控 → 分类器」）
 */
export function registerClassifierLogHandlers(): void {
  defineHandler('classifierLog:list', (_ctx, params?: ClassifierLogListParams) =>
    classifierLogService.list(params)
  )
  defineHandler('classifierLog:get', (_ctx, id: string) => classifierLogService.getById(id))
  defineHandler('classifierLog:scenes', () => classifierLogService.scenes())
  defineHandler('classifierLog:clear', () => {
    classifierLogService.clear()
    return { success: true }
  })
}
