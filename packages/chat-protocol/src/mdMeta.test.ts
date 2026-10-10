/**
 * md 扩展元数据的契约层（mdMeta.ts）—— 设计见 docs/md-metadata-design.md。
 *
 * 钉四件事：
 *   - 常量与内置 id 的构造（字面量钉住：两边都引常量就什么都钉不住）；
 *   - parseObjectId 的接受 / 拒绝表（UUID 任意版本、归一为小写；内置形态 `<kind>:builtin:<name>`
 *     原样、大小写敏感；不是字符串 / 空 / 形似而非 → null）；
 *   - isJsonValue：`md_attrs.value` 能原样存回的值（YAML core 解析树里 JSON 表达得了的部分）；
 *   - setShuvixIdLine：**只改一行文本**的 frontmatter 写入 —— 落点、换行符、BOM、续行、引号、
 *     返回 null 的场合、幂等与逐字节保真。
 *
 *   MM-1…3    常量与 builtinObjectId
 *   MM-4…10   parseObjectId 接受
 *   MM-11…14  parseObjectId 拒绝
 *   MM-15…16  形态不串、normalizeObjectId
 *   MM-17…21  isJsonValue
 *   MM-22…27  setShuvixIdLine 落点
 *   MM-28…33  frontmatter 形状与 null
 *   MM-34…44  已有条目的替换、续行、标记块标量
 *   MM-45…47  值的引号规则
 *   MM-48…49  幂等与保真
 */
import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  MD_ATTR_NAMESPACES,
  MD_OBJECT_KINDS,
  SHUVIX_ID_KEY,
  builtinObjectId,
  isJsonValue,
  normalizeObjectId,
  parseObjectId,
  setShuvixIdLine,
  type MdObjectKind
} from './mdMeta'

/** 形状合法的 UUIDv7（variant 9） */
const U = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
/** 另一个合法 UUID（替换用） */
const V = '0199d3a2-0000-7000-8000-000000000000'

const KINDS: MdObjectKind[] = ['agent', 'bot', 'hook', 'policy']

/**
 * 本地的 frontmatter 读取：与解析侧同一条正则（剥掉 BOM / 前导空白之后），交给真 YAML 解析。
 * chat-protocol 的测试够不到 agent-runtime 的 splitFrontmatter，于是照抄它的两步
 */
function frontmatter(text: string): Record<string, unknown> {
  const m = /^---\r?\n((?:[\s\S]*?\r?\n)??)---[ \t]*(?:\r?\n|$)/.exec(text.replace(/^\s+/, ''))
  expect(m, `没有 frontmatter：${JSON.stringify(text)}`).not.toBeNull()
  return (parseYaml(m![1]) ?? {}) as Record<string, unknown>
}

/** setShuvixIdLine 断言非 null 后的结果 */
function stamp(text: string, id = U): string {
  const out = setShuvixIdLine(text, id)
  expect(out, `setShuvixIdLine 意外返回 null：${JSON.stringify(text)}`).not.toBeNull()
  return out!
}

describe('MM-1…3 常量与内置 id', () => {
  it('MM-1 常量钉成字面量：键名、四种对象类型、两个命名空间', () => {
    expect(SHUVIX_ID_KEY).toBe('shuvix-id')
    expect(MD_OBJECT_KINDS).toEqual(['agent', 'bot', 'hook', 'policy'])
    expect(MD_ATTR_NAMESPACES).toEqual(['fm', 'meta'])
  })

  it('MM-2 builtinObjectId = `<kind>:builtin:<name>`（四种类型逐一）', () => {
    expect(builtinObjectId('agent', 'explore')).toBe('agent:builtin:explore')
    expect(builtinObjectId('bot', 'scout')).toBe('bot:builtin:scout')
    expect(builtinObjectId('hook', 'auto-title')).toBe('hook:builtin:auto-title')
    expect(builtinObjectId('policy', 'ask-on-command')).toBe('policy:builtin:ask-on-command')
  })

  it.each(['explore', 'knowledge-writer', 'a:b', '代码审查', 'Explore'])(
    'MM-3 往返：parseObjectId(builtinObjectId(k, %j)) 认出同一 kind 与 name（第二个冒号之后整体是名字、大小写原样）',
    (name) => {
      for (const kind of KINDS) {
        const id = builtinObjectId(kind, name)
        expect(parseObjectId(id), `${kind} ${name}`).toEqual({ id, form: 'builtin', kind, name })
      }
    }
  )
})

