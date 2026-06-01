/**
 * 内置 hook：会话遥测（SessionStart / Stop）
 *
 * 把会话起止事件写入 electron-log，便于排查"哪个 session 跑了多久"。
 * 纯日志，不影响 agent 行为，不返回任何决策。
 */

import { createLogger } from '../../../logger'
import type { HookHandler, HookInput } from '../types'

const log = createLogger('Builtin:telemetry')

export const sessionStartHandler: HookHandler = (input: HookInput): void => {
  log.info(`session start ${input.session_id} cwd=${input.cwd}`)
}

export const sessionStopHandler: HookHandler = (input: HookInput): void => {
  log.info(`session stop ${input.session_id} reason=${input.reason ?? 'unknown'}`)
}
