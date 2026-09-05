/**
 * `md prompt=<name>` 块的占位符渲染（renderPromptTemplate）—— 纯函数、恒不抛。
 *
 * 语法刻意只有 `{{path}}` 与 `{{>name}}` 两条。前几组钉占位符的四个口径：
 *  - **什么算「有值」**（`0` / `false` / `{}` 都算，空串/空数组/null/解析不出不算）；
 *  - **空值怎么收敛**（该行除占位符外只有空白 → 整行消失；否则行内留一个空洞）；
 *  - **形状不像路径的 `{{…}}` 原样保留**（同 agent md 对未知占位符的处置）；
 *  - **怪值只渲染成空、绝不抛**（宿主塞进 extras 的窗口是「一个数组，元素是宿主给的
 *    对象」，循环引用是它的日常，而 prompt() 抛 = 整个 run 失败）。
 * 最后一组钉块引用：被引用块「占位符全空 → 整块消失」与顶层字面恒保留的不对称、
 * 同作用域、记号计数不上浮，以及引用不存在 / 成环时的恒不抛兜底（promptIncludes 的
 * 匹配面一并钉住）。
 */
import { describe, expect, it } from 'vitest'
import { promptIncludes, renderPromptTemplate } from '../promptTemplate'

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

/**
 * `{{>name}}` 块引用 —— 「有内容才出现的一段」直接住在 md 里，脚本不再为每个可选小节预拼
 * 「要么整段要么空串」的字符串。这组要钉的是被引用块与顶层模板的**不对称**：顶层的字面
 * 文字恒保留，被引用块的占位符全空则整块（连标题、连块内的说明句）消失；引用在引用者那里
 * 只算一枚记号，按它渲染出来的空/非空计，内层的记号计数不上浮。引用不存在 / 成环在解析期
 * 已整份拒绝（workflowFile.test.ts），这里只钉纯函数「恒不抛」的兜底。
 */