describe('MM-4…10 parseObjectId —— 接受', () => {
  it('MM-4 小写 v7 → { id, form: uuid }', () => {
    expect(parseObjectId(U)).toEqual({ id: U, form: 'uuid' })
  })

  it('MM-5 大写 / 大小写混写的 UUID → id 归一为小写', () => {
    expect(parseObjectId(U.toUpperCase())).toEqual({ id: U, form: 'uuid' })
    expect(parseObjectId('0199D3A2-7b3e-7C4D-9a1f-2E5B8c7d6F10')).toEqual({ id: U, form: 'uuid' })
  })

  it('MM-6 任意版本都认：v4、nil、全 f（新建只写 v7，手写的照样认）', () => {
    const v4 = '550e8400-e29b-41d4-a716-446655440000'
    const nil = '00000000-0000-0000-0000-000000000000'
    const max = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
    expect(parseObjectId(v4)).toEqual({ id: v4, form: 'uuid' })
    expect(parseObjectId(nil)).toEqual({ id: nil, form: 'uuid' })
    expect(parseObjectId(max)).toEqual({ id: max, form: 'uuid' })
  })

  it('MM-7 首尾空白先剥（空格、制表符、行尾 \\n / \\r、NBSP），两种形态都一样', () => {
    for (const padded of [`  ${U}  `, `\t${U}`, `${U}\n`, `${U}\r`, `${U}\u00a0`]) {
      expect(parseObjectId(padded), JSON.stringify(padded)).toEqual({ id: U, form: 'uuid' })
    }
    for (const padded of [
      '  agent:builtin:explore  ',
      '\tagent:builtin:explore',
      'agent:builtin:explore\n',
      'agent:builtin:explore\r',
      'agent:builtin:explore\u00a0'
    ]) {
      expect(parseObjectId(padded), JSON.stringify(padded)).toEqual({
        id: 'agent:builtin:explore',
        form: 'builtin',
        kind: 'agent',
        name: 'explore'
      })
    }
  })

  it('MM-8 内置形态四种类型逐一；id 原样返回、大小写敏感（不归一）', () => {
    expect(parseObjectId('agent:builtin:explore')).toEqual({
      id: 'agent:builtin:explore',
      form: 'builtin',
      kind: 'agent',
      name: 'explore'
    })
    expect(parseObjectId('bot:builtin:scout')).toEqual({
      id: 'bot:builtin:scout',
      form: 'builtin',
      kind: 'bot',
      name: 'scout'
    })
    expect(parseObjectId('hook:builtin:auto-title')).toEqual({
      id: 'hook:builtin:auto-title',
      form: 'builtin',
      kind: 'hook',
      name: 'auto-title'
    })
    expect(parseObjectId('policy:builtin:ask-on-command')).toEqual({
      id: 'policy:builtin:ask-on-command',
      form: 'builtin',
      kind: 'policy',
      name: 'ask-on-command'
    })
    expect(parseObjectId('agent:builtin:Explore')).toEqual({
      id: 'agent:builtin:Explore',
      form: 'builtin',
      kind: 'agent',
      name: 'Explore'
    })
  })

  it('MM-9 名字中间可以有空格、#（只要求首尾非空白、不跨行）', () => {
    expect(parseObjectId('agent:builtin:a b')).toMatchObject({ form: 'builtin', name: 'a b' })
    expect(parseObjectId('agent:builtin:a#b')).toMatchObject({ form: 'builtin', name: 'a#b' })
  })

  it('MM-10 名字是否真有这个内置不在解析层判定', () => {
    expect(parseObjectId('agent:builtin:does-not-exist')).toEqual({
      id: 'agent:builtin:does-not-exist',
      form: 'builtin',
      kind: 'agent',
      name: 'does-not-exist'
    })
  })
})

