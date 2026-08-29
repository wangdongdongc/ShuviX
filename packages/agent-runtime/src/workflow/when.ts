/**
 * 触发绑定的 CEL `when` 过滤 —— 与 security 模块同一 CEL 引擎（@marcbachmann/cel-js）、
 * 同一 strict 语义，但独立的求值环境：这里没有 inDir/hasShortFlags 之类的策略函数，
 * 上下文是 `{event, vars, env}`（触发信封 / 工作流常量表 / 宿主环境）。
 *
 * 时机与错误处置对齐 celMatch：
 *  - 语法校验在工作流文件解析时（compileWhen）：语法错 → 整份文件非法；
 *  - 求值在 fire 匹配时（evaluateWhen）：求值错误（含访问 payload 缺失属性）与非布尔结果
 *    throw，由引擎 fail-safe 处置为「不命中 + 告警」—— 触发宁可漏掉一次，绝不误发一个 run。
 */
import { Environment } from '@marcbachmann/cel-js'

const env = new Environment({ unlistedVariablesAreDyn: true })
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

/** 求值 `when`。要求严格布尔；错误/非布尔向上抛，由引擎按「不命中 + 告警」兜底 */
export function evaluateWhen(expression: string, context: Record<string, unknown>): boolean {
  const result = program(expression)(context)
  if (typeof result !== 'boolean') {
    throw new Error(`when expression must evaluate to a boolean, got ${typeof result}`)
  }
  return result
}