describe('块引用 {{>name}}', () => {
  it('PT-1 静态块（无记号）被引用恒出现，引用文本首尾 trim 后代入', () => {
    expect(renderPromptTemplate('A\n{{>b}}\nC', scopeOf({}), { b: '\n\n## H\nstatic\n\n' })).toBe(
      'A\n## H\nstatic\nC'
    )
  })

  it('PT-2 被引用块占位符全空 → 整块消失：标题与块内的字面说明句一起走，引用行不留空洞', () => {
    // 易漏：块里有文字 ≠ 有内容 —— 规则只看记号
    const blocks = { b: '## Others\n{{session.others}}\nThese bots see it too.' }
    expect(renderPromptTemplate('A\n{{>b}}\nC', scopeOf({ session: { others: [] } }), blocks)).toBe(
      'A\nC'
    )
  })

  it('PT-3 任一占位符非空 → 整块出现，块内其余空占位符行各自消失', () => {
    expect(renderPromptTemplate('{{>b}}', scopeOf({ a: 'x' }), { b: '## H\n{{a}}\n{{b}}' })).toBe(
      '## H\nx'
    )
  })

  it('PT-4 同作用域：message.text / input.* / vars.* / event.* 在引用块内可达，extras 遮蔽 input 同名键同样生效', () => {
    const scope = scopeOf(
      { message: { text: 'hi' }, window: 'FROM-INPUT' },
      { vars: { k: 'K' }, event: { trigger: 'call' }, extras: { window: 'FROM-EXTRAS' } }
    )
    const blocks = {
      b: [
        'msg={{message.text}}',
        'via={{input.message.text}}',
        'var={{vars.k}}',
        'trig={{event.trigger}}',
        'win={{window}}'
      ].join('\n')
    }
    expect(renderPromptTemplate('{{>b}}', scope, blocks)).toBe(
      'msg=hi\nvia=hi\nvar=K\ntrig=call\nwin=FROM-EXTRAS'
    )
  })

  it('PT-5 三层嵌套穿透，空值逐层向上传播；顶层字面保留而被引用块整体消失（不对称）', () => {
    const blocks = { c: '## C\n{{v}}', b: '## B\n{{>c}}', a: '# Top\n{{>b}}' }
    // v 有值：三层全出现
    expect(renderPromptTemplate('# Top\n{{>b}}', scopeOf({ v: 'val' }), blocks)).toBe(
      '# Top\n## B\n## C\nval'
    )
    // v 缺：c 空 → b 的唯一记号空 → b 空 → 顶层只剩自己的字面
    expect(renderPromptTemplate('# Top\n{{>b}}', scopeOf({}), blocks)).toBe('# Top')
    // 同一段文字作为被引用块 a：整块消失（'# Top' 也跟着走）
    expect(renderPromptTemplate('X\n{{>a}}\nY', scopeOf({}), blocks)).toBe('X\nY')
  })

  it('PT-6 引用块内只有引用：静态 b 透出；空块 b（解析器允许 ""）视作空，向上传播到每一层引用者', () => {
    expect(renderPromptTemplate('{{>a}}', scopeOf({}), { a: '{{>b}}', b: 'B-static' })).toBe(
      'B-static'
    )
    const blocks = { a: '{{>b}}', b: '', c: '## C\n{{>a}}' }
    expect(renderPromptTemplate(blocks.a, scopeOf({}), blocks)).toBe('')
    expect(renderPromptTemplate('{{>a}}', scopeOf({}), blocks)).toBe('')
    expect(renderPromptTemplate('X\n{{>c}}\nY', scopeOf({}), blocks)).toBe('X\nY')
  })

  it('PT-7 记号计数不上浮：引用者只多一枚记号，按引用结果的空/非空计', () => {
    // A 两枚记号（引用 + missing）：引用非空 → 1/2 非空 → A 出现
    expect(
      renderPromptTemplate('{{>A}}', scopeOf({}), { A: '{{>B}}\n{{missing}}', B: 'B-static' })
    ).toBe('B-static')
    // A 的唯一记号是一枚渲染成空的引用 → A 整块消失
    expect(
      renderPromptTemplate('X\n{{>A}}\nY', scopeOf({}), { A: '{{>B}}', B: '{{missing}}' })
    ).toBe('X\nY')
    // 对照：B 静态（零记号）时 A 的那枚引用记号非空 → A 连同自己的字面一起出现
    expect(
      renderPromptTemplate('X\n{{>A}}\nY', scopeOf({}), { A: 'Label\n{{>B}}', B: 'B-static' })
    ).toBe('X\nLabel\nB-static\nY')
  })

  it('PT-8 【钉现状】同行混排与占位符同口径：行内有其他文字则整行保留（含尾随空格），一空一非空亦保留', () => {
    const blocks = { b: '{{missing}}' }
    expect(renderPromptTemplate('Intro: {{>b}}\ntail', scopeOf({}), blocks)).toBe('Intro: \ntail')
    // 行尾空格只在整串末尾才被顶层 trim 吃掉
    expect(renderPromptTemplate('Intro: {{>b}}', scopeOf({}), blocks)).toBe('Intro:')
    expect(renderPromptTemplate('head\n{{>b}} {{name}}', scopeOf({ name: 'Ana' }), blocks)).toBe(
      'head\n Ana'
    )
  })

  it('PT-9 恒不抛兜底：引用不存在的块 / blocks 未传 / 引用块内再引用不存在的块 → 渲染成空、该行消失，其余照常', () => {
    expect(() => renderPromptTemplate('A\n{{>nope}}\nB', scopeOf({}), {})).not.toThrow()
    expect(renderPromptTemplate('A\n{{>nope}}\nB', scopeOf({}), {})).toBe('A\nB')
    expect(() => renderPromptTemplate('A\n{{>nope}}\nB', scopeOf({}))).not.toThrow()
    expect(renderPromptTemplate('A\n{{>nope}}\nB', scopeOf({}))).toBe('A\nB')

    const blocks = { a: '## A\n{{name}}\n{{>nope}}' }
    expect(() =>
      renderPromptTemplate('X\n{{>a}}\nY', scopeOf({ name: 'Ana' }), blocks)
    ).not.toThrow()
    expect(renderPromptTemplate('X\n{{>a}}\nY', scopeOf({ name: 'Ana' }), blocks)).toBe(
      'X\n## A\nAna\nY'
    )
  })

  it('PT-10 成环兜底：互引 / 自引不抛、不死循环（解析器已拒绝成环，展开层数不钉死）', () => {
    const mutual = { a: 'A\n{{>b}}', b: 'B\n{{>a}}' }
    expect(() => renderPromptTemplate(mutual.a, scopeOf({}), mutual)).not.toThrow()
    // a 作顶层：字面 'A' 保留；b 的唯一记号回指 a、被栈截断为空 → b 整块消失
    expect(renderPromptTemplate(mutual.a, scopeOf({}), mutual)).toBe('A')

    const self = { a: 'A\n{{>a}}' }
    let out: unknown
    expect(() => {
      out = renderPromptTemplate('{{>a}}', scopeOf({}), self)
    }).not.toThrow()
    expect(typeof out).toBe('string')
  })

  it('PT-11 promptIncludes：去重、按出现序、容忍空白、名字含 -；{{c}} 不算；坏形状不匹配且渲染时原样保留', () => {
    const template = [
      '{{>a}}',
      '{{ > b }}',
      '{{>a}}',
      '{{c}}',
      '{{>x-y_z}}',
      '{{>bad name}}',
      '{{>a.b}}'
    ].join('\n')
    expect(promptIncludes(template)).toEqual(['a', 'b', 'x-y_z'])
    expect(renderPromptTemplate('{{>bad name}}\n{{>a.b}}', scopeOf({}), {})).toBe(
      '{{>bad name}}\n{{>a.b}}'
    )
  })

  it('PT-12 bot-chat 式布局的收尾：引用行消失后 3+ 空行收敛成一个空行；数组值在引用块内按行铺开', () => {
    const blocks = {
      others: '## Others\n{{others}}',
      window: '## Recent conversation\n\n{{window}}'
    }
    expect(
      renderPromptTemplate(
        'Head\n\n{{>others}}\n\n{{>window}}\n\nTail',
        scopeOf({ others: [], window: ['l1', 'l2'] }),
        blocks
      )
    ).toBe('Head\n\n## Recent conversation\n\nl1\nl2\n\nTail')
  })
})