describe('MM-11…14 parseObjectId —— 拒绝（null = 当作没有 id）', () => {
  it.each<[string, unknown]>([
    ['数字', 123],
    ['布尔', true],
    ['null', null],
    ['undefined', undefined],
    ['数组', ['a']],
    ['对象', {}],
    ['Date', new Date()]
  ])('MM-11 不是字符串：%s → null', (_label, value) => {
    expect(parseObjectId(value)).toBeNull()
  })

  it('MM-12 空串 / 纯空白 → null', () => {
    expect(parseObjectId('')).toBeNull()
    expect(parseObjectId('   ')).toBeNull()
  })

  it.each([
    ['32 位十六进制、没有连字符', U.replace(/-/g, '')],
    ['花括号包着', `{${U}}`],
    ['urn:uuid: 前缀', `urn:uuid:${U}`],
    ['最后一段混进 g', '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f1g'],
    ['7-4-4-4-12', '0199d3a-7b3e-7c4d-9a1f-2e5b8c7d6f10'],
    ['8-4-4-4-13', `${U}0`],
    ['后面还拖着一截', `${U}-x`]
  ])('MM-13 形似 UUID：%s → null', (_label, value) => {
    expect(parseObjectId(value)).toBeNull()
  })

  it.each([
    ['名字为空', 'agent:builtin:'],
    ['名字以空格起头', 'agent:builtin: x'],
    ['名字以制表符起头', 'agent:builtin:\tx'],
    ['名字跨行', 'agent:builtin:a\nb'],
    ['kind 大写', 'Agent:builtin:x'],
    ['builtin 大写', 'agent:Builtin:x'],
    ['kind 是 skill', 'skill:builtin:x'],
    ['kind 是 okf', 'okf:builtin:x'],
    ['kind 是 memory', 'memory:builtin:x'],
    ['少了 builtin 段', 'agent:explore'],
    ['builtin 段为空', 'agent::explore'],
    ['少了 kind 段', 'builtin:explore']
  ])('MM-14 形似内置 id：%s → null', (_label, value) => {
    expect(parseObjectId(value)).toBeNull()
  })
})

describe('MM-15…16 形态不串、normalizeObjectId', () => {
  it('MM-15 UUID 永远不是内置形态；名字恰好是 UUID 的内置 id 仍是内置形态，且不归一大小写', () => {
    const asUuid = parseObjectId(U)
    expect(asUuid?.form).toBe('uuid')
    expect(asUuid).not.toHaveProperty('kind')
    expect(asUuid).not.toHaveProperty('name')

    expect(parseObjectId(`agent:builtin:${U}`)).toEqual({
      id: `agent:builtin:${U}`,
      form: 'builtin',
      kind: 'agent',
      name: U
    })
    const upper = `agent:builtin:${U.toUpperCase()}`
    expect(parseObjectId(upper)).toEqual({
      id: upper,
      form: 'builtin',
      kind: 'agent',
      name: U.toUpperCase()
    })
  })

  it('MM-16 normalizeObjectId(v) === parseObjectId(v)?.id ?? null；对接受的值幂等', () => {
    const samples: unknown[] = [
      U,
      U.toUpperCase(),
      `  ${U}\n`,
      'agent:builtin:explore',
      ' hook:builtin:auto-title ',
      'agent:builtin:a b',
      'nope',
      '',
      123,
      null,
      undefined,
      ['a'],
      'agent:builtin:'
    ]
    for (const v of samples) {
      expect(normalizeObjectId(v), JSON.stringify(v)).toBe(parseObjectId(v)?.id ?? null)
      const once = normalizeObjectId(v)
      if (once !== null) expect(normalizeObjectId(once), JSON.stringify(v)).toBe(once)
    }
  })
})

