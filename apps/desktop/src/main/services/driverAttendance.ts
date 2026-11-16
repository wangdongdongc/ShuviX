/**
 * 别的会话发进来的消息跟发送方那一轮的状态（docs/unattended-run-design.md §4）：无人值守的运行开出来 / 发进去的
 * 那一轮也是无人值守。
 *
 * 单独成文件、不带任何依赖：盖章的两处（agentSession 的被驱动发送、网关的被驱动插话）与登记查询的 sessionService
 * 互相不能 import，而且有二十多份单测把 agentSession 整个替身掉 —— 放在这里它们都不用动。
 */
import type { DrivingSessionRef } from '@shuvix/chat-protocol/types/inputRequest'

/** 发送方那一轮此刻是不是无人值守（sessionService 登记）。没登记 = 一律有人值守 */
let driverUnattended: (sessionId: string) => boolean = () => false

export function setDriverAttendanceLookup(lookup: (sessionId: string) => boolean): void {
  driverUnattended = lookup
}

/** 来源章盖上发送方那一轮的状态（有人值守时原样交回，不多一个键） */
export function withDriverAttendance(source: DrivingSessionRef): DrivingSessionRef {
  let unattended = false
  try {
    unattended = driverUnattended(source.sessionId)
  } catch {
    unattended = false
  }
  if (unattended) return { ...source, unattended: true }
  if (source.unattended === undefined) return source
  // 发送方此刻有人在：带进来的旧标记不算数
  const { unattended: _stale, ...attended } = source
  return attended
}
