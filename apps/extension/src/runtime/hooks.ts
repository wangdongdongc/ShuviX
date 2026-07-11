/**
 * 扩展端内置 hook 引擎（各端共享的 HookEngine）。
 *
 * 与桌面同源：桌面用完整 HookService（builtin + command）；扩展只用裸引擎（仅 builtin，
 * 无子进程/文件监听）。首版注册可移植的 bash-audit + session-telemetry：
 * - bash-audit：为将来的 WASM bash 工具预挂危险命令拦截（当前无 bash 工具 → 不命中）
 * - session-telemetry：SessionStart / Stop 日志
 *
 * path-safety 依赖真实文件系统黑名单（/etc、~/.ssh…），对 OPFS/FSA 虚拟沙箱无意义，首版不注册。
 */
import { HookEngine, makeBashAudit, makeSessionStart, makeSessionStop } from '@shuvix/agent-runtime'
import type { RuntimeLogger } from '@shuvix/agent-runtime'

const logger: RuntimeLogger = {
  info: (m) => console.info('[shuvix:hook]', m),
  warn: (m) => console.warn('[shuvix:hook]', m),
  error: (m) => console.error('[shuvix:hook]', m)
}

/** 各会话共享的内置 hook 引擎单例（注册无状态，与桌面 hookService 单例对齐） */
export const hookEngine = new HookEngine(logger)

hookEngine.registerBuiltin('PreToolUse', 'bash', {
  name: 'bash-audit',
  descriptionKey: 'settings.hooksBuiltinBashAudit',
  handler: makeBashAudit(logger)
})
hookEngine.registerBuiltin('SessionStart', '*', {
  name: 'session-telemetry-start',
  descriptionKey: 'settings.hooksBuiltinSessionStart',
  handler: makeSessionStart(logger)
})
hookEngine.registerBuiltin('Stop', '*', {
  name: 'session-telemetry-stop',
  descriptionKey: 'settings.hooksBuiltinSessionStop',
  handler: makeSessionStop(logger)
})
