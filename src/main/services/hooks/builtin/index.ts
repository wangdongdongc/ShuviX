/**
 * 内置 hook 注册入口
 *
 * 在 ShuviX 启动序列里、用户配置加载**之前**调用：
 *   import { hookService } from './services/hooks'
 *   import { registerAllBuiltins } from './services/hooks/builtin'
 *   registerAllBuiltins(hookService)
 *   hookService.start()
 *
 * 内置 hook 默认对用户 UI 不可见，且优先于全局 / 项目 hook 执行 ——
 * 保证安全策略不会被用户自定义 hook 偷偷绕过。
 */

import type { HookService } from '../index'
import { pathSafetyHandler } from './pathSafety'
import { bashAuditHandler } from './bashAudit'
import { sessionStartHandler, sessionStopHandler } from './sessionTelemetry'

export function registerAllBuiltins(service: HookService): void {
  service.registerBuiltin('PreToolUse', 'edit|write', {
    name: 'path-safety',
    descriptionKey: 'settings.hooksBuiltinPathSafety',
    handler: pathSafetyHandler
  })
  service.registerBuiltin('PreToolUse', 'bash', {
    name: 'bash-audit',
    descriptionKey: 'settings.hooksBuiltinBashAudit',
    handler: bashAuditHandler
  })
  service.registerBuiltin('SessionStart', '*', {
    name: 'session-telemetry-start',
    descriptionKey: 'settings.hooksBuiltinSessionStart',
    handler: sessionStartHandler
  })
  service.registerBuiltin('Stop', '*', {
    name: 'session-telemetry-stop',
    descriptionKey: 'settings.hooksBuiltinSessionStop',
    handler: sessionStopHandler
  })
}
