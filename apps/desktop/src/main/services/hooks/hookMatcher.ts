/**
 * Hook matcher —— 实现已上移到 @shuvix/agent-runtime（各端共享）。
 * 此处包一层注入 electron-log 的 logger，保持 main 进程内既有 import 路径与无效正则告警行为不变。
 * 语义见 {@link HookGroup.matcher}。
 */
import { matchHook as matchHookCore } from '@shuvix/agent-runtime'
import { createLogger } from '../../logger'

const log = createLogger('HookMatcher')

export function matchHook(matcher: string | undefined, target: string): boolean {
  return matchHookCore(matcher, target, log)
}
