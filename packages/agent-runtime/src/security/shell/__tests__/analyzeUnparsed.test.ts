/**
 * 未解析态与 span 级判定。
 *
 * 本文件存在的理由是一条极易写错的性质：**空集在全称判断下恒真**。
 * `facts.literalCommands.every(危险?)` 对空数组返回 true，于是 parsed=false 时
 * 「没抽到任何危险命令」会被读成「这条命令安全」而静默放行。U4 把这个后果焊进套件。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { analyzeShellCommand, initShellParser, spanIntersectsError } from '../index'
import type { ShellFacts, ShellSpan } from '../index'
import { loadShellParserWasmFromNodeModules } from '../nodeWasm'

beforeAll(async () => {
  await initShellParser(loadShellParserWasmFromNodeModules())
})

/** 只有 errorSpans 有意义的最小 facts —— spanIntersectsError 只读这一个字段 */
function factsWith(errorSpans: ShellSpan[]): ShellFacts {
  return {
    source: '',
    parsed: false,
    reason: 'syntax-error',
    errorSpans,
    wordOnly: false,
    wordOnlyCommands: [],
    literalCommands: [],
    dynamics: [],
    redirects: [],
    depthExceeded: false
  }
}

describe('未解析态', () => {
  it('U1 超长命令：整体是空壳，reason=too-long', () => {
    const source = 'e'.repeat(10_001)
    // 整对象断言：字段形状本身就是契约，漏清任何一个都会给上层假事实
    expect(analyzeShellCommand(source)).toEqual({
      source,
      parsed: false,
      reason: 'too-long',
      errorSpans: [],
      wordOnly: false,
      wordOnlyCommands: [],
      literalCommands: [],
      dynamics: [],
      redirects: [],
      depthExceeded: false
    })
  })

  it('U2 长度闸门是 `>` 而不是 `>=`', () => {
    expect(analyzeShellCommand('e'.repeat(10_000)).parsed).toBe(true)
  })

  it('U3 语法错时宽松轨照给，与 U1 的空壳形成对照', () => {
    const facts = analyzeShellCommand('echo "unterminated')
    expect(facts.parsed).toBe(false)
    expect(facts.reason).toBe('syntax-error')
    expect(facts.errorSpans).toEqual([{ start: 5, end: 18 }])
    // 语法错 ≠ 什么都没看懂：能抽的照抽，它只用于发现危险，多给不少给
    expect(facts.literalCommands.map((c) => c.base)).toContain('echo')
  })

  it('U4 空集陷阱：parsed=false 时 every() 恒真，调用方必须先看 parsed', () => {
    const facts = analyzeShellCommand('e'.repeat(10_001))
    // 下面这句「所有命令都叫 definitely-not-this」显然荒谬，却返回 true ——
    // 任何形如 literalCommands.every(...) 的放行判据都必须先 guard 住 parsed
    expect(facts.literalCommands.every((c) => c.base === 'definitely-not-this')).toBe(true)
    expect(facts.wordOnly).toBe(false)
  })

  it('U5 各类语法错都判否；MISSING 是零宽区间', () => {
    for (const src of ['ls |', 'if true', 'echo )(', 'ls;;;']) {
      const facts = analyzeShellCommand(src)
      expect(facts.reason, src).toBe('syntax-error')
      expect(facts.wordOnly, src).toBe(false)
    }
    const missing = analyzeShellCommand('ls |')
    expect(missing.errorSpans).toEqual([{ start: 4, end: 4 }])
    // 快照：错误树里会抽出一条 base 为空串的幽灵命令（管道右侧缺失的那条）
    expect(missing.literalCommands.map((c) => c.base)).toContain('')
  })
})

describe('spanIntersectsError — span 级 fail-safe', () => {
  it('U6 没有错误区间时任何 target 都不相交', () => {
    const facts = factsWith([])
    expect(spanIntersectsError(facts, { start: 0, end: 100 })).toBe(false)
    expect(spanIntersectsError(facts, { start: 0, end: 0 })).toBe(false)
  })

  it('U7 六种位置关系', () => {
    const facts = factsWith([{ start: 5, end: 18 }])
    expect(spanIntersectsError(facts, { start: 0, end: 5 })).toBe(false) // 左相邻
    expect(spanIntersectsError(facts, { start: 18, end: 20 })).toBe(false) // 右相邻
    expect(spanIntersectsError(facts, { start: 3, end: 7 })).toBe(true) // 部分重叠
    expect(spanIntersectsError(facts, { start: 0, end: 20 })).toBe(true) // target 包含 error
    expect(spanIntersectsError(facts, { start: 6, end: 7 })).toBe(true) // 被 error 包含
    expect(spanIntersectsError(facts, { start: 5, end: 18 })).toBe(true) // 完全相同
  })

  it('U8 零宽 MISSING 区间的边界现状', () => {
    const facts = factsWith([{ start: 4, end: 4 }])
    expect(spanIntersectsError(facts, { start: 0, end: 10 })).toBe(true)
    // 零宽错误恰好落在关心区间起点时判**不**相交（target.start < e.end 不成立）——
    // 钉住现状：这是半开区间语义的必然结果，改它要连带改所有相邻判定
    expect(spanIntersectsError(facts, { start: 4, end: 10 })).toBe(false)
    expect(spanIntersectsError(facts, { start: 4, end: 4 })).toBe(false)
  })

  it('U9 多个错误区间任一相交即真', () => {
    const facts = factsWith([
      { start: 0, end: 2 },
      { start: 50, end: 60 }
    ])
    expect(spanIntersectsError(facts, { start: 55, end: 58 })).toBe(true)
  })

  it('U10 真实联动：错误落在关心的那段上才 fail-safe', () => {
    // 整棵树 hasError 就全盘判「不确定」过于粗暴，真正该 fail-safe 的是
    // **检测所依赖的那一段**落在错误区间里的情况
    const broken = analyzeShellCommand('ls;;;')
    expect(spanIntersectsError(broken, { start: 0, end: 2 })).toBe(true)
    const partial = analyzeShellCommand('echo "unterminated')
    expect(spanIntersectsError(partial, { start: 0, end: 4 })).toBe(false)
  })
})
