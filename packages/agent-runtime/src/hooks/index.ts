/**
 * 各端共享的内置 hook 引擎与可移植 builtins。
 *
 * - `HookEngine`：注册 + 执行 `type:'builtin'` hook（实现 HookFirer）
 * - `matchHook`：matcher 语义
 * - builtins：bash-audit / session-telemetry（可移植）+ path-safety（工厂，注入路径环境）
 *
 * 桌面 `HookService` 组合本引擎并追加 command 层；扩展直接用裸引擎。
 */
export { HookEngine } from './engine'
export { matchHook } from './matcher'
export { makeBashAudit, findDangerousPattern } from './builtins/bashAudit'
export { makeSessionStart, makeSessionStop } from './builtins/telemetry'
export { makePathSafety, type PathSafetyEnv } from './builtins/pathSafety'
