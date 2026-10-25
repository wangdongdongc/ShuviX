/**
 * 触发日志（实验）—— 触发源与 bot 解绑之后（用户 2026-10-24），用户靠它看见「哪个事件叫起了哪个 bot」：bot 触发
 * 分发（botTriggerService）在一条绑定的 `when` 命中的那一刻记一条 —— 开出了运行会话（started，跑完改成 completed /
 * failed）、或因为上一次还没跑完而跳过（skipped）；绑定的条件求值出错也记（condition-error，同一个错误只记一次，
 * 节流在分发侧）。每条带命中时的原始事件，设置 → 触发源 一页按时间倒序列出。
 *
 * 表是 trigger_logs（迁移 v35），只留最新的 MAX_ROWS 条。写日志失败只记一条告警，绝不影响触发本身；每次变动
 * 广播 `trigger.logged`，设置页据此刷新。
 */
import { v7 as uuidv7 } from 'uuid'
import type { TriggerLogEntry, TriggerLogOutcome } from '@shuvix/chat-protocol/triggerSources'
import { triggerLogDao } from '../dao/triggerLogDao'
import { appEventBus } from '../utils/appEventBus'
import { createLogger } from '../logger'

const log = createLogger('TriggerLog')

/** 只留最新的这么多条（用户 2026-10-24 定的；不按天数清） */
export const MAX_ROWS = 1000

/** 设置页一次取的条数 */
export const LIST_LIMIT = 100

/** 每写这么多条修剪一次（不必每条都扫一遍表） */
const PRUNE_EVERY = 50

export type TriggerLogInput = Omit<TriggerLogEntry, 'id' | 'createdAt' | 'updatedAt'>

class TriggerLogService {
  private sinceLastPrune = 0

  /** 记一条，交回它的 id（写失败交回 null —— 调用方照常继续） */
  record(input: TriggerLogInput): string | null {
    const now = Date.now()
    const id = uuidv7()
    try {
      triggerLogDao.insert({ ...input, id, createdAt: now, updatedAt: now })
    } catch (err) {
      log.warn(`写触发日志失败：${err instanceof Error ? err.message : String(err)}`)
      return null
    }
    // 修剪失败不连累已经写进去的这一条：照样交回 id、照样广播（否则它会一直停在 started）
    if (++this.sinceLastPrune >= PRUNE_EVERY) {
      this.sinceLastPrune = 0
      try {
        triggerLogDao.prune(MAX_ROWS)
      } catch (err) {
        log.warn(`修剪触发日志失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    appEventBus.publish({ type: 'trigger.logged' })
    return id
  }

  /** 一条运行结束：改成 completed / failed */
  finish(id: string | null, outcome: TriggerLogOutcome, error?: string): void {
    if (!id) return
    try {
      triggerLogDao.updateOutcome(id, {
        outcome,
        ...(error ? { error } : {}),
        updatedAt: Date.now()
      })
      appEventBus.publish({ type: 'trigger.logged' })
    } catch (err) {
      log.warn(`更新触发日志失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  list(limit: number = LIST_LIMIT): TriggerLogEntry[] {
    // 入参来自 IPC：取整、非有限数按缺省（SQLite 的 LIMIT 不收 2.5 / NaN）
    const n = Number.isFinite(limit) ? Math.floor(limit) : LIST_LIMIT
    return triggerLogDao.list(Math.max(1, Math.min(n, MAX_ROWS)))
  }

  clear(): void {
    triggerLogDao.clear()
    appEventBus.publish({ type: 'trigger.logged' })
  }
}

export const triggerLogService = new TriggerLogService()
