/**
 * 跨进程 / 跨端的 Hook 类型 —— 单一真源。
 *
 * 消费方：
 * - renderer 设置页（展示 builtin/用户 hook 列表与加载状态）
 * - desktop `HookService`（builtin + command 双层）
 * - `@shuvix/agent-runtime` 的 `HookEngine`（各端共享的 builtin 引擎）
 *
 * 完整协议（子进程 stdin/stdout JSON、环境变量、配置文件路径）见
 * desktop [src/main/services/hooks/types.ts](../../../../apps/desktop/src/main/services/hooks/types.ts)。
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

/**
 * 传给 hook 的 JSON 负载。所有事件共用基础字段，事件特定字段按需出现。
 */
export interface HookInput {
  /** 会话 ID（全局唯一） */
  session_id: string
  /** 触发事件名 */
  hook_event_name: HookEvent
  /** 当前工作目录（绝对路径） */
  cwd: string

  // ── PreToolUse / PostToolUse ────────────────────────────────────────
  /** 工具名（PreToolUse / PostToolUse） */
  tool_name?: string
  /** 工具入参，schema 取决于具体工具（PreToolUse / PostToolUse） */
  tool_input?: unknown
  /** 工具结果（仅 PostToolUse） */
  tool_output?: unknown
  /** 工具是否报错（仅 PostToolUse） */
  is_error?: boolean

  // ── UserPromptSubmit ─────────────────────────────────────────────────
  /** 用户输入文本 */
  prompt?: string

  // ── Stop ─────────────────────────────────────────────────────────────
  /** 停止原因（user / timeout / error 等） */
  reason?: string
}

/**
 * Hook 返回值。所有字段均为可选，未返回视为「通过」。
 */
export interface HookOutput {
  /** 设为 false 可（在 Stop 等场景）取消默认后续行为 */
  continue?: boolean
  /**
   * 追加到上下文。
   * - SessionStart    → 作为附加 system 消息注入
   * - UserPromptSubmit → 追加到本次 user 消息之后
   * - PreToolUse      → 注入到工具结果之前
   * 超过 10000 字会被截断。
   */
  additionalContext?: string
  /** 事件特定决策 */
  hookSpecificOutput?: {
    /**
     * 仅 PreToolUse。
     * - `'allow'` 显式放行（少用，等价于不返回）
     * - `'deny'`  阻断；`reason` 回流给模型
     * - `'ask'`   降级到用户审批界面
     */
    permissionDecision?: 'allow' | 'deny' | 'ask'
    /** 仅 PreToolUse。返回新的 tool_input，替换原参数 */
    updatedInput?: unknown
    /** 决策原因（回流给模型或写入日志） */
    reason?: string
  }
}

/** 内置 hook 的处理函数签名。 */
export type HookHandler = (input: HookInput) => Promise<HookOutput | void> | HookOutput | void

/** 内置 hook 的入口。由 `HookEngine.registerBuiltin()` 注册（内存函数，各端共享）。 */
export interface BuiltinHookEntry {
  type: 'builtin'
  /** 用于日志/UI 显示的名称（kebab-case） */
  name: string
  /**
   * i18n key（在 renderer 的 settings namespace 下，由前端 t() 翻译为人类可读用途说明）。
   * 例如 'settings.hooksBuiltinPathSafety'。
   */
  descriptionKey?: string
  /** 同步或异步处理函数 */
  handler: HookHandler
  /** 超时秒，默认 5。内置 hook 超时按 fail-closed（直接 deny）处理。 */
  timeout?: number
}

/**
 * 触发一个 hook 事件的能力接口 —— RuntimeSession 依赖此抽象而非具体实现：
 * - 扩展注入 `HookEngine`（仅 builtin）
 * - 桌面注入 `HookService`（builtin + global/project command 双层）
 */
export interface HookFirer {
  fire(event: HookEvent, input: HookInput): Promise<HookOutput[]>
}