describe('MM-17…21 isJsonValue —— 能原样存进 md_attrs.value 的值', () => {
  it('MM-17 null / 字符串 / 布尔 / 有限数字 / 数组 / 纯对象（含无原型对象、五层嵌套）→ true', () => {
    const bare = Object.create(null) as Record<string, unknown>
    bare.a = 1
    bare.b = [true, 'x']
    const deep = { a: { b: { c: { d: { e: [1, 'two', null, false] } } } } }
    const values: unknown[] = [null, '', 'x', true, false, 0, -1.5, 1e300, [], {}, bare, deep]
    values.forEach((v, i) => expect(isJsonValue(v), `#${i}`).toBe(true))
  })

  it('MM-18 真实 frontmatter 的 YAML 解析树（块标量、映射序列、像时间戳的字符串、锚点与别名）→ true，且 JSON 往返深相等', () => {
    const tree = parseYaml(
      [
        'name: x',
        'desc: |',
        '  line 1',
        '  line 2',
        'folded: >-',
        '  a',
        '  b',
        'list:',
        '  - a: 1',
        '    b: [x, y]',
        '  - c: null',
        'when: 2026-10-10',
        "time: '12:30'",
        'base: &b { k: v, n: [1, 2.5] }',
        'ref: *b',
        'flag: true',
        'empty:'
      ].join('\n')
    ) as Record<string, unknown>
    // 前提：YAML 1.2 core 不把日期读成 Date（读成了的话 isJsonValue 理应拒绝，这条就该红）
    expect(typeof tree.when).toBe('string')
    expect(isJsonValue(tree)).toBe(true)
    expect(JSON.parse(JSON.stringify(tree))).toEqual(tree)
  })

  it.each<[string, unknown]>([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['undefined', undefined],
    ['函数', () => 1],
    ['symbol', Symbol('x')],
    ['bigint', 10n],
    ['Date', new Date(0)],
    ['Map', new Map([['a', 1]])],
    ['Set', new Set([1])],
    ['RegExp', /re/],
    [
      '类实例',
      new (class Point {
        x = 1
      })()
    ],
    ['数组里有 NaN', [1, NaN]],
    ['对象值为 undefined', { a: undefined }],
    ['数组里有 undefined', [undefined]],
    ['深处有 Infinity', { a: { b: [Infinity] } }]
  ])('MM-19 JSON 表达不了：%s → false', (_label, value) => {
    expect(isJsonValue(value)).toBe(false)
  })

  it.each([
    ['.nan', 'v: .nan'],
    ['.inf', 'v: .inf'],
    ['-.inf', 'v: -.inf'],
    ['!!binary', 'v: !!binary aGVsbG8='],
    ['!!set', 'v: !!set {a, b}']
  ])('MM-20 YAML 解析得出、JSON 存不回去：%s → false', (_label, source) => {
    const value = (parseYaml(source) as { v: unknown }).v
    expect(isJsonValue(value)).toBe(false)
  })

  it('MM-21 -0 放过（存成 0，数值相等）；稀疏数组的洞拒绝', () => {
    expect(isJsonValue(-0)).toBe(true)
    // eslint-disable-next-line no-sparse-arrays
    expect(isJsonValue([1, , 3])).toBe(false)
    expect(isJsonValue(new Array(2))).toBe(false)
  })
})

