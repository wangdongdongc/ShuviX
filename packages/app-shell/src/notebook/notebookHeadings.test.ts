/**
 * 笔记本右侧目录的纯逻辑（notebookHeadings.ts）—— 三个函数各一组：
 *
 *   - `parseHeadings`：从 markdown 原文解析 ATX 标题。行号是**原文按 `\n` 切分的 1-based 行号**
 *     （直接喂给 CM6 `doc.line()`，所以 frontmatter 的行也算数），跳过开头的 frontmatter 与围栏代码块，
 *     判定规则与编辑器的渲染一致（CommonMark 的 ATX 标题 / 围栏；frontmatter 与属性卡的
 *     `findFrontmatter` 同一判定）。
 *   - `activeHeadingIndex`：当前章节 = 行号不超过探针行的最后一个标题；探针在第一个标题之前为 -1。
 *   - `relativeLevels`：文档里最高的一级记为 0，其余按差值（级差保留，不压缩）。
 */
import { describe, expect, it } from 'vitest'
import {
  activeHeadingIndex,
  parseHeadings,
  relativeLevels,
  type NotebookHeading
} from './notebookHeadings'

/** 只看 [level, text, line] —— 断言读起来像一张表 */
const shape = (md: string): [number, string, number][] =>
  parseHeadings(md).map((h) => [h.level, h.text, h.line])

/** 只看文本 */
const texts = (md: string): string[] => parseHeadings(md).map((h) => h.text)

const h = (level: number, line: number, text = `h${line}`): NotebookHeading => ({
  level,
  text,
  line
})

