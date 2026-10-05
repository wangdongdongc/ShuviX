/**
 * 会话运行时在 DB 里的两份镜像（经 sessionRecords：持久会话落表，内存会话在内存里）：
 *
 *  - `settings.agentLocked`：这条会话此刻有没有 agent。权威是会话存储里的锁记录（裁决 Q7），这一份只为
 *    会话没打开时便宜地回答「锁着没有」（模型 / 扩展能力的写入口、界面的只读态）。SessionHost 的
 *    onLockChange 写（创建 / 销毁 / 每次打开都对账），清空会话时归 false。
 *  - `settings.runState`：会话存储的运行状态（idle / busy / interrupted）。SessionHost 的 onRunStateChange 写，
 *    每次打开都对账；退出时正忙的会话不改（留着 busy，下次打开报 interrupted）。
 *
 * 单独一个文件、只依赖 sessionRecords：sessionService / messageService / sessionHost 都要读写它，
 * 而 sessionHost 的依赖图很重。
 */
import type { SessionRunState, SessionSettings } from '../dao/types'
import { sessionRecords } from './sessionRecords'

/**
 * 写锁镜像 / 运行标记。值没变不写（PIN-06：每次写都会 bump `updatedAt`），也不发会话配置变更广播；
 * 行不在了（会话刚被删）什么都不做 —— 不会把一行删掉的会话写回来。
 * `agentLocked` 缺键视同 false；`runState` 缺键视同「没写过」（第一次总会写）。
 */
export function writeSessionMirror(
  sessionId: string,
  patch: { agentLocked?: boolean; runState?: SessionRunState }
): void {
  const current = sessionRecords.pickSettings(sessionId, ['agentLocked', 'runState'])
  if (!current) return
  const changes: SessionSettings = {}
  if (patch.agentLocked !== undefined && (current.agentLocked ?? false) !== patch.agentLocked) {
    changes.agentLocked = patch.agentLocked
  }
  if (patch.runState !== undefined && current.runState !== patch.runState) {
    changes.runState = patch.runState
  }
  if (Object.keys(changes).length === 0) return
  sessionRecords.updateSettings(sessionId, changes)
}

/** 锁镜像此刻怎么说（会话没打开时「有没有 agent」的便宜答案） */
export function mirroredAgentLocked(sessionId: string): boolean {
  return sessionRecords.pickSettings(sessionId, ['agentLocked'])?.agentLocked === true
}