describe('MM-22…27 setShuvixIdLine —— 落点', () => {
  it('MM-22 插在 shuvix 标记行之后；去掉这一行与输入逐字节相同', () => {
    const input = '---\nshuvix: agent v1\nname: x\n---\nbody\n'
    const out = stamp(input)
    expect(out).toBe(`---\nshuvix: agent v1\nshuvix-id: ${U}\nname: x\n---\nbody\n`)
    expect(out.replace(`shuvix-id: ${U}\n`, '')).toBe(input)
  })

  it('MM-23 标记不在第一行 → 紧跟在标记行之后', () => {
    expect(stamp('---\nname: x\nshuvix: agent v1\ndescription: d\n---\n')).toBe(
      `---\nname: x\nshuvix: agent v1\nshuvix-id: ${U}\ndescription: d\n---\n`
    )
  })

  it('MM-24 没有标记 → frontmatter 第一行（排在开头的注释行之前）', () => {
    expect(stamp('---\n# comment\nname: x\n---\n')).toBe(
      `---\nshuvix-id: ${U}\n# comment\nname: x\n---\n`
    )
  })

  it('MM-25 shuvix-* 键不是标记；`shuvix : agent v1`（冒号前有空格）是', () => {
    expect(stamp('---\nshuvix-tools: read\nshuvix-builtin: true\nname: x\n---\n')).toBe(
      `---\nshuvix-id: ${U}\nshuvix-tools: read\nshuvix-builtin: true\nname: x\n---\n`
    )
    expect(stamp('---\nname: x\nshuvix : agent v1\ndescription: d\n---\n')).toBe(
      `---\nname: x\nshuvix : agent v1\nshuvix-id: ${U}\ndescription: d\n---\n`
    )
  })

  it('MM-26 带引号的标记键不认 → 落在第一行；结果仍可解析且两个键都在', () => {
    const out = stamp('---\nname: x\n"shuvix": agent v1\n---\n')
    expect(out).toBe(`---\nshuvix-id: ${U}\nname: x\n"shuvix": agent v1\n---\n`)
    expect(frontmatter(out)).toEqual({ 'shuvix-id': U, name: 'x', shuvix: 'agent v1' })
  })

  it('MM-27 标记行带行尾注释 → 插在它之后，注释原样', () => {
    expect(stamp('---\nshuvix: agent v1 # marker\nname: x\n---\n')).toBe(
      `---\nshuvix: agent v1 # marker\nshuvix-id: ${U}\nname: x\n---\n`
    )
  })
})

describe('MM-28…33 setShuvixIdLine —— frontmatter 形状与 null', () => {
  it('MM-28 空 frontmatter → 一行 id', () => {
    expect(stamp('---\n---\nbody')).toBe(`---\nshuvix-id: ${U}\n---\nbody`)
  })

  it('MM-29 CRLF 文件：新行以 \\r\\n 结尾，没有落单的 \\n，其余字节不变', () => {
    const input = '---\r\nshuvix: agent v1\r\nname: x\r\n---\r\nbody\r\n'
    const out = stamp(input)
    expect(out).toBe(`---\r\nshuvix: agent v1\r\nshuvix-id: ${U}\r\nname: x\r\n---\r\nbody\r\n`)
    expect(/(?<!\r)\n/.test(out)).toBe(false)
    expect(out.replace(`shuvix-id: ${U}\r\n`, '')).toBe(input)
  })

  it('MM-30 换行符取开头那条定界线的', () => {
    expect(stamp('---\r\nname: x\n---\n')).toBe(`---\r\nshuvix-id: ${U}\r\nname: x\n---\n`)
    expect(stamp('---\nname: x\r\n---\n')).toBe(`---\nshuvix-id: ${U}\nname: x\r\n---\n`)
  })

  it('MM-31 BOM 与前导空行逐字节保留；id 读得回来', () => {
    const input = '\uFEFF\n\n---\nname: x\n---\nbody'
    const out = stamp(input)
    expect(out).toBe(`\uFEFF\n\n---\nshuvix-id: ${U}\nname: x\n---\nbody`)
    expect(frontmatter(out)['shuvix-id']).toBe(U)
  })

  it('MM-32 文件末尾没有换行、闭合线带尾随空格都行；正文里的 --- 块与顶格的 shuvix-id 行不碰', () => {
    expect(stamp('---\nname: x\n---')).toBe(`---\nshuvix-id: ${U}\nname: x\n---`)
    expect(stamp('---\nname: x\n---   \nbody')).toBe(`---\nshuvix-id: ${U}\nname: x\n---   \nbody`)
    expect(stamp('---\nname: x\n---\nbody\n---\nshuvix-id: body\n---\n')).toBe(
      `---\nshuvix-id: ${U}\nname: x\n---\nbody\n---\nshuvix-id: body\n---\n`
    )
  })

  it.each([
    ['空文本', ''],
    ['纯文本', 'plain text'],
    ['frontmatter 不在开头', '# T\n---\nname: x\n---'],
    ['没有闭合线', '---\nname: x\n'],
    ['开头定界线带尾随空格', '--- \nname: x\n---\n'],
    ['开头是四条横线', '----\nname: x\n---\n'],
    ['整块 flow 映射', '---\n{name: x}\n---\n'],
    ['整块 flow 序列', '---\n[a, b]\n---\n'],
    ['整体缩进', '---\n  name: x\n  description: d\n---\n'],
    ['顶层是序列', '---\n- a\n---\n'],
    ['注释之后才是 flow 映射', '---\n# c\n\n{name: x}\n---\n']
  ])('MM-33 没法安全地只改一行 → null：%s', (_label, text) => {
    expect(setShuvixIdLine(text, U)).toBeNull()
  })
})

