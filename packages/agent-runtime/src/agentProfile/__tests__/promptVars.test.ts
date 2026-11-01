import { describe, it, expect, vi } from 'vitest'
import { renderProfileSystemPrompt, substitutePromptVars } from '../promptVars'

describe('substitutePromptVars', () => {
  it('标量替换：{{shuvix:name}} → 变量值', () => {
    expect(
      substitutePromptVars('Dir: {{shuvix:workingDirectory}} on {{shuvix:platform}}', {
        workingDirectory: '/w',
        platform: 'darwin'
      })
    ).toBe('Dir: /w on darwin')
  })

  it('空值块整体消失：空行收敛(\\n{3,} → \\n\\n)且首尾修剪', () => {
    const text = 'HEAD\n\n{{shuvix:blockA}}\n\n{{shuvix:blockB}}\n\n{{shuvix:blockC}}'
    expect(substitutePromptVars(text, { blockA: 'A-BLOCK', blockB: '', blockC: '' })).toBe(
      'HEAD\n\nA-BLOCK'
    )
    expect(substitutePromptVars(text, { blockA: '', blockB: 'B-BLOCK', blockC: 'C1\n\nC2' })).toBe(
      'HEAD\n\nB-BLOCK\n\nC1\n\nC2'
    )
  })

  it('未知占位符原样保留并 warn（typo 与宿主不支持的变量肉眼可见）', () => {
    const warn = vi.fn()
    const out = substitutePromptVars(
      'A {{shuvix:nope}} B',
      { known: 'x' },
      { info: vi.fn(), warn, error: vi.fn() }
    )
    expect(out).toBe('A {{shuvix:nope}} B')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('{{shuvix:nope}}'))
  })

  it('非 shuvix 命名空间的花括号不受影响（用户 prompt 里的 handlebars 示例等）', () => {
    const text = 'Use {{name}} and {{ shuvix:x }} and {{shuvix:}} literally'
    expect(substitutePromptVars(text, { x: 'X' })).toBe(text)
  })

  it('值本身含 {{shuvix:*}} 时不二次展开（replace 回调单遍语义）', () => {
    expect(substitutePromptVars('{{shuvix:a}}', { a: 'literal {{shuvix:b}}', b: 'NO' })).toBe(
      'literal {{shuvix:b}}'
    )
  })
})

/**
 * PV-EL：独占一行的占位符取值为空串时，**整行**（连同行尾换行）一起去掉 —— 自含块夹在列表项之间时
 * （环境清单里的「临时文件」行）只换成空串会在列表中间留一个空行，把一份清单切成两份。
 * 「独占一行」容许前后的空格 / 制表符；行内的占位符只去掉值本身；取值非空、未知占位符照旧。
 */
describe('substitutePromptVars —— 独占一行的空块连行去掉（PV-EL）', () => {
  it('PV-EL1 夹在两个列表项之间、取值为空：那一行消失，列表中间不留空行', () => {
    expect(substitutePromptVars('- a\n{{shuvix:x}}\n- b', { x: '' })).toBe('- a\n- b')
    // 前后带列表与段落时同样：清单仍是连着的
    expect(substitutePromptVars('## Env\n\n- a\n{{shuvix:x}}\n- b\n\nTail', { x: '' })).toBe(
      '## Env\n\n- a\n- b\n\nTail'
    )
  })

  it.each([
    ['前导空格', '- a\n  {{shuvix:x}}\n- b'],
    ['前导制表符', '- a\n\t{{shuvix:x}}\n- b'],
    ['尾随空格', '- a\n{{shuvix:x}}  \n- b'],
    ['前后都有空白', '- a\n \t{{shuvix:x}}\t \n- b']
  ])('PV-EL2 %s仍算独占一行：整行去掉', (_label, text) => {
    expect(substitutePromptVars(text, { x: '' })).toBe('- a\n- b')
  })

  it('PV-EL3 CRLF 行尾：整行连同 \\r\\n 去掉，其余行的 CRLF 原样', () => {
    expect(substitutePromptVars('- a\r\n{{shuvix:x}}\r\n- b', { x: '' })).toBe('- a\r\n- b')
  })

  it('PV-EL4 在文本最后一行（没有行尾换行）：去掉后不留尾巴', () => {
    expect(substitutePromptVars('- a\n- b\n{{shuvix:x}}', { x: '' })).toBe('- a\n- b')
    // 文本只有这一行
    expect(substitutePromptVars('{{shuvix:x}}', { x: '' })).toBe('')
  })

  it('PV-EL5 连着两行都是空块：两行都去掉', () => {
    expect(substitutePromptVars('- a\n{{shuvix:x}}\n{{shuvix:y}}\n- b', { x: '', y: '' })).toBe(
      '- a\n- b'
    )
  })

  it('PV-EL6 独占一行但取值非空：照常替换，行留着', () => {
    expect(substitutePromptVars('- a\n{{shuvix:x}}\n- b', { x: '- X' })).toBe('- a\n- X\n- b')
    // 前导空白随行保留（只有空值才连行去掉）
    expect(substitutePromptVars('- a\n  {{shuvix:x}}\n- b', { x: 'X' })).toBe('- a\n  X\n- b')
  })

  it('PV-EL7 独占一行的未知占位符：原样保留并 warn（不因为「独占一行」被当成空块去掉）', () => {
    const warn = vi.fn()
    const out = substitutePromptVars(
      '- a\n{{shuvix:nope}}\n- b',
      { other: '' },
      { info: vi.fn(), warn, error: vi.fn() }
    )
    expect(out).toBe('- a\n{{shuvix:nope}}\n- b')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('{{shuvix:nope}}'))
  })

  it('PV-EL8 行内的占位符取值为空：只去掉值，行和两边的空格都留着', () => {
    expect(substitutePromptVars('a {{shuvix:x}} b', { x: '' })).toBe('a  b')
    expect(substitutePromptVars('- a\n- dir: {{shuvix:x}}\n- b', { x: '' })).toBe(
      '- a\n- dir: \n- b'
    )
  })

  it('PV-EL9 段落之间（前后是空行）的空块：结果与从前一样 —— 空行收敛成一个', () => {
    expect(substitutePromptVars('A\n\n{{shuvix:x}}\n\nB', { x: '' })).toBe('A\n\nB')
    expect(substitutePromptVars('A\n\n  {{shuvix:x}}\n\nB', { x: '' })).toBe('A\n\nB')
  })
})

describe('renderProfileSystemPrompt', () => {
  it('md 正文即完整系统提示，经变量表替换', () => {
    expect(
      renderProfileSystemPrompt({ systemPrompt: 'BASE\n\n{{shuvix:env}}' }, { env: 'ENV' })
    ).toBe('BASE\n\nENV')
  })

  it('无占位符的正文原样直出（派生 agent 现状）', () => {
    expect(renderProfileSystemPrompt({ systemPrompt: '  BODY  ' }, {})).toBe('BODY')
  })
})
