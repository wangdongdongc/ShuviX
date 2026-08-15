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