describe('MM-34…44 setShuvixIdLine —— 已有条目的替换', () => {
  it('MM-34 已有另一个合法 id → 原位换掉（哪怕不在标记之后）', () => {
    expect(stamp(`---\nshuvix: agent v1\nname: x\nshuvix-id: ${V}\ndescription: d\n---\n`)).toBe(
      `---\nshuvix: agent v1\nname: x\nshuvix-id: ${U}\ndescription: d\n---\n`
    )
  })

  it('MM-35 已是同一个 id → 输出与输入全等', () => {
    const input = `---\nshuvix: agent v1\nshuvix-id: ${U}\nname: x\n---\nbody\n`
    expect(setShuvixIdLine(input, U)).toBe(input)
  })

  it.each(['shuvix-id: nope', "shuvix-id: ''", 'shuvix-id:', 'shuvix-id: 123'])(
    'MM-36 写坏的值 `%s` → 原位换掉',
    (line) => {
      expect(stamp(`---\nshuvix: agent v1\nname: x\n${line}\ndescription: d\n---\n`)).toBe(
        `---\nshuvix: agent v1\nname: x\nshuvix-id: ${U}\ndescription: d\n---\n`
      )
    }
  )

  it.each(['"shuvix-id": x', "'shuvix-id': x", 'shuvix-id   :   x # c'])(
    'MM-37 键带引号 / 带空格 `%s` → 换掉而不是再插一行；解析后只有一个键，值是新 id',
    (line) => {
      const out = stamp(`---\nshuvix: agent v1\n${line}\nname: x\n---\n`)
      expect(out).toBe(`---\nshuvix: agent v1\nshuvix-id: ${U}\nname: x\n---\n`)
      const fm = frontmatter(out)
      expect(Object.keys(fm).filter((k) => k === 'shuvix-id')).toHaveLength(1)
      expect(fm['shuvix-id']).toBe(U)
    }
  )

  it.each([
    ['字面块标量 |', 'shuvix-id: |\n  abc\n  def\n'],
    ['折叠块标量 >-', 'shuvix-id: >-\n  abc\n'],
    ['跨行 flow 序列', 'shuvix-id: [a,\n  b]\n'],
    ['跨行双引号', 'shuvix-id: "a\n  b"\n'],
    ['缩进的块序列', 'shuvix-id:\n  - a\n  - b\n'],
    ['制表符缩进的续行', 'shuvix-id: [a,\n\tb]\n'],
    ['块里有只含空白的行', 'shuvix-id: |\n  abc\n   \n  def\n']
  ])('MM-38 续行一并换成一行：%s；下一个键原样', (_label, entry) => {
    const out = stamp(`---\nshuvix: agent v1\n${entry}name: x\n---\n`)
    expect(out).toBe(`---\nshuvix: agent v1\nshuvix-id: ${U}\nname: x\n---\n`)
    expect(frontmatter(out)).toEqual({ shuvix: 'agent v1', 'shuvix-id': U, name: 'x' })
  })

  it('MM-39 块标量中间夹着空行 → 空行之后的续行也属于它', () => {
    const out = stamp('---\nshuvix: agent v1\nshuvix-id: |\n  abc\n\n  def\nname: x\n---\n')
    expect(out).toBe(`---\nshuvix: agent v1\nshuvix-id: ${U}\nname: x\n---\n`)
    expect(frontmatter(out)).toEqual({ shuvix: 'agent v1', 'shuvix-id': U, name: 'x' })
  })

  it('MM-40 零缩进的序列项（`- a`）也是它的续行', () => {
    const out = stamp('---\nshuvix: agent v1\nshuvix-id:\n- a\n- b\nname: x\n---\n')
    expect(out).toBe(`---\nshuvix: agent v1\nshuvix-id: ${U}\nname: x\n---\n`)
    expect(frontmatter(out)).toEqual({ shuvix: 'agent v1', 'shuvix-id': U, name: 'x' })
  })

  it('MM-41 别的键块标量里缩进的 `shuvix-id:`、注释行里的 `# shuvix-id:` 都不是这个键 → 插在标记之后，原块不动', () => {
    expect(stamp('---\nshuvix: agent v1\ndescription: |\n  shuvix-id: fake\nname: x\n---\n')).toBe(
      `---\nshuvix: agent v1\nshuvix-id: ${U}\ndescription: |\n  shuvix-id: fake\nname: x\n---\n`
    )
    expect(stamp('---\nshuvix: agent v1\n# shuvix-id: x\nname: x\n---\n')).toBe(
      `---\nshuvix: agent v1\nshuvix-id: ${U}\n# shuvix-id: x\nname: x\n---\n`
    )
  })

  it('MM-41b 被换掉的条目后面的空行（条目之间的分隔）原样留着', () => {
    expect(stamp('---\nshuvix: agent v1\nshuvix-id: |\n  old\n\nname: x\n---\n')).toBe(
      `---\nshuvix: agent v1\nshuvix-id: ${U}\n\nname: x\n---\n`
    )
    expect(stamp('---\nshuvix: agent v1\nshuvix-id: nope\n\nname: x\n---\n')).toBe(
      `---\nshuvix: agent v1\nshuvix-id: ${U}\n\nname: x\n---\n`
    )
    expect(stamp('---\nname: x\nshuvix-id: nope\n\n---\n')).toBe(
      `---\nname: x\nshuvix-id: ${U}\n\n---\n`
    )
  })

  it('MM-43 标记写成块标量 → 插在它的续行之后；标记仍是 agent v1，幂等', () => {
    const input = '---\nshuvix: >-\n  agent v1\nname: x\n---\n'
    const out = stamp(input)
    expect(out).toBe(`---\nshuvix: >-\n  agent v1\nshuvix-id: ${U}\nname: x\n---\n`)
    expect(frontmatter(out)).toEqual({ shuvix: 'agent v1', 'shuvix-id': U, name: 'x' })
    expect(setShuvixIdLine(out, U)).toBe(out)
  })
})

