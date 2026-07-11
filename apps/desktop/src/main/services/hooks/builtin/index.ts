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
 *
 * handler 实现（bash-audit / session-telemetry / path-safety）均来自 @shuvix/agent-runtime
 * 的共享工厂，与 Chrome 扩展同源。桌面为 path-safety 注入 Node `os`/`path` 与真实黑名单；
 * bash-audit / telemetry 注入 electron-log。
 */

import { homedir, platform } from 'os'
import { resolve, sep } from 'path'
import {
  makeBashAudit,
  makeSessionStart,
  makeSessionStop,
  makePathSafety
} from '@shuvix/agent-runtime'
import { createLogger } from '../../../logger'
import type { HookService } from '../index'

export function registerAllBuiltins(service: HookService): void {
  service.registerBuiltin('PreToolUse', 'edit|write', {
    name: 'path-safety',
    descriptionKey: 'settings.hooksBuiltinPathSafety',
    handler: makePathSafety({
      homedir: homedir(),
      platform: platform(),
      resolve,
      sep,
      env: process.env
    })
  })
  service.registerBuiltin('PreToolUse', 'bash', {
    name: 'bash-audit',
    descriptionKey: 'settings.hooksBuiltinBashAudit',
    handler: makeBashAudit(createLogger('Builtin:bashAudit'))
  })
  const telemetryLog = createLogger('Builtin:telemetry')
  service.registerBuiltin('SessionStart', '*', {
    name: 'session-telemetry-start',
    descriptionKey: 'settings.hooksBuiltinSessionStart',
    handler: makeSessionStart(telemetryLog)
  })
  service.registerBuiltin('Stop', '*', {
    name: 'session-telemetry-stop',
    descriptionKey: 'settings.hooksBuiltinSessionStop',
    handler: makeSessionStop(telemetryLog)
  })
}
