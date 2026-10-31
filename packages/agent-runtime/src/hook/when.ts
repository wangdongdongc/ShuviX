/**
 * 触发绑定的 CEL `when` 过滤 —— 与 security 模块同一 CEL 引擎（@marcbachmann/cel-js）、
 * 同一 strict 语义，但独立的求值环境：这里没有 inDir/hasShortFlags 之类的策略函数，
 * 上下文是 `{event, env}`（触发信封 / 宿主环境）。hook 与 bot 的绑定共用这一份。
 *
 * **宿主函数**（`setWhenHostFunctions`）：要查宿主数据的条件做成函数而不是 env 上的属性 —— 函数只在表达式
 * 真的求值到它时才调用（`&&` / `||` / `?:` 从左到右短路），没走到就不查；属性要么每次都先算好，要么得靠
 * getter，而 getter 会在任何展开 / 拷贝 env 的地方被提前触发。函数的签名在这里登记（语法校验与求值都认得它），
 * 实现由宿主注入：没注入的宿主上调用它 = 求值错误（按「不命中 + 告警」处置）。
 *  - `activeSessions(date)`：本机本地日 `YYYY-MM-DD` 那天有人写过消息的会话数（桌面：日历的按日索引）。
 *
 * 时机与错误处置对齐 celMatch：
 *  - 语法校验在 hook 文件解析时（compileWhen）：语法错 → 整份文件非法；
 *  - 求值在 fire 匹配时（evaluateWhen）：求值错误（含访问 payload 缺失属性）与非布尔结果
 *    throw，由 runner fail-safe 处置为「不命中 + 告警」—— 触发宁可漏掉一次，绝不误发一个 run。
 */
import { Environment } from '@marcbachmann/cel-js'

/** 宿主给 `when` 的函数（日历数据在桌面主进程，agent-runtime 不直接依赖它） */
export interface WhenHostFunctions {
  /** 本机本地日（`YYYY-MM-DD`）那天有人写过消息的会话数 */
  activeSessions(date: string): number
}

let hostFunctions: Partial<WhenHostFunctions> = {}

/** 宿主启动时注入（桌面 main）；再次调用整体替换 */
export function setWhenHostFunctions(functions: Partial<WhenHostFunctions>): void {
  hostFunctions = functions
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const env = new Environment({ unlistedVariablesAreDyn: true }).registerFunction(
  'activeSessions(string): int',
  (date: string): bigint => {
    const impl = hostFunctions.activeSessions
    if (!impl) throw new Error('activeSessions() is not available on this host')
    if (!DATE_RE.test(date)) {
      throw new Error(`activeSessions() expects a local date like '2026-10-24', got '${date}'`)
    }
    return BigInt(impl(date))
  }
)
const cache = new Map<string, (context: Record<string, unknown>) => unknown>()

function program(expression: string): (context: Record<string, unknown>) => unknown {
  let compiled = cache.get(expression)
  if (!compiled) {
    compiled = env.parse(expression)
    cache.set(expression, compiled)
  }
  return compiled
}

/** 语法校验（解析期）。返回 null = 合法；字符串 = 错误消息（整份文件判非法） */
export function compileWhen(expression: string): string | null {
  try {
    env.parse(expression)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/**
 * 求值 `when`。要求严格布尔；错误/非布尔向上抛，由 runner 按「不命中 + 告警」兜底。
 *
 * `functions` 只给这一次求值换掉宿主函数（排期预演要假设「那天有会话」，不能动全局那份 —— 真的触发源还在用它）。
 * 求值是同步的，换上与换回之间不会插进别的求值
 */
export function evaluateWhen(
  expression: string,
  context: Record<string, unknown>,
  functions?: Partial<WhenHostFunctions>
): boolean {
  const saved = hostFunctions
  if (functions) hostFunctions = { ...hostFunctions, ...functions }
  let result: unknown
  try {
    result = program(expression)(context)
  } finally {
    hostFunctions = saved
  }
  if (typeof result !== 'boolean') {
    throw new Error(`when expression must evaluate to a boolean, got ${typeof result}`)
  }
  return result
}
