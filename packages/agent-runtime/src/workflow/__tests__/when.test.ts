/**
 * 触发绑定的 CEL `when` —— compile（解析期语法门）与 evaluate（fire 期 strict 求值）的
 * 契约钉板。strict 语义是触发模型的安全阀：访问 payload 缺失属性、非布尔结果都必须
 * **向上抛**，由引擎兜成「不命中 + 告警」—— 宁漏一次触发，绝不误发一个 run。
 */
import { describe, expect, it } from 'vitest'
import { compileWhen, evaluateWhen } from '../when'

describe('compileWhen — 解析期语法门', () => {
  it('合法表达式 → null', () => {
    expect(compileWhen('event.isDefaultTitle')).toBeNull()
    expect(compileWhen("event.turnCount == 2 && env.host == 'desktop'")).toBeNull()
  })

  it('语法错 → 返回错误消息字符串（整份文件据此判非法）', () => {
    const err = compileWhen('event.')
    expect(typeof err).toBe('string')
    expect(err!.length).toBeGreaterThan(0)
  })
})

describe('evaluateWhen — strict 求值', () => {
  it('布尔结果原样返回（true / false 各一）', () => {
    expect(evaluateWhen('event.flag', { event: { flag: true } })).toBe(true)
    expect(evaluateWhen('event.flag', { event: { flag: false } })).toBe(false)
  })

  it.each([
    ['数值', '1 + 1'],
    ['字符串', "'x'"]
  ])('非布尔结果（%s）→ throw must evaluate to a boolean', (_label, expr) => {
    expect(() => evaluateWhen(expr, { event: {} })).toThrow('must evaluate to a boolean')
  })

  it('strict 语义：访问 payload 缺失属性（event.nope，event={}）→ throw', () => {
    expect(() => evaluateWhen('event.nope', { event: {} })).toThrow()
  })

  it('上下文三件套可达：vars 与 env 参与判定', () => {
    expect(
      evaluateWhen("vars.a == 1 && env.host == 'desktop'", {
        event: {},
        vars: { a: 1 },
        env: { host: 'desktop', platform: 'darwin' }
      })
    ).toBe(true)
  })

  it('CEL 吸收语义：false && event.nope → false 不抛（短路侧已定结果）', () => {
    expect(evaluateWhen('false && event.nope', { event: {} })).toBe(false)
  })

  it('同一表达式重复求值结果稳定（缓存不冻结上下文）', () => {
    const expr = 'vars.a == 1'
    expect(evaluateWhen(expr, { vars: { a: 1 } })).toBe(true)
    expect(evaluateWhen(expr, { vars: { a: 2 } })).toBe(false)
    expect(evaluateWhen(expr, { vars: { a: 1 } })).toBe(true)
  })
})
