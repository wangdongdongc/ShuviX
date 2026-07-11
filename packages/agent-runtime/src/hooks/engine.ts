/**
 * HookEngine —— 各端共享的「内置 hook」引擎。
 *
 * 只负责 `type: 'builtin'`（内存函数）hook 的注册、匹配、串行执行与 fail-closed 超时。
 * 不含 `type: 'command'`（子进程）与文件监听 —— 那属于桌面专属，见 desktop `HookService`，
 * 后者组合本引擎并在其后追加 global/project command 层。
 *
 * 实现 {@link HookFirer}：RuntimeSession 直接依赖此接口触发生命周期 hook。
 */
import type {
  BuiltinHookEntry,
  HookEvent,
  HookFirer,
  HookInput,
  HookOutput,
  ResolvedHook
} from '@shuvix/chat-protocol/types/hook'
import type { RuntimeLogger } from '../types'
import { matchHook } from './matcher'

const noopLogger: RuntimeLogger = { info: () => {}, warn: () => {}, error: () => {} }

/** 默认超时（秒）：内置 hook 应当很快返回 */
const BUILTIN_DEFAULT_TIMEOUT_SEC = 5

interface BuiltinRegistration {
  event: HookEvent
  matcher: string
  entry: BuiltinHookEntry
}

export class HookEngine implements HookFirer {
  private builtins: BuiltinRegistration[] = []
  private readonly logger: RuntimeLogger

  constructor(logger?: RuntimeLogger) {
    this.logger = logger ?? noopLogger
  }

  /** 注册内置 hook。应在启动序列、任何 fire 之前调用。 */
  registerBuiltin(event: HookEvent, matcher: string, entry: Omit<BuiltinHookEntry, 'type'>): void {
    this.builtins.push({ event, matcher, entry: { type: 'builtin', ...entry } })
    this.logger.info(`已注册内置 hook: ${event} ${matcher} → ${entry.name}`)
  }

  /** 是否注册过任何内置 hook（宿主可据此跳过 fire 开销） */
  hasBuiltins(): boolean {
    return this.builtins.length > 0
  }

  /**
   * 触发一个事件，按注册顺序串行执行所有匹配的内置 hook。
   * 任一返回 `permissionDecision: 'deny'` 立即短路，后续不执行。
   */
  async fire(event: HookEvent, input: HookInput): Promise<HookOutput[]> {
    const outputs: HookOutput[] = []
    const target = input.tool_name ?? ''
    for (const b of this.builtins) {
      if (b.event !== event) continue
      if (!matchHook(b.matcher, target, this.logger)) continue
      const out = await this.invokeBuiltin(b.entry, input)
      if (out) outputs.push(out)
      if (out?.hookSpecificOutput?.permissionDecision === 'deny') return outputs
    }
    return outputs
  }

  /** 列出内置 hook（供设置页只读展示） */
  listBuiltins(): ResolvedHook[] {
    return this.builtins.map((b) => ({
      event: b.event,
      matcher: b.matcher || '*',
      source: 'builtin' as const,
      description: b.entry.name,
      descriptionKey: b.entry.descriptionKey,
      timeout: b.entry.timeout ?? BUILTIN_DEFAULT_TIMEOUT_SEC
    }))
  }

  private async invokeBuiltin(
    entry: BuiltinHookEntry,
    input: HookInput
  ): Promise<HookOutput | undefined> {
    const timeoutMs = (entry.timeout ?? BUILTIN_DEFAULT_TIMEOUT_SEC) * 1000
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        Promise.resolve(entry.handler(input)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`builtin hook timeout: ${entry.name}`)),
            timeoutMs
          )
        })
      ])
      return result || undefined
    } catch (err) {
      this.logger.error(
        `内置 hook 异常 ${entry.name}: ${err instanceof Error ? err.message : String(err)}`
      )
      // fail-closed: 内置 hook 出错按拒绝处理
      return {
        hookSpecificOutput: {
          permissionDecision: 'deny',
          reason: `internal hook ${entry.name} error: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
