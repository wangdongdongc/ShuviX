/**
 * 跨进程的 Hook 类型 —— renderer 设置页和 main HookService 共享。
 *
 * 完整协议（包括子进程 stdin/stdout JSON、环境变量、配置文件路径）
 * 见 [src/main/services/hooks/types.ts](src/main/services/hooks/types.ts)。
 */

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop'

export type HookSource = 'builtin' | 'global' | 'project'

/** 单份 hooks.json 的加载状态 —— UI 用来显示绿/黄/红条 */
export type HookFileStatus =
  | { ok: true; count: number }
  | { ok: false; kind: 'parse' | 'schema'; message: string; errors?: string[] }

/** HookService.list() 返回项 —— UI 列表展示 */
export interface ResolvedHook {
  event: HookEvent
  matcher: string
  source: HookSource
  /** command 字符串（user hook）或 builtin name */
  description: string
  /** i18n key（仅 builtin 提供），渲染端用 t() 翻译为人类可读说明 */
  descriptionKey?: string
  timeout: number
}
