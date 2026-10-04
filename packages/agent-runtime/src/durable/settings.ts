/**
 * ShuviX 的 pi-durable 运行策略（`HarnessSettings`）—— 每个 Harness 一份。
 *
 * durable 在**每次使用时**现读 settings、从不拷贝（且部分读取发生在 Session 串行线上，必须同步），
 * 所以这里全部是同步 getter：上下文窗口一变（P1-09 锁定模型之后），下一次判定就用新值。
 *
 * 与 durable 默认值不同的几项都是有意写死的（测试拿 durable 的 DEFAULT_* 对照，证明是显式选择）：
 *  - retry：最多 10 次（durable 默认 3）。基础退避不写 —— 用 durable 的 2s 指数退避。
 *  - stream：单次请求 10 分钟超时；SDK 内重试 0 次（重试统一由 durable 的持久化重试负责，
 *    两层叠加会把一次失败放大成十几次请求）。
 *  - compaction：reserve = background = min(32768, ⌊窗口/4⌋)，keepRecent 20000（裁决 Q2）。
 *    durable 默认 reserve 16384 / background 32768 —— 对小窗口模型等于一开局就要压缩。
 *    窗口未知（未锁定 / 0 / 负数 / NaN / ∞ / 读取抛错）一律按 32768。
 *  - steering / followUp：'all' —— 队列在输入框里对用户可见，看到几条就该一起走。
 */
import type {
  CompactionPolicy,
  ConversationRetryPolicy,
  ConversationStreamOptions,
  Extension,
  HarnessSettings,
  QueueMode,
  ToolExecutionMode
} from '@earendil-works/pi-durable'

/** 持久化重试（durable 的 attempt 重试；`baseDelayMs` 不写 = durable 默认 2000） */
export const SHUVIX_RETRY_POLICY: Readonly<Partial<ConversationRetryPolicy>> = Object.freeze({
  enabled: true,
  maxRetries: 10
})

/** 单次请求选项：10 分钟超时，SDK 内不重试 */
export const SHUVIX_STREAM_OPTIONS: Readonly<ConversationStreamOptions> = Object.freeze({
  timeoutMs: 600_000,
  maxRetries: 0
})

/** 压缩后原样保留的近期上下文（约数） */
export const SHUVIX_KEEP_RECENT_TOKENS = 20_000

/** reserve / background 的上限，也是窗口未知时的取值 */
export const SHUVIX_MAX_RESERVE_TOKENS = 32_768

/**
 * 压缩余量：`min(32768, ⌊contextWindow / 4⌋)`；窗口不是有限正数时按 32768。
 * 结果 0（窗口 < 4）在 durable 里意味着关闭后台压缩，这是有意保留的边界行为。
 */
export function compactionReserveTokens(contextWindow: number | undefined): number {
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return SHUVIX_MAX_RESERVE_TOKENS
  }
  return Math.min(SHUVIX_MAX_RESERVE_TOKENS, Math.floor(contextWindow / 4))
}

/** 逐段覆盖（测试与调试用）：给出的字段盖在 ShuviX 默认值之上，没给的保持不变 */
export interface ShuviXSettingsOverrides {
  readonly stream?: ConversationStreamOptions
  readonly retry?: Partial<ConversationRetryPolicy>
  readonly compaction?: Partial<CompactionPolicy>
  readonly toolExecution?: ToolExecutionMode
  readonly steeringMode?: QueueMode
  readonly followUpMode?: QueueMode
  readonly extensions?: readonly Extension[]
}

export interface ShuviXSettingsOptions {
  /**
   * 该 Harness 根会话锁定模型的上下文窗口；同步读取，未知 / 未锁定返回 undefined。
   * 每次读取 `compaction` 都会现调一次（抛错按未知处理）。
   */
  readonly contextWindow?: () => number | undefined
  /** 逐段覆盖；每次读取时现读，改了下一次判定就生效 */
  readonly overrides?: ShuviXSettingsOverrides | (() => ShuviXSettingsOverrides | undefined)
}

/** 构造一个 Harness 的 settings（同步 getter；不缓存、不拷贝 durable 会再合并的默认值） */
export function createShuviXSettings(options: ShuviXSettingsOptions = {}): HarnessSettings {
  const overrides = (): ShuviXSettingsOverrides => {
    const source = options.overrides
    return (typeof source === 'function' ? source() : source) ?? {}
  }
  const contextWindow = (): number | undefined => {
    try {
      return options.contextWindow?.()
    } catch {
      return undefined
    }
  }
  return {
    get extensions() {
      return overrides().extensions
    },
    get stream() {
      return { ...SHUVIX_STREAM_OPTIONS, ...overrides().stream }
    },
    get retry() {
      return { ...SHUVIX_RETRY_POLICY, ...overrides().retry }
    },
    get compaction() {
      const reserve = compactionReserveTokens(contextWindow())
      return {
        keepRecentTokens: SHUVIX_KEEP_RECENT_TOKENS,
        reserveTokens: reserve,
        backgroundTokens: reserve,
        ...overrides().compaction
      }
    },
    get toolExecution() {
      return overrides().toolExecution
    },
    get steeringMode() {
      return overrides().steeringMode ?? 'all'
    },
    get followUpMode() {
      return overrides().followUpMode ?? 'all'
    }
  }
}
