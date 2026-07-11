/**
 * Hook matcher —— 各端共享（从桌面 hookMatcher.ts 抽取，去 electron-log 依赖）。
 *
 * 语义（见 chat-protocol HookGroup.matcher）：
 * - `"*"` / `""` / undefined → 全部匹配
 * - 仅 `[A-Za-z0-9_|]`        → 按 `|` 拆分成精确串列表
 * - 其他                      → JS 正则
 */
import type { RuntimeLogger } from '../types'

const SIMPLE_RE = /^[A-Za-z0-9_|]+$/

export function matchHook(
  matcher: string | undefined,
  target: string,
  logger?: RuntimeLogger
): boolean {
  if (matcher == null || matcher === '' || matcher === '*') return true
  if (SIMPLE_RE.test(matcher)) {
    return matcher.split('|').some((m) => m === target)
  }
  try {
    return new RegExp(matcher).test(target)
  } catch (err) {
    logger?.warn(
      `无效正则 matcher "${matcher}": ${err instanceof Error ? err.message : String(err)}`
    )
    return false
  }
}
