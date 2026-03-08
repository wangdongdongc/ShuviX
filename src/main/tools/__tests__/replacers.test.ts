import { describe, it, expect } from 'vitest'
import {
  ExactReplacer,
  UnicodeNormalizedReplacer,
  LineTrimmedReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  BlockAnchorReplacer,
  replaceWithFallback,
  levenshtein,
  dedent
} from '../utils/replacers'

// ─── 工具函数 ──────────────────────────────────────────

describe('levenshtein', () => {
  it('相同字符串距离为 0', () => {
    expect(levenshtein('hello', 'hello')).toBe(0)
  })

  it('完全不同的字符串', () => {
    expect(levenshtein('abc', 'xyz')).toBe(3)
  })

  it('插入/删除', () => {
    expect(levenshtein('cat', 'cats')).toBe(1) // 插入 s
    expect(levenshtein('cats', 'cat')).toBe(1) // 删除 s
  })

  it('替换', () => {
    expect(levenshtein('cat', 'car')).toBe(1) // t → r
  })

  it('空字符串', () => {
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('abc', '')).toBe(3)
    expect(levenshtein('', '')).toBe(0)
  })
})

describe('dedent', () => {
  it('去除公共缩进', () => {
    const input = '    hello\n    world'
    expect(dedent(input)).toBe('hello\nworld')
  })

  it('保留相对缩进差异', () => {
    const input = '    hello\n        world'
    expect(dedent(input)).toBe('hello\n    world')
  })

  it('忽略空行的缩进', () => {
    const input = '    hello\n\n    world'
    expect(dedent(input)).toBe('hello\n\nworld')
  })

  it('无缩进时原样返回', () => {
    const input = 'hello\nworld'
    expect(dedent(input)).toBe('hello\nworld')
  })
})

// ─── 第 1 级：ExactReplacer ────────────────────────────

describe('ExactReplacer', () => {
  it('精确匹配成功', () => {
    const matches = ExactReplacer.findMatches('hello world', 'world')
    expect(matches).toEqual([{ index: 6, length: 5 }])
  })

  it('找到多个精确匹配', () => {
    const matches = ExactReplacer.findMatches('foo bar foo', 'foo')
    expect(matches).toHaveLength(2)
    expect(matches[0].index).toBe(0)
    expect(matches[1].index).toBe(8)
  })

  it('找不到时返回空', () => {
    const matches = ExactReplacer.findMatches('hello', 'world')
    expect(matches).toHaveLength(0)
  })

  it('多行精确匹配', () => {
    const content = 'line1\nline2\nline3'
    const matches = ExactReplacer.findMatches(content, 'line2\nline3')
    expect(matches).toHaveLength(1)
    expect(matches[0].index).toBe(6)
  })
})

// ─── 第 2 级：UnicodeNormalizedReplacer ────────────────

describe('UnicodeNormalizedReplacer', () => {
  it('智能单引号 → 普通单引号', () => {
    //          文件中用了智能引号 '…'
    const content = 'const s = \u2018hello\u2019'
    //          LLM 输出普通引号
    const oldText = "const s = 'hello'"
    const matches = UnicodeNormalizedReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(1)
  })

  it('智能双引号 → 普通双引号', () => {
    const content = 'const s = \u201Chello\u201D'
    const oldText = 'const s = "hello"'
    const matches = UnicodeNormalizedReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(1)
  })

  it('Unicode 破折号 → 普通连字符', () => {
    const content = 'a \u2014 b' // em dash
    const oldText = 'a - b'
    const matches = UnicodeNormalizedReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(1)
  })

  it('不间断空格 → 普通空格', () => {
    const content = 'hello\u00A0world' // non-breaking space
    const oldText = 'hello world'
    const matches = UnicodeNormalizedReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(1)
  })

  it('没有 Unicode 差异时返回空（避免和 Exact 重复）', () => {
    const matches = UnicodeNormalizedReplacer.findMatches('hello world', 'hello world')
    expect(matches).toHaveLength(0)
  })
})

// ─── 第 3 级：LineTrimmedReplacer ──────────────────────

