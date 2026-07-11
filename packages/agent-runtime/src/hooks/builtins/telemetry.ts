/**
 * 内置 hook：会话遥测（SessionStart / Stop）—— 各端共享。
 *
 * 把会话起止事件写入注入的 logger，便于排查"哪个 session 跑了多久"。
 * 纯日志，不影响 agent 行为，不返回任何决策。
 */
import type { HookHandler, HookInput } from '@shuvix/chat-protocol/types/hook'
import type { RuntimeLogger } from '../../types'

export function makeSessionStart(logger: RuntimeLogger): HookHandler {
  return (input: HookInput): void => {
    logger.info(`session start ${input.session_id} cwd=${input.cwd}`)
  }
}

export function makeSessionStop(logger: RuntimeLogger): HookHandler {
  return (input: HookInput): void => {
    logger.info(`session stop ${input.session_id} reason=${input.reason ?? 'unknown'}`)
  }
}