describe('parseHeadings', () => {
  it('P1 一到六级、1-based 行号、文档序；标题之间夹正文与空行', () => {
    const md = [
      '# One', // 1
      '', // 2
      'body text', // 3
      '## Two', // 4
      'more body', // 5
      '', // 6
      '### Three', // 7
      '#### Four', // 8
      '', // 9
      '##### Five', // 10
      'x', // 11
      '###### Six' // 12
    ].join('\n')
    expect(shape(md)).toEqual([
      [1, 'One', 1],
      [2, 'Two', 4],
      [3, 'Three', 7],
      [4, 'Four', 8],
      [5, 'Five', 10],
      [6, 'Six', 12]
    ])
  })

  it('P2 不是标题：七个 #、# 后没有空白、只有 #、# 加一个空格', () => {
    for (const line of ['####### x', '#text', '#', '# ', '##', '## ']) {
      expect(parseHeadings(line), JSON.stringify(line)).toEqual([])
    }
    // 放在一篇文档里也一样（不是「单行输入」的巧合）
    expect(parseHeadings(['####### x', '#text', '#', '# ', 'para'].join('\n'))).toEqual([])
  })

  it('P3 # 后用制表符分隔也算', () => {
    expect(shape('#\tTabbed')).toEqual([[1, 'Tabbed', 1]])
    expect(shape('###\tDeep tab')).toEqual([[3, 'Deep tab', 1]])
  })

  it('P4 文本清理：去收尾的 # 串、去两端空白；正文里的 # 保留', () => {
    expect(texts('# Title ##')).toEqual(['Title'])
    expect(texts('## Closed #')).toEqual(['Closed'])
    expect(texts('##   spaced out   ')).toEqual(['spaced out'])
    expect(texts('## a # b')).toEqual(['a # b'])
    expect(texts('## Issue #42')).toEqual(['Issue #42'])
  })

  it('P5 围栏：``` 与 ~~~ 里的行都不算，闭合后恢复解析', () => {
    const md = [
      '# Before', // 1
      '```', // 2
      '# in backticks', // 3
      '```', // 4
      '## Between', // 5
      '~~~', // 6
      '# in tildes', // 7
      '~~~', // 8
      '### After' // 9
    ].join('\n')
    expect(shape(md)).toEqual([
      [1, 'Before', 1],
      [2, 'Between', 5],
      [3, 'After', 9]
    ])
  })

  it('P5 带信息串的 ```js 开围栏', () => {
    const md = ['```js', '# comment in js', '```', '# Real'].join('\n')
    expect(shape(md)).toEqual([[1, 'Real', 4]])
  })

  it('P5 反引号围栏里的 ~~~ 不关它', () => {
    const md = ['```', '~~~', '# still code', '```', '# Out'].join('\n')
    expect(shape(md)).toEqual([[1, 'Out', 5]])
    // 反过来也一样：波浪线围栏里的 ``` 不关它
    const md2 = ['~~~', '```', '# still code', '~~~', '# Out2'].join('\n')
    expect(shape(md2)).toEqual([[1, 'Out2', 5]])
  })

  it('P5 没闭合的围栏吞掉其后全部', () => {
    const md = ['# Kept', '```', '# swallowed', '## swallowed too', 'text'].join('\n')
    expect(shape(md)).toEqual([[1, 'Kept', 1]])
  })

  it('P5 缩进的开围栏（列表里）照样开', () => {
    const md = ['- item', '  ```', '  # code in list', '  ```', '## After list'].join('\n')
    expect(shape(md)).toEqual([[2, 'After list', 5]])
  })

  it('P6 CRLF 与 LF 同样的级别与行号，文本里没有 \\r', () => {
    const crlf = parseHeadings('# A\r\n## B\r\n')
    const lf = parseHeadings('# A\n## B\n')
    expect(crlf).toEqual(lf)
    expect(crlf.map((x) => [x.level, x.text, x.line])).toEqual([
      [1, 'A', 1],
      [2, 'B', 2]
    ])
    for (const x of crlf) expect(x.text.includes('\r')).toBe(false)
    // 带收尾 # 的 CRLF 行照样去干净
    expect(texts('## Closed ##\r\nbody\r\n')).toEqual(['Closed'])
  })

  it('P7 frontmatter 的行照样计入行号（行号喂给 CM6 doc.line）', () => {
    expect(shape('---\ntitle: x\n---\n# A')).toEqual([[1, 'A', 4]])
  })

  it('P8 空输入 / 没有标题 → []', () => {
    expect(parseHeadings('')).toEqual([])
    expect(parseHeadings('just a paragraph\n\nand another\n')).toEqual([])
    expect(parseHeadings('\n\n\n')).toEqual([])
  })

  it('P9 收尾 # 串前须有空白：`# Learn C#` 保留 C#', () => {
    expect(texts('# Learn C#')).toEqual(['Learn C#'])
    expect(texts('## F# and C# ##')).toEqual(['F# and C#'])
  })

  it('P10 四个反引号的围栏里套三个反引号的：里层的 ``` 关不掉外层', () => {
    const md = [
      '````md', // 1
      '```', // 2
      '# inner heading', // 3
      '```', // 4
      '# still inside the outer fence', // 5
      '````', // 6
      '## After outer' // 7
    ].join('\n')
    expect(shape(md)).toEqual([[2, 'After outer', 7]])
  })

  it('P10 带信息串的 ```js 行不关已开的 ``` 围栏（闭合线不带信息串）', () => {
    const md = ['```', '# code', '```js', '# still code', '```', '# Out'].join('\n')
    expect(shape(md)).toEqual([[1, 'Out', 6]])
  })

  it('P10 更短的闭合线不关更长的开围栏；同长或更长的才关', () => {
    const shorter = ['~~~~', '~~~', '# inside', '~~~~', '# Out'].join('\n')
    expect(shape(shorter)).toEqual([[1, 'Out', 5]])
    const longer = ['```', '# inside', '`````', '# Out'].join('\n')
    expect(shape(longer)).toEqual([[1, 'Out', 4]])
  })

  it('P11 frontmatter 被跳过：里面的 YAML 注释 `# …` 不是标题', () => {
    const md = ['---', '# not a heading', 'title: x', '---', '# Real'].join('\n')
    expect(shape(md)).toEqual([[1, 'Real', 5]])
  })

  it('P11 首行带 BOM 的 --- 也算 frontmatter；闭合线尾部空白可以', () => {
    const md = ['﻿---', '# yaml comment', '---   ', '## Body'].join('\n')
    expect(shape(md)).toEqual([[2, 'Body', 4]])
    const tabs = ['---', '# yaml comment', '---\t', '# Real'].join('\n')
    expect(shape(tabs)).toEqual([[1, 'Real', 4]])
  })

  it('P11 没闭合的 --- 不是 frontmatter：其后的 # x 是标题', () => {
    const md = ['---', 'title: x', '# x', 'body'].join('\n')
    expect(shape(md)).toEqual([[1, 'x', 3]])
  })

  it('P11 --- 不在第一行就不是 frontmatter', () => {
    const md = ['', '---', '# yaml-ish', '---', '# Real'].join('\n')
    expect(shape(md)).toEqual([
      [1, 'yaml-ish', 3],
      [1, 'Real', 5]
    ])
    const afterText = ['intro', '---', '# counted', '---'].join('\n')
    expect(texts(afterText)).toEqual(['counted'])
  })

  it('P11 闭合线须在前 200 行内（与属性卡 findFrontmatter 同一上限）', () => {
    // 第 200 行闭合：是 frontmatter，里面的注释不算
    const within = ['---', '# yaml comment', ...Array(197).fill('k: v'), '---', '# After']
    expect(within).toHaveLength(201)
    expect(within[199]).toBe('---')
    expect(shape(within.join('\n'))).toEqual([[1, 'After', 201]])
    // 第 201 行才闭合：不是 frontmatter —— 注释那行就是一个标题
    const beyond = ['---', '# yaml comment', ...Array(198).fill('k: v'), '---', '# After']
    expect(beyond[200]).toBe('---')
    expect(shape(beyond.join('\n'))).toEqual([
      [1, 'yaml comment', 2],
      [1, 'After', 202]
    ])
  })

  it('P12 一到三格缩进仍是标题；四格不是（那是缩进代码块）', () => {
    expect(shape(' # One space')).toEqual([[1, 'One space', 1]])
    expect(shape('   # Indented')).toEqual([[1, 'Indented', 1]])
    expect(shape('    # Code')).toEqual([])
    expect(shape('   ## Three\n    ## Four')).toEqual([[2, 'Three', 1]])
  })
})

