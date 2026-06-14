/**
 * @fileoverview ShuviX Hook 协议定义 —— 用户面向 schema 的权威说明
 *
 * Hook 让用户在 ShuviX 智能体的生命周期关键节点上注入子进程脚本，
 * 实现审计、安全约束、上下文注入等扩展行为。协议与 Claude Code 兼容
 * （配置路径独立，见下方）。
 *
 * ## 触发模型
 *
 * Hook 由 `HookService.fire(event, input)` 触发。每个事件按
 * `builtin → global → project` 顺序串行执行所有匹配的 hook，
 * 任一返回 `permissionDecision: 'deny'` 立即短路，后续 hook 不执行。
 *
 * ## 子进程协议（type: 'command'）
 *
 *   - stdin：一段 JSON（{@link HookInput}）
 *   - stdout：可选 JSON（{@link HookOutput}）
 *   - 退出码：
 *     - `0`     → 正常；stdout 解析为决策
 *     - `2`     → 阻断；stderr 文本回流给模型作为错误
 *     - 其他    → 非阻塞警告，写入 logger，不影响 agent
 *   - 默认 timeout：30 秒
 *
 * ## 环境变量
 *
 *   - `SHUVIX_PROJECT_DIR`  当前项目根目录
 *   - `CLAUDE_PROJECT_DIR`  上面的别名，方便复用 Claude Code 风格脚本
 *   - `SHUVIX_SESSION_ID`   当前会话 ID
 *   - `SHUVIX_EVENT_NAME`   触发事件名（等同 `HookInput.hook_event_name`）
 *
 * ## 配置文件路径
 *
 *   - 全局：`~/.shuvix/hooks.json`
 *   - 项目：`<projectPath>/.shuvix/hooks.json`
 *
 * 两份配置按事件「追加合并」，项目级在全局之后执行。
 *
 * ## 内置 hook（type: 'builtin'）
 *
 * ShuviX 自身通过 {@link HookService.registerBuiltin} 注册的内存函数。
 * 不出现在配置文件中、默认对用户不可见，且优先于用户 hook 执行——
 * 用于强制路径白名单、危险命令审计等系统级策略。
 *
 * @example
 * ```json
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "bash",
 *       "hooks": [
 *         { "type": "command", "command": "./audit.sh", "timeout": 10 }
 *       ]
 *     }]
 *   }
 * }
 * ```
 */

/**
 * 跨进程公共类型（HookEvent / HookSource / HookFileStatus / ResolvedHook）
 * 实际定义在 [src/shared/types/hook.ts](@shuvix/chat-protocol/types/hook.ts)，
 * 这里 re-export 出来，便于 main 进程统一从本文件 import。
 *
 * 各事件的触发时机：
 * - **SessionStart**：`AgentSession.create()` 完成后立即触发；用于注入项目级动态上下文。
 *   不支持阻断（会话已创建不可逆）。@see [agentSession.ts](../agentSession.ts) AgentSession.create
 * - **UserPromptSubmit**：每次 `AgentSession.prompt()` 入口、把 user 消息送给模型之前触发。
 *   返回 `additionalContext` 追加到 user 消息之后；exit 2 / `permissionDecision: 'deny'` 丢弃此次 prompt。
 *   @see [agentSession.ts](../agentSession.ts) AgentSession.prompt
 * - **PreToolUse**：工具实际 `execute()` 之前触发。`permissionDecision: 'deny'` 阻断；
 *   `updatedInput` 改写工具参数；`additionalContext` 注入到工具结果之前。
 *   matcher 匹配工具名（小写：`bash` / `edit` / `write` / `read` / `ls` / `glob` / `grep` / `ssh` / `ask` / `database`）。
 *   @see [wrapToolOutput.ts](../wrapToolOutput.ts)
 * - **PostToolUse**：工具 `execute()` 返回后、结果回传给模型之前触发。仅观察，不支持阻断。
 *   @see [wrapToolOutput.ts](../wrapToolOutput.ts)
 * - **Stop**：用户主动停止或 session 销毁时触发。异步通知用途。
 *   @see [agentSession.ts](../agentSession.ts) AgentSession.abort
 */
import type {
  HookEvent,
  HookSource,
  HookFileStatus,
  ResolvedHook
} from '@shuvix/chat-protocol/types/hook'
export type { HookEvent, HookSource, HookFileStatus, ResolvedHook }

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

/**
 * 配置文件中的单个 hook 入口。MVP 仅支持 `type: 'command'`（子进程）。
 * 未来扩展：`http` / `mcp_tool` / `prompt` / `agent`。
 */
export interface HookEntry {
  type: 'command'
  /** 要执行的 shell 命令。可用 `${SHUVIX_PROJECT_DIR}` 等占位符。 */
  command: string
  /** 单次执行超时（秒），默认 30。超时按 fail-open 处理（不阻断 agent）。 */
  timeout?: number
}

/**
 * 一组共享同一 matcher 的 hook。
 */
export interface HookGroup {
  /**
   * 匹配器语义：
   * - `"*"` / `""` / 省略 → 全部匹配
   * - 仅 `[A-Za-z0-9_|]`  → 按 `|` 拆分的精确串列表
   * - 其他               → JS 正则
   *
   * PreToolUse / PostToolUse 匹配工具名；其它事件 matcher 通常用 `"*"`。
   */
  matcher?: string
  /** 此 matcher 下所有 hook，按数组顺序执行 */
  hooks: HookEntry[]
}

/** 整份 hooks.json 顶层 schema。 */
export interface HookConfigFile {
  hooks?: Partial<Record<HookEvent, HookGroup[]>>
}

/** 内置 hook 的处理函数签名。 */
export type HookHandler = (input: HookInput) => Promise<HookOutput | void> | HookOutput | void

/** 内置 hook 的入口。由 `HookService.registerBuiltin()` 注册。 */
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
