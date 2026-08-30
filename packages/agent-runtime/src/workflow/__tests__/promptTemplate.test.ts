/**
 * `md prompt=<name>` 块的占位符渲染（renderPromptTemplate）—— 纯函数、恒不抛。
 *
 * 语法刻意只有 `{{path}}` 一条，所以这张表要钉死的其实是四个口径：
 *  - **什么算「有值」**（`0` / `false` / `{}` 都算，空串/空数组/null/解析不出不算）；
 *  - **空值怎么收敛**（该行除占位符外只有空白 → 整行消失；否则行内留一个空洞）；
 *  - **形状不像路径的 `{{…}}` 原样保留**（同 agent md 对未知占位符的处置）；
 *  - **怪值只渲染成空、绝不抛**（宿主塞进 extras 的窗口是「一个数组，元素是宿主给的
 *    对象」，循环引用是它的日常，而 prompt() 抛 = 整个 run 失败）。
 */
import { describe, expect, it } from 'vitest'
import { renderPromptTemplate } from '../promptTemplate'

/** 引擎侧 `prompt(name, extras)` 组装作用域的同一顺序（见 engine.ts 的 api.prompt） */
const scopeOf = (
  input: Record<string, unknown>,
  extra: { vars?: unknown; event?: unknown; extras?: Record<string, unknown> } = {}
): Record<string, unknown> => ({
  ...input,
  input,
  vars: extra.vars ?? {},
  event: extra.event ?? {},
  ...(extra.extras ?? {})
})

describe('标量与路径', () => {
  it('string / number / boolean 直接代入；0 与 false 不算空（整行不得消失）', () => {
    expect(renderPromptTemplate('{{name}}', scopeOf({ name: 'Ana' }))).toBe('Ana')
    expect(renderPromptTemplate('n={{n}} flag={{flag}}', scopeOf({ n: 0, flag: false }))).toBe(
      'n=0 flag=false'
    )
  })

  it('点分路径与顶层平铺等价；vars / event 同样可达', () => {
    const scope = scopeOf(
      { message: { text: 'hi' } },
      { vars: { a: 1 }, event: { trigger: 'call' } }
    )
    expect(renderPromptTemplate('{{message.text}}', scope)).toBe('hi')
    expect(renderPromptTemplate('{{input.message.text}}', scope)).toBe('hi')
    expect(renderPromptTemplate('{{vars.a}}', scope)).toBe('1')
    expect(renderPromptTemplate('{{event.trigger}}', scope)).toBe('call')
  })

  it('路径中间段不是对象 → 解析不出（→ 整行消失）', () => {
    // name 是字符串，`name.length` 不该穿透到 JS 的内建属性上
    expect(renderPromptTemplate('a\n{{name.length}}\nb', scopeOf({ name: 'Ana' }))).toBe('a\nb')
  })
})

describe('数组与对象值', () => {
  it('数组逐项 String 后按行拼，空项丢弃', () => {
    expect(renderPromptTemplate('{{list}}', scopeOf({ list: ['a', '', 'b'] }))).toBe('a\nb')
  })

  it('数组里的对象项走 JSON（窗口切片由调用方给，模板只负责铺开）', () => {
    expect(renderPromptTemplate('{{w}}', scopeOf({ w: [{ k: 1 }, 'x'] }))).toBe('{"k":1}\nx')
  })

  it('非数组对象值 → JSON 串', () => {
    expect(renderPromptTemplate('{{obj}}', scopeOf({ obj: { k: 1 } }))).toBe('{"k":1}')
  })
})