describe('activeHeadingIndex', () => {
  const list = [h(2, 3), h(3, 10), h(2, 20), h(4, 21)]

  it('A1 空列表 → 恒为 -1', () => {
    for (const probe of [0, 1, 5, 100, Number.MAX_SAFE_INTEGER]) {
      expect(activeHeadingIndex([], probe)).toBe(-1)
    }
  })

  it('A2 探针为 0 / 在第一个标题之前 → -1', () => {
    expect(activeHeadingIndex(list, 0)).toBe(-1)
    expect(activeHeadingIndex(list, 1)).toBe(-1)
    expect(activeHeadingIndex(list, 2)).toBe(-1)
  })

  it('A3 探针正落在标题自己那一行 → 就是它（含端点）', () => {
    expect(activeHeadingIndex(list, 3)).toBe(0)
    expect(activeHeadingIndex(list, 10)).toBe(1)
    expect(activeHeadingIndex(list, 20)).toBe(2)
    expect(activeHeadingIndex(list, 21)).toBe(3)
  })

  it('A4 探针在第 i 与第 i+1 个标题之间 → i', () => {
    expect(activeHeadingIndex(list, 4)).toBe(0)
    expect(activeHeadingIndex(list, 9)).toBe(0)
    expect(activeHeadingIndex(list, 11)).toBe(1)
    expect(activeHeadingIndex(list, 19)).toBe(1)
  })

  it('A5 探针越过最后一个标题（含文档最后一行）→ 最后一个', () => {
    expect(activeHeadingIndex(list, 22)).toBe(3)
    expect(activeHeadingIndex(list, 500)).toBe(3)
    // 与真实解析结果配合：探针取文档行数（滚到底的规则）
    const md = '# A\ntext\n## B\ntext\ntext\n'
    const parsed = parseHeadings(md)
    const lastLine = md.split('\n').length
    expect(activeHeadingIndex(parsed, lastLine)).toBe(parsed.length - 1)
  })

  it('A6 只有一个标题：之前 -1，正在 / 之后 0', () => {
    const one = [h(1, 5)]
    expect(activeHeadingIndex(one, 4)).toBe(-1)
    expect(activeHeadingIndex(one, 5)).toBe(0)
    expect(activeHeadingIndex(one, 6)).toBe(0)
  })
})

describe('relativeLevels', () => {
  const levels = (ls: number[]): number[] => relativeLevels(ls.map((l, i) => h(l, i + 1)))

  it('R1 [2,3,4,2] → [0,1,2,0]', () => {
    expect(levels([2, 3, 4, 2])).toEqual([0, 1, 2, 0])
  })

  it('R2 从 H1 写起与从 H2 写起的同形文档 → 结果相同', () => {
    expect(levels([1, 2, 3, 2, 1])).toEqual(levels([2, 3, 4, 3, 2]))
    expect(levels([1, 2, 3, 2, 1])).toEqual([0, 1, 2, 1, 0])
  })

  it('R3 级差保留：[1,3] → [0,2]', () => {
    expect(levels([1, 3])).toEqual([0, 2])
    expect(levels([3, 5, 6])).toEqual([0, 2, 3])
  })

  it('R4 全同级 → 全 0', () => {
    expect(levels([3, 3, 3])).toEqual([0, 0, 0])
    expect(levels([6])).toEqual([0])
  })

  it('R5 空 → []', () => {
    expect(relativeLevels([])).toEqual([])
  })

  it('最高一级不在第一个也照样按它算', () => {
    expect(levels([3, 2, 4])).toEqual([1, 0, 2])
  })
})