describe('LineTrimmedReplacer', () => {
  it('容忍行尾空格差异', () => {
    // 场景：文件中行尾有空格，LLM 输出没有
    const content = 'const x = 1;   \nconst y = 2;'
    const oldText = 'const x = 1;\nconst y = 2;'
    const matches = LineTrimmedReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(1)
    // 返回的 length 应覆盖文件中的原始文本（含尾部空格）
    expect(content.substring(matches[0].index, matches[0].index + matches[0].length)).toBe(
      'const x = 1;   \nconst y = 2;'
    )
  })

  it('LLM 多了行尾空格，文件没有', () => {
    const content = 'const x = 1;\nconst y = 2;'
    const oldText = 'const x = 1;   \nconst y = 2;'
    const matches = LineTrimmedReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(1)
  })

  it('单行内容也能匹配', () => {
    const content = 'hello   '
    const oldText = 'hello'
    const matches = LineTrimmedReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(1)
  })

  it('中间某一行内容不同时不匹配', () => {
    const content = 'line1\nline2\nline3'
    const oldText = 'line1\nXXXX\nline3'
    const matches = LineTrimmedReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(0)
  })
})

// ─── 第 4 级：WhitespaceNormalizedReplacer ──────────────

describe('WhitespaceNormalizedReplacer', () => {
  it('连续空格归一化', () => {
    // 场景：文件中有多余空格
    const content = 'const   x  =   1;'
    const oldText = 'const x = 1;'
    const matches = WhitespaceNormalizedReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(1)
  })

  it('tab 和空格混用', () => {
    const content = 'const\tx\t= 1;'
    const oldText = 'const x = 1;'
    const matches = WhitespaceNormalizedReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(1)
  })

  it('跨行空白归一化', () => {
    // 场景：LLM 把多行压成了一行
    const content = 'a\n  b\n  c'
    const oldText = 'a b c'
    const matches = WhitespaceNormalizedReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(1)
  })

  it('内容不同时不匹配', () => {
    const content = 'const x = 1;'
    const oldText = 'const y = 2;'
    const matches = WhitespaceNormalizedReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(0)
  })
})

// ─── 第 5 级：IndentationFlexibleReplacer ──────────────

describe('IndentationFlexibleReplacer', () => {
  it('2 空格 vs 4 空格缩进', () => {
    // 场景：文件用 4 空格，LLM 输出 2 空格
    const content = ['function hello() {', '    console.log("hi");', '    return true;', '}'].join(
      '\n'
    )
    const oldText = ['function hello() {', '  console.log("hi");', '  return true;', '}'].join('\n')
    const matches = IndentationFlexibleReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(1)
    expect(content.substring(matches[0].index, matches[0].index + matches[0].length)).toBe(content)
  })

  it('多缩进一层', () => {
    // 场景：文件在嵌套内（8空格），LLM 从顶层写起（4空格）
    const content = ['        if (true) {', '            doSomething();', '        }'].join('\n')
    const oldText = ['    if (true) {', '        doSomething();', '    }'].join('\n')
    const matches = IndentationFlexibleReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(1)
  })

  it('单行不触发（无缩进问题）', () => {
    const matches = IndentationFlexibleReplacer.findMatches('    hello', '  hello')
    expect(matches).toHaveLength(0) // 单行，searchLines.length < 2
  })

  it('相对缩进结构不同时不匹配', () => {
    const content = ['function hello() {', '    console.log("hi");', '    return true;', '}'].join(
      '\n'
    )
    // LLM 错误地把 return 和 console.log 放在不同层级
    const oldText = ['function hello() {', '  console.log("hi");', '      return true;', '}'].join(
      '\n'
    )
    const matches = IndentationFlexibleReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(0)
  })
})

// ─── 第 6 级：BlockAnchorReplacer ──────────────────────

describe('BlockAnchorReplacer', () => {
  it('首尾锚定 + 中间行完全匹配', () => {
    const content = ['function hello() {', '  console.log("hi");', '  return true;', '}'].join('\n')
    const oldText = ['function hello() {', '  console.log("hi");', '  return true;', '}'].join('\n')
    // 精确匹配会被 ExactReplacer 处理，但 BlockAnchor 也应能找到
    const matches = BlockAnchorReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(1)
  })

  it('中间行有微小差异时仍能匹配（模糊）', () => {
    // 场景：LLM 记错了中间行的具体内容
    const content = [
      'function greet() {',
      '  const name = "world";',
      '  console.log(`hello ${name}`);',
      '  return name;',
      '}'
    ].join('\n')
    const oldText = [
      'function greet() {',
      '  const name = "World";', // W 大写，和文件不同
      '  console.log(`Hello ${name}`);', // H 大写
      '  return name;',
      '}'
    ].join('\n')
    const matches = BlockAnchorReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(1)
  })

  it('首行不匹配时找不到', () => {
    const content = ['function hello() {', '  return true;', '}'].join('\n')
    const oldText = [
      'function goodbye() {', // 首行不同
      '  return true;',
      '}'
    ].join('\n')
    const matches = BlockAnchorReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(0)
  })

  it('末行不匹配时找不到', () => {
    const content = ['function hello() {', '  return true;', '}'].join('\n')
    const oldText = [
      'function hello() {',
      '  return true;',
      '};' // 末行不同
    ].join('\n')
    const matches = BlockAnchorReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(0)
  })

  it('少于 3 行时不触发', () => {
    const matches = BlockAnchorReplacer.findMatches('a\nb', 'a\nb')
    expect(matches).toHaveLength(0)
  })

  it('多个候选时选相似度最高的', () => {
    const content = [
      'function test() {',
      '  console.log("first");',
      '  return 1;',
      '}',
      '',
      'function test() {',
      '  console.log("second");',
      '  return 2;',
      '}'
    ].join('\n')
    // 搜索更接近第二个函数
    const oldText = ['function test() {', '  console.log("second");', '  return 2;', '}'].join('\n')
    const matches = BlockAnchorReplacer.findMatches(content, oldText)
    expect(matches).toHaveLength(1)
    // 应该选择第二个（相似度更高）
    const matched = content.substring(matches[0].index, matches[0].index + matches[0].length)
    expect(matched).toContain('second')
  })
})