describe('空值收敛', () => {
  it('整行消失：该行除占位符外只有空白', () => {
    expect(renderPromptTemplate('a\n{{missing}}\nb', scopeOf({}))).toBe('a\nb')
    expect(renderPromptTemplate('  {{missing}}  ', scopeOf({}))).toBe('')
  })

  it('【钉现状】整行保留：行内有其他非空文本 —— 只有整串首尾被 trim，行内尾随空格留着', () => {
    expect(renderPromptTemplate('Prefix: {{missing}}\ntail', scopeOf({}))).toBe('Prefix: \ntail')
  })

  it('一行两个占位符、一空一非空 → 整行保留（allEmpty 是与语义）', () => {
    expect(renderPromptTemplate('{{empty}}{{name}}', scopeOf({ empty: '', name: 'Ana' }))).toBe(
      'Ana'
    )
  })

  it.each([
    ['空串', { v: '' }, true],
    ['空数组', { v: [] }, true],
    ['全空项数组', { v: ['', null, undefined] }, true],
    ['null', { v: null }, true],
    ['undefined', { v: undefined }, true],
    ['路径解析不出', {}, true],
    // `{}` 序列化成 "{}" —— 非空字符串，故不触发整行消失（钉现状）
    ['空对象 {}', { v: {} }, false]
  ])('空值口径：%s → 算空 = %s', (_label, input, isEmpty) => {
    const out = renderPromptTemplate('a\n{{v}}\nb', scopeOf(input as Record<string, unknown>))
    expect(out).toBe(isEmpty ? 'a\nb' : 'a\n{}\nb')
  })
})

describe('未知形状与收尾规则', () => {
  it.each(['{{not a path}}', '{{ }}', '{{list.0}}', '{{a-b}}'])(
    '形状不像路径的 %s 原样保留（同 agent md 对未知占位符的处置）',
    (literal) => {
      const out = renderPromptTemplate(`head\n${literal}\ntail`, scopeOf({ list: ['x'], a: 1 }))
      expect(out).toContain(literal)
    }
  )

  it('3 行以上连续换行收敛成一个空行；首尾空行 trim', () => {
    expect(renderPromptTemplate('\n\nx\n\n\n\ny\n\n', scopeOf({}))).toBe('x\n\ny')
  })

  it('无占位符的模板逐字保留（仅做换行收敛/trim）', () => {
    const text = ['# Title', '', 'Body with `code` and *emphasis*.', '', '- item'].join('\n')
    expect(renderPromptTemplate(text, scopeOf({}))).toBe(text)
  })

  it('作用域是一张平表：同名键后者为准 —— 这正是 prompt() 把 extras 放在最后的原因', () => {
    const scope = scopeOf(
      { window: 'FROM-INPUT' },
      { vars: { a: 1 }, extras: { window: 'FROM-EXTRAS', vars: { a: 2 } } }
    )
    expect(renderPromptTemplate('{{window}} {{vars.a}}', scope)).toBe('FROM-EXTRAS 2')
  })
})

describe('恒不抛：作用域里的怪值只渲染成空', () => {
  const circular = (): Record<string, unknown> => {
    const o: Record<string, unknown> = { k: 1 }
    o.self = o
    return o
  }

  it.each([
    ['循环引用对象', () => circular()],
    // 宿主的窗口就是「一个数组，元素是宿主给的对象」—— 带父指针的消息对象是它的日常
    ['数组里的循环引用对象', () => [circular()]],
    ['数组里混着循环引用与正常项', () => ['keep', circular()]]
  ])('%s → 不可序列化的部分落为空（不抛）', (_label, make) => {
    const scope = scopeOf({ v: make() })
    expect(() => renderPromptTemplate('a\n{{v}}\nb', scope)).not.toThrow()
    expect(renderPromptTemplate('a\n{{v}}\nb', scope)).toMatch(/^a\n(keep\n)?b$/)
  })

  it.each([
    ['裸 Symbol', () => Symbol('s')],
    ['数组里的 Symbol', () => [Symbol('s')]]
  ])('【钉现状】%s → String(sym) 的文本（String 对 symbol 不抛，模板字面量才抛）', (_l, make) => {
    expect(renderPromptTemplate('{{v}}', scopeOf({ v: make() }))).toBe('Symbol(s)')
  })
})