describe('MM-45…47 setShuvixIdLine —— 值的引号规则', () => {
  it('MM-45 UUID 与常规的内置 id 裸写', () => {
    expect(stamp('---\nname: x\n---\n', U)).toContain(`\nshuvix-id: ${U}\n`)
    expect(stamp('---\nname: x\n---\n', 'agent:builtin:explore')).toContain(
      '\nshuvix-id: agent:builtin:explore\n'
    )
    expect(stamp('---\nname: x\n---\n', 'hook:builtin:auto-title')).toContain(
      '\nshuvix-id: hook:builtin:auto-title\n'
    )
  })

  it.each([
    'agent:builtin:a b',
    'agent:builtin:中文',
    'agent:builtin:a#b',
    'agent:builtin:x: y',
    'agent:builtin:a"b\\c'
  ])('MM-46 需要引号的 id %j → JSON 双引号写出，YAML 逐字读回，仍是同一个合法 id', (id) => {
    const out = stamp('---\nname: x\n---\n', id)
    expect(out).toContain(`\nshuvix-id: ${JSON.stringify(id)}\n`)
    const readBack = frontmatter(out)['shuvix-id']
    expect(readBack).toBe(id)
    expect(parseObjectId(readBack)?.id).toBe(id)
  })

  it.each([
    'true',
    'null',
    '123',
    '0x1F',
    '1e3',
    '1.5',
    '0o17',
    'FALSE',
    'Null',
    'agent:builtin:x:'
  ])('MM-47 裸写会被 YAML 读成别的东西的 %j → 加引号，读回原样的字符串', (id) => {
    const out = stamp('---\nname: x\n---\n', id)
    expect(out).toContain(`\nshuvix-id: ${JSON.stringify(id)}\n`)
    expect(frontmatter(out)['shuvix-id']).toBe(id)
  })
})