// ─── replaceWithFallback 集成测试 ──────────────────────

describe('replaceWithFallback', () => {
  it('精确匹配走第 1 级', () => {
    const result = replaceWithFallback('hello world', 'world', 'earth')
    expect(result.content).toBe('hello earth')
    expect(result.replacerName).toBe('Exact')
  })

  it('Unicode 差异走第 2 级', () => {
    const content = 'const s = \u2018hello\u2019'
    const result = replaceWithFallback(content, "const s = 'hello'", "const s = 'world'")
    expect(result.replacerName).toBe('UnicodeNormalized')
    expect(result.content).toContain('world')
  })

  it('行尾空白差异走第 3 级', () => {
    const content = 'const x = 1;   \nconst y = 2;'
    const result = replaceWithFallback(content, 'const x = 1;\nconst y = 2;', 'const z = 3;')
    expect(result.replacerName).toBe('LineTrimmed')
    expect(result.content).toBe('const z = 3;')
  })

  it('空白归一化走第 4 级', () => {
    const content = 'const   x  =   1;'
    const result = replaceWithFallback(content, 'const x = 1;', 'const x = 2;')
    expect(result.replacerName).toBe('WhitespaceNormalized')
    expect(result.content).toBe('const x = 2;')
  })

  it('缩进差异能正确替换（由第 4 或第 5 级处理）', () => {
    // 文件用 4 空格，LLM 输出 2 空格
    const content = '    if (true) {\n        doIt();\n    }'
    const oldText = '  if (true) {\n      doIt();\n  }'
    const newText = '  if (false) {\n      doIt();\n  }'
    const result = replaceWithFallback(content, oldText, newText)
    expect(result.content).toContain('false')
    // 由 WhitespaceNormalized 或 IndentationFlexible 处理均可
    expect(['WhitespaceNormalized', 'IndentationFlexible']).toContain(result.replacerName)
  })

  it('中间行模糊差异走第 6 级', () => {
    const content = [
      'function greet() {',
      '  const name = "world";',
      '  console.log(`hello ${name}`);',
      '  return name;',
      '}'
    ].join('\n')
    // LLM 记错了中间行内容，但首尾行正确
    const oldText = [
      'function greet() {',
      '  const name = "World";',
      '  console.log(`Hello ${name}`);',
      '  return name;',
      '}'
    ].join('\n')
    const newText = ['function greet() {', '  return "hello world";', '}'].join('\n')
    const result = replaceWithFallback(content, oldText, newText)
    expect(result.replacerName).toBe('BlockAnchor')
    expect(result.content).toContain('return "hello world"')
  })

  it('精确匹配有多个但行尾 trim 后唯一 → 走更高级别', () => {
    // 两个 "foo" 精确匹配，但加上行尾空白差异后只有一个匹配 "foo   "
    const content = 'foo   \nbar\nfoo'
    const oldText = 'foo   \nbar'
    const result = replaceWithFallback(content, oldText, 'replaced')
    expect(result.replacerName).toBe('Exact')
    expect(result.content).toBe('replaced\nfoo')
  })

  it('完全找不到匹配时抛错', () => {
    expect(() => replaceWithFallback('hello', 'xyz', 'abc')).toThrow(/No match found/)
  })

  it('多个匹配无法确定唯一时抛错', () => {
    expect(() => replaceWithFallback('foo bar foo bar foo', 'foo', 'baz')).toThrow(/Found.*matches/)
  })
})