describe('MM-48…49 setShuvixIdLine —— 幂等与保真', () => {
  const SHAPES: Array<[string, string]> = [
    ['标记在首行', '---\nshuvix: agent v1\nname: x\n---\nbody\n'],
    ['CRLF', '---\r\nshuvix: agent v1\r\nname: x\r\n---\r\nbody\r\n'],
    ['BOM + 前导空行', '\uFEFF\n---\nname: x\n---\nbody'],
    ['空 frontmatter', '---\n---\nbody'],
    ['标记在中间', '---\nname: x\nshuvix: agent v1\ndescription: d\n---\n'],
    ['带引号的旧 id 键', "---\nshuvix: agent v1\n'shuvix-id': nope\nname: x\n---\n"],
    ['旧 id 是块标量', '---\nshuvix: agent v1\nshuvix-id: |\n  a\n\n  b\nname: x\n---\n'],
    ['标记是块标量', '---\nshuvix: >-\n  agent v1\nname: x\n---\n'],
    ['没有闭合换行', '---\nname: x\n---']
  ]

  it.each(SHAPES)('MM-48 f(f(t, id), id) === f(t, id)：%s', (_label, text) => {
    for (const id of [U, 'agent:builtin:explore', 'agent:builtin:a b']) {
      const once = stamp(text, id)
      expect(setShuvixIdLine(once, id), `${id}`).toBe(once)
    }
  })

  it('MM-49 除那一行之外逐字节不变：注释、键序、其它键的引号风格、行尾注释、正文', () => {
    const input = [
      '---',
      '# 文件头注释',
      "description: 'single quoted: value'",
      'shuvix: agent v1   # 标记',
      'name: "double quoted"',
      'shuvix-tools: Read, grep # 行尾注释',
      'list:',
      '  - a',
      '  - b',
      'block: |',
      '  keep me',
      '',
      '  me too',
      'unknown-key: 1',
      '---',
      '',
      '# 正文标题',
      '',
      'shuvix-id: 正文里的这一行不是 frontmatter',
      ''
    ].join('\n')
    const out = stamp(input)
    expect(out.split('\n')[4]).toBe(`shuvix-id: ${U}`)
    expect(out.replace(`shuvix-id: ${U}\n`, '')).toBe(input)
  })
})
